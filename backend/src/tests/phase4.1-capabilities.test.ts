import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../app";
import { db } from "../db/client";
import { eq, sql, or } from "drizzle-orm";
import {
  satelliteOrbitalData,
  users,
  satellites,
  groundStations,
  contactWindows,
  missionTasks,
  reservations,
} from "../db/schema";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";
import { env } from "../config/env";
import { constraintValidator } from "../modules/reservations/constraint-validator";

describe("Phase 4.1 - Ground-Station Hardware Capabilities & RF Compatibility", () => {
  let operatorToken: string;
  let viewerToken: string;

  let testSatId: string;
  let testOrbitalDataId: string;

  // Ground Stations
  let sBandOnlyStationId: string;    // bands: ['S_BAND'], maxContacts: 1, maxDataRate: 50.0
  let multiBandStationId: string;    // bands: ['S_BAND', 'X_BAND'], maxContacts: 2, maxDataRate: 200.0

  // Contact Windows
  let cwSbandId: string;
  let cwMultiBandId: string;
  let validAos: Date;
  let validLos: Date;

  // Tasks
  let sBandTask50MbpsId: string;     // band: 'S_BAND', minDataRate: 50.0, dur: 120s
  let xBandTask50MbpsId: string;     // band: 'X_BAND', minDataRate: 50.0, dur: 120s
  let highRateTask100MbpsId: string; // band: 'S_BAND', minDataRate: 100.0, dur: 120s

  beforeAll(async () => {
    // 1. Create auth tokens
    const [operator] = await db.insert(users).values({
      email: `op41_${Date.now()}@test.com`,
      passwordHash: await bcrypt.hash("password", 10),
      role: "OPERATOR",
    }).returning();
    operatorToken = jwt.sign({ sub: operator.id, role: operator.role }, env.jwtSecret, { expiresIn: "1h" });

    const [viewer] = await db.insert(users).values({
      email: `view41_${Date.now()}@test.com`,
      passwordHash: await bcrypt.hash("password", 10),
      role: "VIEWER",
    }).returning();
    viewerToken = jwt.sign({ sub: viewer.id, role: viewer.role }, env.jwtSecret, { expiresIn: "1h" });

    // 2. Base Satellite
    const [sat] = await db.insert(satellites).values({
      noradId: 44000 + (Date.now() % 10000),
      name: "CapabilityTestSat",
      type: "LEO",
      status: "ACTIVE",
    }).returning();
    testSatId = sat.id;

    // 3. Orbital Data
    const [od] = await db.insert(satelliteOrbitalData).values({
      satelliteId: sat.id,
      source: "CELESTRAK",
      tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
      tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
      tleEpoch: new Date(),
      receivedAt: new Date(),
    }).returning();
    testOrbitalDataId = od.id;

    // 4. Ground Stations with distinct capabilities
    // Station 1: S_BAND only, maxConcurrentContacts = 1, maxDataRate = 50.0 Mbps
    const [gsSband] = await db.insert(groundStations).values({
      code: `GS-S-ONLY-${Date.now() % 10000}`,
      name: "S-Band Single Channel",
      latitude: 13.0827,
      longitude: 80.2707,
      altitudeM: 10,
      minimumElevationDeg: 10,
      status: "AVAILABLE",
      supportedFrequencyBands: ["S_BAND"],
      maxConcurrentContacts: 1,
      maxDataRateMbps: 50.0,
    }).returning();
    sBandOnlyStationId = gsSband.id;

    // Station 2: S_BAND + X_BAND, maxConcurrentContacts = 2, maxDataRate = 200.0 Mbps
    const [gsMulti] = await db.insert(groundStations).values({
      code: `GS-MULTI-${Date.now() % 10000}`,
      name: "Multi-Band Dual Channel",
      latitude: 12.9716,
      longitude: 77.5946,
      altitudeM: 920,
      minimumElevationDeg: 5,
      status: "AVAILABLE",
      supportedFrequencyBands: ["S_BAND", "X_BAND"],
      maxConcurrentContacts: 2,
      maxDataRateMbps: 200.0,
    }).returning();
    multiBandStationId = gsMulti.id;

    // 5. Contact Windows
    const now = Date.now();
    validAos = new Date(now + 1000000);
    validLos = new Date(validAos.getTime() + 1800000); // 30 min window

    const [cw1] = await db.insert(contactWindows).values({
      satelliteId: sat.id,
      groundStationId: sBandOnlyStationId,
      orbitalDataId: od.id,
      aos: validAos,
      los: validLos,
      durationSeconds: 1800,
      maxElevationDeg: 45,
      status: "AVAILABLE",
    }).returning();
    cwSbandId = cw1.id;

    const [cw2] = await db.insert(contactWindows).values({
      satelliteId: sat.id,
      groundStationId: multiBandStationId,
      orbitalDataId: od.id,
      aos: validAos,
      los: validLos,
      durationSeconds: 1800,
      maxElevationDeg: 60,
      status: "AVAILABLE",
    }).returning();
    cwMultiBandId = cw2.id;

    // 6. Mission Tasks
    const deadline = new Date(validLos.getTime() + 3600000);

    const [taskS] = await db.insert(missionTasks).values({
      satelliteId: sat.id,
      name: "S-Band 50M Task",
      priority: 3,
      durationSeconds: 120,
      deadline,
      status: "PENDING",
      requiredFrequencyBand: "S_BAND",
      minDataRateMbps: 50.0,
    }).returning();
    sBandTask50MbpsId = taskS.id;

    const [taskX] = await db.insert(missionTasks).values({
      satelliteId: sat.id,
      name: "X-Band 50M Task",
      priority: 4,
      durationSeconds: 120,
      deadline,
      status: "PENDING",
      requiredFrequencyBand: "X_BAND",
      minDataRateMbps: 50.0,
    }).returning();
    xBandTask50MbpsId = taskX.id;

    const [taskHighRate] = await db.insert(missionTasks).values({
      satelliteId: sat.id,
      name: "S-Band 100M High Rate Task",
      priority: 5,
      durationSeconds: 120,
      deadline,
      status: "PENDING",
      requiredFrequencyBand: "S_BAND",
      minDataRateMbps: 100.0,
    }).returning();
    highRateTask100MbpsId = taskHighRate.id;
  });

  afterAll(async () => {
    await db.delete(reservations).where(or(
      eq(reservations.satelliteId, testSatId),
      eq(reservations.groundStationId, sBandOnlyStationId),
      eq(reservations.groundStationId, multiBandStationId)
    ));
    await db.delete(contactWindows).where(or(
      eq(contactWindows.satelliteId, testSatId),
      eq(contactWindows.groundStationId, sBandOnlyStationId),
      eq(contactWindows.groundStationId, multiBandStationId)
    ));
    await db.delete(missionTasks).where(eq(missionTasks.satelliteId, testSatId));
    await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, testSatId));
    await db.delete(satellites).where(eq(satellites.id, testSatId));
    await db.delete(groundStations).where(eq(groundStations.id, sBandOnlyStationId));
    await db.delete(groundStations).where(eq(groundStations.id, multiBandStationId));
  });

  describe("RF Frequency Band Validation", () => {
    it("1. S-band task on S-band station -> PASS", async () => {
      const result = await constraintValidator.validate({
        taskId: sBandTask50MbpsId,
        contactWindowId: cwSbandId,
        startTime: new Date(validAos.getTime() + 60000),
        endTime: new Date(validAos.getTime() + 180000),
      });

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it("2. X-band task on S-band-only station -> INCOMPATIBLE_FREQUENCY_BAND", async () => {
      const result = await constraintValidator.validate({
        taskId: xBandTask50MbpsId,
        contactWindowId: cwSbandId,
        startTime: new Date(validAos.getTime() + 60000),
        endTime: new Date(validAos.getTime() + 180000),
      });

      expect(result.valid).toBe(false);
      const bandErr = result.errors.find((e) => e.code === "INCOMPATIBLE_FREQUENCY_BAND");
      expect(bandErr).toBeDefined();
      expect(bandErr?.message).toContain("X_BAND");
    });

    it("3. X-band task on Multi-band (S+X) station -> PASS", async () => {
      const result = await constraintValidator.validate({
        taskId: xBandTask50MbpsId,
        contactWindowId: cwMultiBandId,
        startTime: new Date(validAos.getTime() + 60000),
        endTime: new Date(validAos.getTime() + 180000),
      });

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });
  });

  describe("Data Rate Capability Validation", () => {
    it("4. Task requires 100 Mbps on 50 Mbps max station -> INSUFFICIENT_STATION_DATA_RATE", async () => {
      const result = await constraintValidator.validate({
        taskId: highRateTask100MbpsId,
        contactWindowId: cwSbandId,
        startTime: new Date(validAos.getTime() + 60000),
        endTime: new Date(validAos.getTime() + 180000),
      });

      expect(result.valid).toBe(false);
      const rateErr = result.errors.find((e) => e.code === "INSUFFICIENT_STATION_DATA_RATE");
      expect(rateErr).toBeDefined();
      expect(rateErr?.message).toContain("100 Mbps");
    });

    it("5. Task requires 100 Mbps on 200 Mbps max station -> PASS", async () => {
      const result = await constraintValidator.validate({
        taskId: highRateTask100MbpsId,
        contactWindowId: cwMultiBandId,
        startTime: new Date(validAos.getTime() + 60000),
        endTime: new Date(validAos.getTime() + 180000),
      });

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });
  });

  describe("Channel Capacity (maxConcurrentContacts) Validation", () => {
    it("6. Station below capacity limit (1 active contact on capacity=2 station) -> PASS", async () => {
      const start = new Date(validAos.getTime() + 300000);
      const end = new Date(start.getTime() + 120000); // Exactly 120s matching taskDurationSeconds

      // Create a 2nd satellite to test multi-satellite simultaneous contact on same station
      const [sat2] = await db.insert(satellites).values({
        noradId: 45000 + (Date.now() % 10000),
        name: "Sat2Concurrent",
        type: "LEO",
        status: "ACTIVE",
      }).returning();

      const [odSat2] = await db.insert(satelliteOrbitalData).values({
        satelliteId: sat2.id,
        source: "CELESTRAK",
        tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
        tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      }).returning();

      const [cwSat2] = await db.insert(contactWindows).values({
        satelliteId: sat2.id,
        groundStationId: multiBandStationId,
        orbitalDataId: odSat2.id,
        aos: validAos,
        los: validLos,
        durationSeconds: 1800,
        maxElevationDeg: 50,
      }).returning();

      const [taskSat2] = await db.insert(missionTasks).values({
        satelliteId: sat2.id,
        name: "Sat2 Task",
        priority: 2,
        durationSeconds: 120,
        deadline: new Date(validLos.getTime() + 3600000),
        status: "PENDING",
      }).returning();

      // Insert first reservation on multiBandStationId (takes 1 of 2 channels)
      const [resv1] = await db.insert(reservations).values({
        missionTaskId: sBandTask50MbpsId,
        contactWindowId: cwMultiBandId,
        groundStationId: multiBandStationId,
        satelliteId: testSatId,
        windowAos: validAos,
        windowLos: validLos,
        taskDurationSeconds: 120,
        allocatedStart: start,
        allocatedEnd: end,
        status: "PENDING",
        source: "MANUAL",
      }).returning();

      // Validate second concurrent reservation on the other satellite
      const result = await constraintValidator.validate({
        taskId: taskSat2.id,
        contactWindowId: cwSat2.id,
        startTime: start,
        endTime: end,
      });

      // Since multiBandStationId has maxConcurrentContacts = 2, 1 contact is valid!
      expect(result.valid).toBe(true);

      // 7. Station at capacity limit (2 active contacts on capacity=2 station) -> GROUND_STATION_CAPACITY_EXCEEDED
      const [resv2] = await db.insert(reservations).values({
        missionTaskId: taskSat2.id,
        contactWindowId: cwSat2.id,
        groundStationId: multiBandStationId,
        satelliteId: sat2.id,
        windowAos: validAos,
        windowLos: validLos,
        taskDurationSeconds: 120,
        allocatedStart: start,
        allocatedEnd: end,
        status: "PENDING",
        source: "MANUAL",
      }).returning();

      // Attempt to schedule a 3rd concurrent contact
      const [sat3] = await db.insert(satellites).values({
        noradId: 46000 + (Date.now() % 10000),
        name: "Sat3Concurrent",
        type: "LEO",
        status: "ACTIVE",
      }).returning();

      const [odSat3] = await db.insert(satelliteOrbitalData).values({
        satelliteId: sat3.id,
        source: "CELESTRAK",
        tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
        tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      }).returning();

      const [cwSat3] = await db.insert(contactWindows).values({
        satelliteId: sat3.id,
        groundStationId: multiBandStationId,
        orbitalDataId: odSat3.id,
        aos: validAos,
        los: validLos,
        durationSeconds: 1800,
        maxElevationDeg: 50,
      }).returning();

      const [taskSat3] = await db.insert(missionTasks).values({
        satelliteId: sat3.id,
        name: "Sat3 Task",
        priority: 2,
        durationSeconds: 120,
        deadline: new Date(validLos.getTime() + 3600000),
        status: "PENDING",
      }).returning();

      const result3 = await constraintValidator.validate({
        taskId: taskSat3.id,
        contactWindowId: cwSat3.id,
        startTime: start,
        endTime: end,
      });

      expect(result3.valid).toBe(false);
      expect(result3.errors.some((e) => e.code === "GROUND_STATION_CAPACITY_EXCEEDED")).toBe(true);

      // 8. Cancelled reservations do NOT consume station capacity
      await db.update(reservations).set({ status: "CANCELLED" }).where(eq(reservations.id, resv2.id));

      const resultAfterCancel = await constraintValidator.validate({
        taskId: taskSat3.id,
        contactWindowId: cwSat3.id,
        startTime: start,
        endTime: end,
      });
      expect(resultAfterCancel.valid).toBe(true);

      // Cleanup extra satellites & reservations
      await db.delete(reservations).where(eq(reservations.id, resv1.id));
      await db.delete(reservations).where(eq(reservations.id, resv2.id));
      await db.delete(missionTasks).where(eq(missionTasks.id, taskSat2.id));
      await db.delete(missionTasks).where(eq(missionTasks.id, taskSat3.id));
      await db.delete(contactWindows).where(eq(contactWindows.id, cwSat2.id));
      await db.delete(contactWindows).where(eq(contactWindows.id, cwSat3.id));
      await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, sat2.id));
      await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, sat3.id));
      await db.delete(satellites).where(eq(satellites.id, sat2.id));
      await db.delete(satellites).where(eq(satellites.id, sat3.id));
    });
  });

  describe("HTTP API Enforcement (Preview & Manual Reservation)", () => {
    it("9. POST /api/reservations/preview with incompatible band -> returns valid: false with 0 DB mutation", async () => {
      const countBefore = await db.select({ count: sql<number>`count(*)` }).from(reservations);

      const res = await request(app)
        .post("/api/reservations/preview")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          taskId: xBandTask50MbpsId,
          contactWindowId: cwSbandId,
          startTime: new Date(validAos.getTime() + 60000).toISOString(),
          endTime: new Date(validAos.getTime() + 180000).toISOString(),
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.some((e: any) => e.code === "INCOMPATIBLE_FREQUENCY_BAND")).toBe(true);

      const countAfter = await db.select({ count: sql<number>`count(*)` }).from(reservations);
      expect(countBefore[0].count).toBe(countAfter[0].count); // Zero DB mutation
    });

    it("10. POST /api/reservations manual creation with incompatible band -> 422 rejected", async () => {
      const res = await request(app)
        .post("/api/reservations")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          taskId: xBandTask50MbpsId,
          contactWindowId: cwSbandId,
          startTime: new Date(validAos.getTime() + 60000).toISOString(),
          endTime: new Date(validAos.getTime() + 180000).toISOString(),
        });

      expect(res.status).toBe(422);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.some((e: any) => e.code === "INCOMPATIBLE_FREQUENCY_BAND")).toBe(true);
    });

    it("11. POST /api/reservations manual creation with compliant capabilities -> 201 created", async () => {
      const res = await request(app)
        .post("/api/reservations")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          taskId: sBandTask50MbpsId,
          contactWindowId: cwSbandId,
          startTime: new Date(validAos.getTime() + 60000).toISOString(),
          endTime: new Date(validAos.getTime() + 180000).toISOString(),
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.source).toBe("MANUAL");

      // Cleanup
      await db.delete(reservations).where(eq(reservations.id, res.body.id));
    });
  });
});
