import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../app";
import { db } from "../db/client";
import { eq } from "drizzle-orm";
import { satelliteOrbitalData, users, satellites, groundStations, contactWindows, missionTasks, reservations } from "../db/schema";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";
import { env } from "../config/env";

describe("Phase 3.4 - Constraint Validation Service", () => {
  let operatorToken: string;
  let adminToken: string;
  let testSatId: string;
  let testSat2Id: string;
  let testStationId: string;
  let testStation2Id: string;
  let testCwId: string;
  let testCw2Id: string;
  let testTaskId: string;
  
  let validAos: Date;
  let validLos: Date;

  beforeAll(async () => {
    // 1. Create tokens
    const [operator] = await db.insert(users).values({
      email: `op34_${Date.now()}@test.com`,
      passwordHash: await bcrypt.hash("password", 10),
      role: "OPERATOR"
    }).returning();
    operatorToken = jwt.sign({ sub: operator.id, role: operator.role }, env.jwtSecret, { expiresIn: "1h" });

    // 2. Create Satellites and Ground Stations
    const [sat] = await db.insert(satellites).values({
      noradId: 25544 + Date.now() % 10000,
      name: "ValidatorSat",
      type: "LEO",
      status: "ACTIVE"
    }).returning();
    testSatId = sat.id;

    const [sat2] = await db.insert(satellites).values({
      noradId: 25545 + Date.now() % 10000,
      name: "ValidatorSat2",
      type: "LEO",
      status: "ACTIVE"
    }).returning();
    testSat2Id = sat2.id;

    const [gs] = await db.insert(groundStations).values({
      name: "ValidatorGS",
      code: `VGS-${Date.now() % 10000}`,
      latitude: 0,
      longitude: 0,
      elevation: 0,
      minimumElevationDeg: 10,
      status: "AVAILABLE"
    }).returning();
    testStationId = gs.id;

    const [gs2] = await db.insert(groundStations).values({
      name: "ValidatorGS2",
      code: `VGS2-${Date.now() % 10000}`,
      latitude: 0,
      longitude: 0,
      elevation: 0,
      minimumElevationDeg: 10,
      status: "AVAILABLE"
    }).returning();
    testStation2Id = gs2.id;

    // 3. Orbital Data
    const [od] = await db.insert(satelliteOrbitalData).values({
      satelliteId: sat.id,
      source: 'CELESTRAK',
      tleLine1: '1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997',
      tleLine2: '2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495',
      tleEpoch: new Date(),
      receivedAt: new Date()
    }).returning();

    const [od2] = await db.insert(satelliteOrbitalData).values({
      satelliteId: sat2.id,
      source: 'CELESTRAK',
      tleLine1: '1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997',
      tleLine2: '2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495',
      tleEpoch: new Date(),
      receivedAt: new Date()
    }).returning();

    // 4. Contact Windows
    const now = Date.now();
    validAos = new Date(now + 1000000);
    validLos = new Date(validAos.getTime() + 15 * 60000); // 15 mins window
    
    const [cw] = await db.insert(contactWindows).values({
      satelliteId: sat.id,
      groundStationId: gs.id,
      orbitalDataId: od.id,
      aos: validAos,
      los: validLos,
      maxElevationDeg: 45,
      durationSeconds: 900,
    }).returning();
    testCwId = cw.id;

    const [cw2] = await db.insert(contactWindows).values({
      satelliteId: sat2.id,
      groundStationId: gs2.id,
      orbitalDataId: od2.id,
      aos: validAos,
      los: validLos,
      maxElevationDeg: 45,
      durationSeconds: 900,
    }).returning();
    testCw2Id = cw2.id;

    // 5. Mission Task
    const [task] = await db.insert(missionTasks).values({
      satelliteId: sat.id,
      name: "Validator Task",
      priority: 1,
      durationSeconds: 300, // 5 min requirement
      deadline: new Date(validLos.getTime() + 60000), // Deadline is just after LOS
      status: "PENDING"
    }).returning();
    testTaskId = task.id;
  });

  const sendPreview = async (body: any) => {
    return request(app)
      .post("/api/reservations/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send(body);
  };

  it("1. Valid reservation -> valid=true", async () => {
    const res = await sendPreview({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: new Date(validAos.getTime() + 60000).toISOString(),
      endTime: new Date(validAos.getTime() + 60000 + 400000).toISOString(), // ~6.6 mins duration
    });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.errors.length).toBe(0);
  });

  it("2. Satellite mismatch -> rejected", async () => {
    const res = await sendPreview({
      taskId: testTaskId, // Belongs to sat
      contactWindowId: testCw2Id, // Belongs to sat2
      startTime: new Date(validAos.getTime() + 60000).toISOString(),
      endTime: new Date(validAos.getTime() + 60000 + 400000).toISOString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.some((e: any) => e.code === "SATELLITE_MISMATCH")).toBe(true);
  });

  it("3. Ground-station mismatch -> rejected", async () => {
    // Ground station mismatch triggers when explicitly requested
    const res = await sendPreview({
      taskId: testTaskId,
      contactWindowId: testCwId, // Belongs to gs
      groundStationId: testStation2Id, // Explicitly requesting gs2
      startTime: new Date(validAos.getTime() + 60000).toISOString(),
      endTime: new Date(validAos.getTime() + 60000 + 400000).toISOString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.some((e: any) => e.code === "GROUND_STATION_MISMATCH")).toBe(true);
  });

  it("4. Before AOS -> rejected", async () => {
    const res = await sendPreview({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: new Date(validAos.getTime() - 60000).toISOString(), // 1 min before AOS
      endTime: new Date(validAos.getTime() + 300000).toISOString(),
    });
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.some((e: any) => e.code === "OUTSIDE_CONTACT_WINDOW")).toBe(true);
  });

  it("5. After LOS -> rejected", async () => {
    const res = await sendPreview({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: new Date(validAos.getTime() + 60000).toISOString(), 
      endTime: new Date(validLos.getTime() + 60000).toISOString(), // 1 min after LOS
    });
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.some((e: any) => e.code === "OUTSIDE_CONTACT_WINDOW")).toBe(true);
  });

  it("6. Duration too long (Wait, actually 'Duration too short') -> rejected", async () => {
    // Task requires 300s. We'll give it 100s.
    const res = await sendPreview({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: new Date(validAos.getTime() + 60000).toISOString(),
      endTime: new Date(validAos.getTime() + 160000).toISOString(), // 100 seconds
    });
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.some((e: any) => e.code === "DURATION_UNSATISFIED")).toBe(true);
  });

  it("7. Deadline violation -> rejected", async () => {
    // Task deadline is LOS + 1 min.
    const res = await sendPreview({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: new Date(validAos.getTime() + 60000).toISOString(),
      endTime: new Date(validAos.getTime() + 60000 + 400000).toISOString(),
    });
    // Wait, let's update task deadline to be in the past to trigger this easily
    await db.update(missionTasks).set({ deadline: new Date(validAos.getTime() - 60000) }).where(eq(missionTasks.id, testTaskId));
    
    const res2 = await sendPreview({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: new Date(validAos.getTime() + 60000).toISOString(),
      endTime: new Date(validAos.getTime() + 60000 + 400000).toISOString(),
    });

    expect(res2.body.valid).toBe(false);
    expect(res2.body.errors.some((e: any) => e.code === "DEADLINE_MISSED")).toBe(true);

    // Revert deadline
    await db.update(missionTasks).set({ deadline: new Date(validLos.getTime() + 60000) }).where(eq(missionTasks.id, testTaskId));
  });

  it("8 & 9. Station overlap & Satellite overlap -> rejected", async () => {
    const startTime = new Date(validAos.getTime() + 60000);
    const endTime = new Date(validAos.getTime() + 60000 + 400000);

    // Manually insert a conflicting reservation
    await db.insert(reservations).values({
      missionTaskId: testTaskId,
      contactWindowId: testCwId,
      groundStationId: testStationId,
      satelliteId: testSatId,
      windowAos: validAos,
      windowLos: validLos,
      taskDurationSeconds: 300,
      allocatedStart: new Date(startTime.getTime() - 30000),
      allocatedEnd: new Date(startTime.getTime() - 30000 + 300000), // Exactly 300s later
      status: "PENDING",
      source: "MANUAL"
    });

    const res = await sendPreview({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    });
    
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.some((e: any) => e.code === "SATELLITE_CONFLICT")).toBe(true);
    expect(res.body.errors.some((e: any) => e.code === "STATION_CONFLICT")).toBe(true);

    // Clean up
    await db.delete(reservations).where(eq(reservations.satelliteId, testSatId));
  });

  it("10. Multiple simultaneous violations -> all applicable reasons returned", async () => {
    // 1. duration too short (DURATION_UNSATISFIED)
    // 2. after LOS (OUTSIDE_CONTACT_WINDOW)
    // 3. deadline missed (DEADLINE_MISSED) - Set task deadline before end
    await db.update(missionTasks).set({ deadline: new Date(validLos.getTime() - 60000) }).where(eq(missionTasks.id, testTaskId));

    const startTime = new Date(validLos.getTime() + 10000);
    const endTime = new Date(validLos.getTime() + 20000); // 10s duration < 300s

    const res = await sendPreview({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    });

    expect(res.body.valid).toBe(false);
    const codes = res.body.errors.map((e: any) => e.code);
    expect(codes).toContain("DURATION_UNSATISFIED");
    expect(codes).toContain("OUTSIDE_CONTACT_WINDOW");
    expect(codes).toContain("DEADLINE_MISSED");
  });

  it("11. Preview causes zero DB mutations", async () => {
    const resvCountBefore = await db.select().from(reservations).where(eq(reservations.satelliteId, testSatId));
    
    await sendPreview({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: validAos.toISOString(),
      endTime: validLos.toISOString(),
    });

    const resvCountAfter = await db.select().from(reservations).where(eq(reservations.satelliteId, testSatId));
    expect(resvCountBefore.length).toBe(resvCountAfter.length);
  });
});
