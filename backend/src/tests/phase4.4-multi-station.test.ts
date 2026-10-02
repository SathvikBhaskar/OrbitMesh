/**
 * OrbitMesh Phase 4.4 - Multi-Station Allocation & Overlapping Pass Disambiguation Tests
 * 
 * Formal Acceptance Test Suite for Phase 4.4:
 * 
 * Core Capabilities Verified:
 * 1. Network-Level Allocation: Station/Window pair treated as the candidate resource.
 * 2. Overlapping Visibility Disambiguation: Single satellite pass simultaneously covering
 *    Chennai GS and Bangalore GS distributes tasks across both stations without satellite conflict.
 * 3. Parallel Multi-Satellite Allocation: Two distinct satellites simultaneously serviced
 *    by two distinct ground stations in the same time interval.
 * 4. Capacity Overflow: When a primary station reaches capacity, the scheduler transparently
 *    routes tasks to an alternate capable station.
 * 5. Hardware Capabilities Across Stations:
 *    - Incompatible RF band on alternate station -> upstream rejection.
 *    - Insufficient data rate on alternate station -> upstream rejection.
 * 6. Intra-Satellite Exclusivity: Single satellite transceiver can NEVER transmit to two stations
 *    at the same time (no double-booking).
 * 7. MANUAL + LOCKED Invariance: Locked reservation on Station A causes automated task to route
 *    to Station B, preserving Station A's locked reservation intact.
 * 8. Deterministic Station Selection: Highest quality/elevation station chosen when multiple are available.
 * 9. Multi-Channel Station Concurrency: Dual-channel station serves multiple satellites up to capacity.
 * 10. Multi-Task Packing: Sequential packing with guard bands (re-pointing / handshake intervals).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../app";
import { db } from "../db/client";
import { eq, or, and, inArray } from "drizzle-orm";
import {
  satelliteOrbitalData,
  users,
  satellites,
  groundStations,
  contactWindows,
  missionTasks,
  reservations,
  scheduleVersions,
} from "../db/schema";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";
import { env } from "../config/env";
import { constraintValidator } from "../modules/reservations/constraint-validator";
import { CandidateService } from "../modules/scheduler/candidate-service";
import {
  HybridScoringScheduler,
} from "../modules/scheduler/hybrid-scoring-scheduler";
import { DEFAULT_HYBRID_WEIGHTS } from "../modules/scheduler/scoring";

describe("Phase 4.4 - Multi-Station Allocation & Overlapping Pass Disambiguation", () => {
  let operatorToken: string;
  let viewerToken: string;

  // Satellites
  let sat1Id: string; // S1
  let sat2Id: string; // S2
  let sat3Id: string; // S3

  let od1Id: string;
  let od2Id: string;
  let od3Id: string;

  // Ground Stations
  let gsChennaiId: string;   // Chennai GS (S_BAND, X_BAND, capacity 1, 150 Mbps)
  let gsBangaloreId: string; // Bangalore GS (S_BAND only, capacity 1, 50 Mbps)
  let gsSvalbardId: string;  // Svalbard GS (S_BAND, X_BAND, KA_BAND, capacity 2, 300 Mbps)

  const epochBase = new Date("2026-11-01T10:00:00.000Z").getTime();

  beforeAll(async () => {
    // 1. Auth Users
    const [op] = await db
      .insert(users)
      .values({
        email: `op44_${Date.now()}@test.com`,
        passwordHash: await bcrypt.hash("password", 10),
        role: "OPERATOR",
      })
      .returning();
    operatorToken = jwt.sign({ sub: op.id, role: op.role }, env.jwtSecret, { expiresIn: "1h" });

    const [vw] = await db
      .insert(users)
      .values({
        email: `vw44_${Date.now()}@test.com`,
        passwordHash: await bcrypt.hash("password", 10),
        role: "VIEWER",
      })
      .returning();
    viewerToken = jwt.sign({ sub: vw.id, role: vw.role }, env.jwtSecret, { expiresIn: "1h" });

    // 2. Satellites
    const [s1] = await db
      .insert(satellites)
      .values({
        noradId: 61001,
        name: "Sat-44-Alpha",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat1Id = s1.id;

    const [s2] = await db
      .insert(satellites)
      .values({
        noradId: 61002,
        name: "Sat-44-Beta",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat2Id = s2.id;

    const [s3] = await db
      .insert(satellites)
      .values({
        noradId: 61003,
        name: "Sat-44-Gamma",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat3Id = s3.id;

    // 3. Orbital Data
    const [od1] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: sat1Id,
        source: "CELESTRAK",
        tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
        tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
        tleEpoch: new Date(epochBase),
        receivedAt: new Date(epochBase),
      })
      .returning();
    od1Id = od1.id;

    const [od2] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: sat2Id,
        source: "CELESTRAK",
        tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
        tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
        tleEpoch: new Date(epochBase),
        receivedAt: new Date(epochBase),
      })
      .returning();
    od2Id = od2.id;

    const [od3] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: sat3Id,
        source: "CELESTRAK",
        tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
        tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
        tleEpoch: new Date(epochBase),
        receivedAt: new Date(epochBase),
      })
      .returning();
    od3Id = od3.id;

    // 4. Ground Stations
    // Chennai: S_BAND & X_BAND, capacity 1, 150 Mbps
    const [gs1] = await db
      .insert(groundStations)
      .values({
        code: `GS44-CHENNAI-${Date.now() % 10000}`,
        name: "Chennai Tracking Station",
        latitude: 13.0827,
        longitude: 80.2707,
        altitudeM: 10,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 1,
        maxDataRateMbps: 150.0,
      })
      .returning();
    gsChennaiId = gs1.id;

    // Bangalore: S_BAND only, capacity 1, 50 Mbps
    const [gs2] = await db
      .insert(groundStations)
      .values({
        code: `GS44-BANGALORE-${Date.now() % 10000}`,
        name: "Bangalore Telemetry Station",
        latitude: 12.9716,
        longitude: 77.5946,
        altitudeM: 920,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND"],
        maxConcurrentContacts: 1,
        maxDataRateMbps: 50.0,
      })
      .returning();
    gsBangaloreId = gs2.id;

    // Svalbard: S_BAND, X_BAND, KA_BAND, capacity 2, 300 Mbps
    const [gs3] = await db
      .insert(groundStations)
      .values({
        code: `GS44-SVALBARD-${Date.now() % 10000}`,
        name: "Svalbard Polar Dual-Channel",
        latitude: 78.2297,
        longitude: 15.4077,
        altitudeM: 400,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND", "X_BAND", "KA_BAND"],
        maxConcurrentContacts: 2,
        maxDataRateMbps: 300.0,
      })
      .returning();
    gsSvalbardId = gs3.id;
  });

  afterAll(async () => {
    const allSatIds = [sat1Id, sat2Id, sat3Id];
    const allGsIds = [gsChennaiId, gsBangaloreId, gsSvalbardId];

    await db.delete(reservations).where(or(
      inArray(reservations.satelliteId, allSatIds),
      inArray(reservations.groundStationId, allGsIds)
    ));
    await db.delete(missionTasks).where(inArray(missionTasks.satelliteId, allSatIds));
    await db.delete(contactWindows).where(or(
      inArray(contactWindows.satelliteId, allSatIds),
      inArray(contactWindows.groundStationId, allGsIds)
    ));
    await db.delete(satelliteOrbitalData).where(inArray(satelliteOrbitalData.satelliteId, allSatIds));
    await db.delete(satellites).where(inArray(satellites.id, allSatIds));
  });

  async function cleanupCurrentTestData() {
    const allSatIds = [sat1Id, sat2Id, sat3Id];
    const allGsIds = [gsChennaiId, gsBangaloreId, gsSvalbardId];

    await db.delete(reservations).where(
      or(
        inArray(reservations.satelliteId, allSatIds),
        inArray(reservations.groundStationId, allGsIds)
      )
    );
    await db.delete(missionTasks).where(inArray(missionTasks.satelliteId, allSatIds));
    await db.delete(contactWindows).where(
      or(
        inArray(contactWindows.satelliteId, allSatIds),
        inArray(contactWindows.groundStationId, allGsIds)
      )
    );
  }

  beforeEach(async () => {
    await cleanupCurrentTestData();
  });

  describe("Controlled Overlapping Pass Fixture & Multi-Station Task Distribution", () => {
    it("1. Single satellite visible to Chennai and Bangalore simultaneously distributes competing tasks across both stations", async () => {
      const t0 = epochBase + 100000;
      // Chennai W1: t0 to t0 + 300s, max elevation 70 deg
      const [w1] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000), // 300s window
          durationSeconds: 300,
          maxElevationDeg: 70,
          status: "AVAILABLE",
        })
        .returning();

      // Bangalore W2: overlapping from t0 + 60s to t0 + 660s, max elevation 55 deg
      const [w2] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsBangaloreId,
          orbitalDataId: od1Id,
          aos: new Date(t0 + 60000),
          los: new Date(t0 + 660000), // 600s
          durationSeconds: 600,
          maxElevationDeg: 55,
          status: "AVAILABLE",
        })
        .returning();

      // Task A: duration 300s, priority 8
      const [taskA] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "Task A - Overlap Contention",
          priority: 8,
          durationSeconds: 300,
          deadline: new Date(t0 + 1200000),
          status: "PENDING",
        })
        .returning();

      // Task B: duration 300s, priority 6
      const [taskB] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "Task B - Overlap Contention",
          priority: 6,
          durationSeconds: 300,
          deadline: new Date(t0 + 1200000),
          status: "PENDING",
        })
        .returning();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        new Date(t0),
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );

      const res = await scheduler.schedulePendingTasks([taskA.id, taskB.id]);

      // Both tasks scheduled (2/2 scheduled)!
      expect(res.scheduled).toBe(2);
      expect(res.unscheduled).toBe(0);

      const resvA = await db.select().from(reservations).where(eq(reservations.missionTaskId, taskA.id));
      const resvB = await db.select().from(reservations).where(eq(reservations.missionTaskId, taskB.id));

      expect(resvA.length).toBe(1);
      expect(resvB.length).toBe(1);

      // Verify that Task A and Task B were distributed across the two distinct stations
      const stationA = resvA[0].groundStationId;
      const stationB = resvB[0].groundStationId;

      // Higher elevation Chennai chosen by higher-ranked Task A
      expect(stationA).toBe(gsChennaiId);
      // Alternate Bangalore station utilized by Task B
      expect(stationB).toBe(gsBangaloreId);

      // Verify NO intra-satellite overlap on Satellite 1 transceiver
      const aStart = new Date(resvA[0].allocatedStart).getTime();
      const aEnd = new Date(resvA[0].allocatedEnd).getTime();
      const bStart = new Date(resvB[0].allocatedStart).getTime();
      const bEnd = new Date(resvB[0].allocatedEnd).getTime();

      const overlaps = aStart < bEnd && aEnd > bStart;
      expect(overlaps).toBe(false);

      // Cleanup
      await db.delete(reservations).where(or(eq(reservations.id, resvA[0].id), eq(reservations.id, resvB[0].id)));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, taskA.id), eq(missionTasks.id, taskB.id)));
      await db.delete(contactWindows).where(or(eq(contactWindows.id, w1.id), eq(contactWindows.id, w2.id)));
    });

    it("2. Parallel Multi-Satellite Allocation: Two distinct satellites simultaneously serviced by distinct stations at identical timestamp", async () => {
      const t0 = epochBase + 200000;
      // Sat 1 visible from Chennai from t0 to t0 + 300s
      const [wSat1] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 60,
          status: "AVAILABLE",
        })
        .returning();

      // Sat 2 visible from Bangalore from t0 to t0 + 300s (exact same timestamp)
      const [wSat2] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat2Id,
          groundStationId: gsBangaloreId,
          orbitalDataId: od2Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 55,
          status: "AVAILABLE",
        })
        .returning();

      const [taskSat1] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "Sat1 Parallel Task",
          priority: 7,
          durationSeconds: 300,
          deadline: new Date(t0 + 600000),
          status: "PENDING",
        })
        .returning();

      const [taskSat2] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat2Id,
          name: "Sat2 Parallel Task",
          priority: 7,
          durationSeconds: 300,
          deadline: new Date(t0 + 600000),
          status: "PENDING",
        })
        .returning();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        new Date(t0),
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );

      const res = await scheduler.schedulePendingTasks([taskSat1.id, taskSat2.id]);

      expect(res.scheduled).toBe(2);
      expect(res.unscheduled).toBe(0);

      const resvSat1 = await db.select().from(reservations).where(eq(reservations.missionTaskId, taskSat1.id));
      const resvSat2 = await db.select().from(reservations).where(eq(reservations.missionTaskId, taskSat2.id));

      expect(resvSat1.length).toBe(1);
      expect(resvSat2.length).toBe(1);

      // Verify simultaneous parallel execution at identical timestamps
      expect(new Date(resvSat1[0].allocatedStart).getTime()).toBe(t0);
      expect(new Date(resvSat2[0].allocatedStart).getTime()).toBe(t0);
      expect(resvSat1[0].groundStationId).toBe(gsChennaiId);
      expect(resvSat2[0].groundStationId).toBe(gsBangaloreId);

      // Cleanup
      await db.delete(reservations).where(or(eq(reservations.id, resvSat1[0].id), eq(reservations.id, resvSat2[0].id)));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, taskSat1.id), eq(missionTasks.id, taskSat2.id)));
      await db.delete(contactWindows).where(or(eq(contactWindows.id, wSat1.id), eq(contactWindows.id, wSat2.id)));
    });
  });

  describe("Network-Level Capacity Overflow & Alternate Station Routing", () => {
    it("3. Single-Station Capacity Saturation transparently routes task to alternate station", async () => {
      const t0 = epochBase + 300000;
      // Chennai W1 for Sat 2: capacity = 1
      const [wChennaiSat2] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat2Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od2Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000), // 300s window
          durationSeconds: 300,
          maxElevationDeg: 80,
          status: "AVAILABLE",
        })
        .returning();

      // Chennai W2 for Sat 1
      const [wChennaiSat1] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000), // 300s window
          durationSeconds: 300,
          maxElevationDeg: 80,
          status: "AVAILABLE",
        })
        .returning();

      // Bangalore W3 for Sat 1: capacity = 1
      const [wBangaloreSat1] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsBangaloreId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000), // 300s window
          durationSeconds: 300,
          maxElevationDeg: 60,
          status: "AVAILABLE",
        })
        .returning();

      // Pre-occupy Chennai with an active reservation for Sat2
      const [blockingTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat2Id,
          name: "Blocking Task on Chennai",
          priority: 5,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "SCHEDULED",
        })
        .returning();

      const [blockingResv] = await db
        .insert(reservations)
        .values({
          missionTaskId: blockingTask.id,
          contactWindowId: wChennaiSat2.id,
          groundStationId: gsChennaiId,
          satelliteId: sat2Id,
          windowAos: new Date(t0),
          windowLos: new Date(t0 + 300000),
          taskDurationSeconds: 300,
          allocatedStart: new Date(t0),
          allocatedEnd: new Date(t0 + 300000),
          status: "CONFIRMED",
          source: "AUTOMATED",
          locked: false,
        })
        .returning();

      // Pending task for Sat 1
      const [pendingTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "Sat1 Routing Task",
          priority: 9,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "PENDING",
        })
        .returning();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        new Date(t0),
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );

      const res = await scheduler.schedulePendingTasks([pendingTask.id]);

      // Successfully scheduled on alternate station!
      expect(res.scheduled).toBe(1);
      const resv = await db.select().from(reservations).where(eq(reservations.missionTaskId, pendingTask.id));
      expect(resv.length).toBe(1);
      expect(resv[0].groundStationId).toBe(gsBangaloreId);
      expect(resv[0].contactWindowId).toBe(wBangaloreSat1.id);

      // Cleanup
      await db.delete(reservations).where(or(eq(reservations.id, blockingResv.id), eq(reservations.id, resv[0].id)));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, blockingTask.id), eq(missionTasks.id, pendingTask.id)));
      await db.delete(contactWindows).where(or(
        eq(contactWindows.id, wChennaiSat2.id),
        eq(contactWindows.id, wChennaiSat1.id),
        eq(contactWindows.id, wBangaloreSat1.id)
      ));
    });
  });

  describe("Hardware Capability Filtering Across Alternate Stations", () => {
    it("4. Alternate station lacking required RF band is rejected upstream; does not receive task", async () => {
      const t0 = epochBase + 400000;
      // Chennai is X_BAND capable, but fully occupied by Sat 2
      const [wChennaiSat2] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat2Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od2Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 75,
          status: "AVAILABLE",
        })
        .returning();

      // Chennai window for Sat 1
      const [wChennaiSat1] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 75,
          status: "AVAILABLE",
        })
        .returning();

      // Bangalore is available for Sat 1, but ONLY supports S_BAND
      const [wBangaloreSat1] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsBangaloreId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 60,
          status: "AVAILABLE",
        })
        .returning();

      // Occupy Chennai completely
      const [blockTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat2Id,
          name: "Block Chennai",
          priority: 1,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "SCHEDULED",
        })
        .returning();

      const [blockResv] = await db
        .insert(reservations)
        .values({
          missionTaskId: blockTask.id,
          contactWindowId: wChennaiSat2.id,
          groundStationId: gsChennaiId,
          satelliteId: sat2Id,
          windowAos: new Date(t0),
          windowLos: new Date(t0 + 300000),
          taskDurationSeconds: 300,
          allocatedStart: new Date(t0),
          allocatedEnd: new Date(t0 + 300000),
          status: "CONFIRMED",
          source: "AUTOMATED",
          locked: false,
        })
        .returning();

      // Task requiring X_BAND
      const [xBandTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "X-Band Task Requiring Incompatible Alt Station",
          priority: 10,
          durationSeconds: 180,
          deadline: new Date(t0 + 600000),
          requiredFrequencyBand: "X_BAND", // Bangalore lacks X_BAND
          status: "PENDING",
        })
        .returning();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        new Date(t0),
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );

      const res = await scheduler.schedulePendingTasks([xBandTask.id]);

      // Cannot be scheduled on Bangalore because Bangalore lacks X_BAND
      expect(res.scheduled).toBe(0);
      expect(res.unscheduled).toBe(1);

      const outcome = res.results.find((r) => r.taskId === xBandTask.id);
      expect(["NO_FEASIBLE_WINDOW", "INCOMPATIBLE_FREQUENCY_BAND"]).toContain(outcome?.reason);

      // Verify no reservation created on Bangalore
      const bangaloreResvs = await db
        .select()
        .from(reservations)
        .where(eq(reservations.groundStationId, gsBangaloreId));
      expect(bangaloreResvs.length).toBe(0);

      // Cleanup
      await db.delete(reservations).where(eq(reservations.id, blockResv.id));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, blockTask.id), eq(missionTasks.id, xBandTask.id)));
      await db.delete(contactWindows).where(or(
        eq(contactWindows.id, wChennaiSat2.id),
        eq(contactWindows.id, wChennaiSat1.id),
        eq(contactWindows.id, wBangaloreSat1.id)
      ));
    });

    it("5. Alternate station lacking sufficient data rate is rejected upstream", async () => {
      const t0 = epochBase + 500000;
      // Chennai is 150 Mbps capable, but occupied by Sat 2
      const [wChennaiSat2] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat2Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od2Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 75,
          status: "AVAILABLE",
        })
        .returning();

      // Chennai window for Sat 1
      const [wChennaiSat1] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 75,
          status: "AVAILABLE",
        })
        .returning();

      // Bangalore is available for Sat 1, but maxDataRate is 50 Mbps
      const [wBangaloreSat1] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsBangaloreId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 60,
          status: "AVAILABLE",
        })
        .returning();

      // Occupy Chennai
      const [blockTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat2Id,
          name: "Block Chennai Rate",
          priority: 1,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "SCHEDULED",
        })
        .returning();

      const [blockResv] = await db
        .insert(reservations)
        .values({
          missionTaskId: blockTask.id,
          contactWindowId: wChennaiSat2.id,
          groundStationId: gsChennaiId,
          satelliteId: sat2Id,
          windowAos: new Date(t0),
          windowLos: new Date(t0 + 300000),
          taskDurationSeconds: 300,
          allocatedStart: new Date(t0),
          allocatedEnd: new Date(t0 + 300000),
          status: "CONFIRMED",
          source: "AUTOMATED",
          locked: false,
        })
        .returning();

      // Task requires 100 Mbps (Bangalore max is 50 Mbps)
      const [highRateTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "100 Mbps Task",
          priority: 9,
          durationSeconds: 180,
          deadline: new Date(t0 + 600000),
          minDataRateMbps: 100.0,
          status: "PENDING",
        })
        .returning();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        new Date(t0),
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );

      const res = await scheduler.schedulePendingTasks([highRateTask.id]);

      // Rejected because Bangalore data rate is insufficient
      expect(res.scheduled).toBe(0);
      expect(res.unscheduled).toBe(1);

      // Cleanup
      await db.delete(reservations).where(eq(reservations.id, blockResv.id));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, blockTask.id), eq(missionTasks.id, highRateTask.id)));
      await db.delete(contactWindows).where(or(
        eq(contactWindows.id, wChennaiSat2.id),
        eq(contactWindows.id, wChennaiSat1.id),
        eq(contactWindows.id, wBangaloreSat1.id)
      ));
    });
  });

  describe("Intra-Satellite Exclusivity & Transceiver Collision Invariance", () => {
    it("6. Same satellite CANNOT maintain simultaneous contacts with two stations; transceiver exclusivity strictly enforced", async () => {
      const t0 = epochBase + 600000;
      // S1 visible to Chennai and Bangalore simultaneously
      const [wChennai] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 70,
          status: "AVAILABLE",
        })
        .returning();

      const [wBangalore] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsBangaloreId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 65,
          status: "AVAILABLE",
        })
        .returning();

      // Pre-reserve S1 at Chennai for full 300s
      const [resvS1Chennai] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "S1 Active Contact on Chennai",
          priority: 8,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "SCHEDULED",
        })
        .returning();

      const [activeResv] = await db
        .insert(reservations)
        .values({
          missionTaskId: resvS1Chennai.id,
          contactWindowId: wChennai.id,
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
          windowAos: new Date(t0),
          windowLos: new Date(t0 + 300000),
          taskDurationSeconds: 300,
          allocatedStart: new Date(t0),
          allocatedEnd: new Date(t0 + 300000),
          status: "CONFIRMED",
          source: "AUTOMATED",
          locked: false,
        })
        .returning();

      // Pending task for S1 attempting to use Bangalore at overlapping time
      const [competingTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "S1 Competing Contact on Bangalore",
          priority: 10,
          durationSeconds: 150,
          deadline: new Date(t0 + 300000), // Deadline is end of pass
          status: "PENDING",
        })
        .returning();

      // Authoritative ConstraintValidationService validation directly forbids satellite collision
      const val = await constraintValidator.validate({
        taskId: competingTask.id,
        contactWindowId: wBangalore.id,
        startTime: new Date(t0),
        endTime: new Date(t0 + 150000),
      });

      expect(val.valid).toBe(false);
      expect(val.errors.some((e) => e.code === "SATELLITE_CONFLICT")).toBe(true);

      // Scheduler also strictly refuses to double-book S1
      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        new Date(t0),
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );

      const res = await scheduler.schedulePendingTasks([competingTask.id]);
      expect(res.scheduled).toBe(0);
      expect(res.unscheduled).toBe(1);

      // Cleanup
      await db.delete(reservations).where(eq(reservations.id, activeResv.id));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, resvS1Chennai.id), eq(missionTasks.id, competingTask.id)));
      await db.delete(contactWindows).where(or(eq(contactWindows.id, wChennai.id), eq(contactWindows.id, wBangalore.id)));
    });
  });

  describe("MANUAL + LOCKED Reservation Invariance with Multi-Station Routing", () => {
    it("7. MANUAL + LOCKED reservation on Station A causes automated task to route to Station B without mutating Station A", async () => {
      const t0 = epochBase + 700000;
      const [wChennai] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 85, // Higher elevation Chennai
          status: "AVAILABLE",
        })
        .returning();

      const [wBangalore] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsBangaloreId,
          orbitalDataId: od1Id,
          aos: new Date(t0 + 300000),
          los: new Date(t0 + 600000),
          durationSeconds: 300,
          maxElevationDeg: 50,
          status: "AVAILABLE",
        })
        .returning();

      // MANUAL + LOCKED reservation occupying entire Chennai window
      const [lockedTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "Locked Manual Pass",
          priority: 1,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "SCHEDULED",
        })
        .returning();

      const [lockedResv] = await db
        .insert(reservations)
        .values({
          missionTaskId: lockedTask.id,
          contactWindowId: wChennai.id,
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
          windowAos: new Date(t0),
          windowLos: new Date(t0 + 300000),
          taskDurationSeconds: 300,
          allocatedStart: new Date(t0),
          allocatedEnd: new Date(t0 + 300000),
          status: "CONFIRMED",
          source: "MANUAL",
          locked: true,
        })
        .returning();

      // Automated task for Sat 1
      const [autoTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "Automated Routing Task",
          priority: 8,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "PENDING",
        })
        .returning();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        new Date(t0),
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );

      const res = await scheduler.schedulePendingTasks([autoTask.id]);

      // Successfully routed to Bangalore!
      expect(res.scheduled).toBe(1);
      const resv = await db.select().from(reservations).where(eq(reservations.missionTaskId, autoTask.id));
      expect(resv.length).toBe(1);
      expect(resv[0].groundStationId).toBe(gsBangaloreId);

      // Verify locked reservation on Chennai is 100% immutable and intact
      const existingLocked = await db.select().from(reservations).where(eq(reservations.id, lockedResv.id));
      expect(existingLocked.length).toBe(1);
      expect(existingLocked[0].locked).toBe(true);
      expect(existingLocked[0].source).toBe("MANUAL");
      expect(existingLocked[0].groundStationId).toBe(gsChennaiId);

      // Cleanup
      await db.delete(reservations).where(or(eq(reservations.id, lockedResv.id), eq(reservations.id, resv[0].id)));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, lockedTask.id), eq(missionTasks.id, autoTask.id)));
      await db.delete(contactWindows).where(or(eq(contactWindows.id, wChennai.id), eq(contactWindows.id, wBangalore.id)));
    });
  });

  describe("Multi-Channel Ground Station Concurrency", () => {
    it("8. Multi-channel station (capacity = 2) simultaneously services two satellites; saturating capacity diverts 3rd satellite", async () => {
      const t0 = epochBase + 800000;
      // Svalbard has capacity = 2
      const [wSvalbardSat1] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsSvalbardId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 75,
          status: "AVAILABLE",
        })
        .returning();

      const [wSvalbardSat2] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat2Id,
          groundStationId: gsSvalbardId,
          orbitalDataId: od2Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 70,
          status: "AVAILABLE",
        })
        .returning();

      const [wSvalbardSat3] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat3Id,
          groundStationId: gsSvalbardId,
          orbitalDataId: od3Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 65,
          status: "AVAILABLE",
        })
        .returning();

      // Sat 3 also has an alternate window on Chennai at the same time
      const [wChennaiSat3] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat3Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od3Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 55,
          status: "AVAILABLE",
        })
        .returning();

      const [task1] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "Svalbard Sat1 Task",
          priority: 9,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "PENDING",
        })
        .returning();

      const [task2] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat2Id,
          name: "Svalbard Sat2 Task",
          priority: 8,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "PENDING",
        })
        .returning();

      const [task3] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat3Id,
          name: "Svalbard Sat3 Overflow Task",
          priority: 7,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "PENDING",
        })
        .returning();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        new Date(t0),
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );

      const res = await scheduler.schedulePendingTasks([task1.id, task2.id, task3.id]);

      // All 3 scheduled!
      expect(res.scheduled).toBe(3);
      expect(res.unscheduled).toBe(0);

      const r1 = await db.select().from(reservations).where(eq(reservations.missionTaskId, task1.id));
      const r2 = await db.select().from(reservations).where(eq(reservations.missionTaskId, task2.id));
      const r3 = await db.select().from(reservations).where(eq(reservations.missionTaskId, task3.id));

      // Task 1 and Task 2 both allocated to Svalbard simultaneously (capacity = 2)
      expect(r1[0].groundStationId).toBe(gsSvalbardId);
      expect(r2[0].groundStationId).toBe(gsSvalbardId);
      expect(new Date(r1[0].allocatedStart).getTime()).toBe(t0);
      expect(new Date(r2[0].allocatedStart).getTime()).toBe(t0);

      // Task 3 diverted to alternate Chennai GS because Svalbard capacity was saturated!
      expect(r3[0].groundStationId).toBe(gsChennaiId);
      expect(new Date(r3[0].allocatedStart).getTime()).toBe(t0);

      // Cleanup
      await db.delete(reservations).where(or(eq(reservations.id, r1[0].id), eq(reservations.id, r2[0].id), eq(reservations.id, r3[0].id)));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, task1.id), eq(missionTasks.id, task2.id), eq(missionTasks.id, task3.id)));
      await db.delete(contactWindows).where(or(
        eq(contactWindows.id, wSvalbardSat1.id),
        eq(contactWindows.id, wSvalbardSat2.id),
        eq(contactWindows.id, wSvalbardSat3.id),
        eq(contactWindows.id, wChennaiSat3.id)
      ));
    });
  });

  describe("Multi-Task Sequential Packing with Guard Bands", () => {
    it("9. Multiple tasks pack sequentially within single window respecting configurable guard band", async () => {
      const t0 = epochBase + 900000;
      // Single 900-second window on Chennai
      const [winPack] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 900000), // 900s
          durationSeconds: 900,
          maxElevationDeg: 80,
          status: "AVAILABLE",
        })
        .returning();

      // Task 1: 200s
      const [t1] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "Packing Task 1",
          priority: 8,
          durationSeconds: 200,
          deadline: new Date(t0 + 1200000),
          status: "PENDING",
        })
        .returning();

      // Task 2: 200s
      const [t2] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "Packing Task 2",
          priority: 7,
          durationSeconds: 200,
          deadline: new Date(t0 + 1200000),
          status: "PENDING",
        })
        .returning();

      // Task 3: 200s
      const [t3] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "Packing Task 3",
          priority: 6,
          durationSeconds: 200,
          deadline: new Date(t0 + 1200000),
          status: "PENDING",
        })
        .returning();

      // Configure scheduler with 30-second guard band
      const guardBandSec = 30;
      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        new Date(t0),
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID",
        guardBandSec
      );

      const res = await scheduler.schedulePendingTasks([t1.id, t2.id, t3.id]);

      // All 3 pack into the 900s window! (200 + 30 + 200 + 30 + 200 = 660 <= 900)
      expect(res.scheduled).toBe(3);
      expect(res.unscheduled).toBe(0);

      const resvs = await db
        .select()
        .from(reservations)
        .where(inArray(reservations.missionTaskId, [t1.id, t2.id, t3.id]))
        .orderBy(reservations.allocatedStart);

      expect(resvs.length).toBe(3);

      // Verify strict sequential ordering with at least 30s guard band between consecutive tasks
      const r1End = new Date(resvs[0].allocatedEnd).getTime();
      const r2Start = new Date(resvs[1].allocatedStart).getTime();
      const r2End = new Date(resvs[1].allocatedEnd).getTime();
      const r3Start = new Date(resvs[2].allocatedStart).getTime();

      const gap1 = (r2Start - r1End) / 1000;
      const gap2 = (r3Start - r2End) / 1000;

      expect(gap1).toBeGreaterThanOrEqual(guardBandSec);
      expect(gap2).toBeGreaterThanOrEqual(guardBandSec);

      // Cleanup
      await db.delete(reservations).where(inArray(reservations.id, resvs.map((r) => r.id)));
      await db.delete(missionTasks).where(inArray(missionTasks.id, [t1.id, t2.id, t3.id]));
      await db.delete(contactWindows).where(eq(contactWindows.id, winPack.id));
    });
  });

  describe("Deterministic Station Selection", () => {
    it("10. Multiple feasible stations are deterministically selected by elevation quality score", async () => {
      const t0 = epochBase + 1000000;
      // Chennai: elevation 85 deg
      const [wHighElev] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsChennaiId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 85,
          status: "AVAILABLE",
        })
        .returning();

      // Bangalore: elevation 30 deg
      const [wLowElev] = await db
        .insert(contactWindows)
        .values({
          satelliteId: sat1Id,
          groundStationId: gsBangaloreId,
          orbitalDataId: od1Id,
          aos: new Date(t0),
          los: new Date(t0 + 300000),
          durationSeconds: 300,
          maxElevationDeg: 30,
          status: "AVAILABLE",
        })
        .returning();

      const [singleTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sat1Id,
          name: "Elevation Quality Evaluation Task",
          priority: 5,
          durationSeconds: 180,
          deadline: new Date(t0 + 1000000),
          status: "PENDING",
        })
        .returning();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        new Date(t0),
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );

      const res = await scheduler.schedulePendingTasks([singleTask.id]);
      expect(res.scheduled).toBe(1);

      const resv = await db.select().from(reservations).where(eq(reservations.missionTaskId, singleTask.id));
      expect(resv.length).toBe(1);
      // Higher elevation station (Chennai) is selected
      expect(resv[0].groundStationId).toBe(gsChennaiId);
      expect(resv[0].contactWindowId).toBe(wHighElev.id);

      // Cleanup
      await db.delete(reservations).where(eq(reservations.id, resv[0].id));
      await db.delete(missionTasks).where(eq(missionTasks.id, singleTask.id));
      await db.delete(contactWindows).where(or(eq(contactWindows.id, wHighElev.id), eq(contactWindows.id, wLowElev.id)));
    });
  });
});
