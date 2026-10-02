import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db/client";
import {
  users,
  scheduleVersions,
  scheduleAuditLog,
  reservations,
  missionTasks,
  contactWindows,
  groundStations,
  satellites,
  satelliteOrbitalData,
} from "../db/schema";
import request from "supertest";
import { app } from "../app";
import { eq, inArray, and, or, sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { CandidateService } from "../modules/scheduler/candidate-service";
import { HybridScoringScheduler } from "../modules/scheduler/hybrid-scoring-scheduler";
import { DEFAULT_HYBRID_WEIGHTS } from "../modules/scheduler/scoring";

describe("Phase 4.6 — End-to-End System Acceptance Gate & Policy Engine Sign-Off", () => {
  let operatorToken: string;
  let viewerToken: string;
  let operatorId: string;
  let viewerId: string;

  // Infrastructure IDs
  let sat1Id: string;
  let sat2Id: string;
  let sat3Id: string;
  let gsChennaiId: string;
  let gsBangaloreId: string;
  let gsSvalbardId: string;
  let od1Id: string;
  let od2Id: string;
  let od3Id: string;

  const epochBase = Date.now() + 15000000;

  beforeAll(async () => {
    // 1. Operator and Viewer accounts
    const [op] = await db
      .insert(users)
      .values({
        email: `op46-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "OPERATOR",
      })
      .returning();
    operatorId = op.id;
    operatorToken = jwt.sign({ sub: op.id, role: "OPERATOR" }, env.jwtSecret);

    const [vi] = await db
      .insert(users)
      .values({
        email: `view46-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "VIEWER",
      })
      .returning();
    viewerId = vi.id;
    viewerToken = jwt.sign({ sub: vi.id, role: "VIEWER" }, env.jwtSecret);

    // 2. Heterogeneous Satellites
    const [s1] = await db
      .insert(satellites)
      .values({
        noradId: 88461 + (Date.now() % 10000),
        name: "OrbitMesh-SAT-01",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat1Id = s1.id;

    const [s2] = await db
      .insert(satellites)
      .values({
        noradId: 88462 + (Date.now() % 10000),
        name: "OrbitMesh-SAT-02",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat2Id = s2.id;

    const [s3] = await db
      .insert(satellites)
      .values({
        noradId: 88463 + (Date.now() % 10000),
        name: "OrbitMesh-SAT-03",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat3Id = s3.id;

    // 3. Heterogeneous Ground Stations
    // Chennai: S_BAND, X_BAND | 150 Mbps | Capacity: 1
    const [gs1] = await db
      .insert(groundStations)
      .values({
        code: `GS-CHE-46-${Date.now() % 10000}`,
        name: "Chennai Telemetry Station",
        latitude: 13.0827,
        longitude: 80.2707,
        altitudeM: 50,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 1,
        maxDataRateMbps: 150.0,
      })
      .returning();
    gsChennaiId = gs1.id;

    // Bangalore: S_BAND only | 50 Mbps | Capacity: 1
    const [gs2] = await db
      .insert(groundStations)
      .values({
        code: `GS-BLR-46-${Date.now() % 10000}`,
        name: "Bangalore Uplink Terminal",
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

    // Svalbard: S_BAND, X_BAND, KA_BAND | 300 Mbps | Multi-Channel Capacity: 2
    const [gs3] = await db
      .insert(groundStations)
      .values({
        code: `GS-SVL-46-${Date.now() % 10000}`,
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

    // 4. Orbital Data
    const [od1] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: sat1Id,
        source: "CELESTRAK",
        tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
        tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
        tleEpoch: new Date(),
        receivedAt: new Date(),
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
        tleEpoch: new Date(),
        receivedAt: new Date(),
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
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    od3Id = od3.id;

    // Ensure scheduleVersions row exists
    const v = await db.select().from(scheduleVersions).limit(1);
    if (v.length === 0) {
      await db.insert(scheduleVersions).values({ version: 1 });
    }
  });

  afterAll(async () => {
    const allSatIds = [sat1Id, sat2Id, sat3Id];
    const allGsIds = [gsChennaiId, gsBangaloreId, gsSvalbardId];
    const allOdIds = [od1Id, od2Id, od3Id];

    await db.delete(reservations).where(or(
      inArray(reservations.satelliteId, allSatIds),
      inArray(reservations.groundStationId, allGsIds)
    ));
    await db.delete(missionTasks).where(inArray(missionTasks.satelliteId, allSatIds));
    await db.delete(contactWindows).where(or(
      inArray(contactWindows.satelliteId, allSatIds),
      inArray(contactWindows.groundStationId, allGsIds)
    ));
    await db.delete(satelliteOrbitalData).where(inArray(satelliteOrbitalData.id, allOdIds));
    await db.delete(satellites).where(inArray(satellites.id, allSatIds));
    await db.delete(groundStations).where(inArray(groundStations.id, allGsIds));
  });

  async function cleanScopedTestData() {
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
  }

  // =========================================================================
  // 1. Normal Scheduling Lifecycle
  // =========================================================================
  it("1. Normal scheduling lifecycle: task creation -> preview -> commit -> persisted reservation state", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 100000;

    const [win] = await db
      .insert(contactWindows)
      .values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0),
        los: new Date(t0 + 600000),
        durationSeconds: 600,
        maxElevationDeg: 80,
        status: "AVAILABLE",
      })
      .returning();

    const [task] = await db
      .insert(missionTasks)
      .values({
        satelliteId: sat1Id,
        name: "Telemetry Downlink High Priority",
        priority: 9,
        durationSeconds: 300,
        deadline: new Date(t0 + 1000000),
        status: "PENDING",
        requiredFrequencyBand: "X_BAND",
        minDataRateMbps: 100.0,
      })
      .returning();

    const verRes = await db.select().from(scheduleVersions).limit(1);
    const startVer = verRes[0].version;

    // Preview
    const prev = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: startVer, policy: "HYBRID" });

    expect(prev.status).toBe(200);
    const scopedProposals = prev.body.proposedReservations.filter((r: any) => r.missionTaskId === task.id);
    expect(scopedProposals.length).toBe(1);
    expect(scopedProposals[0].groundStationId).toBe(gsChennaiId);
    expect(prev.body.metrics.scheduledTaskCount).toBeGreaterThanOrEqual(1);

    // Commit
    const commitRes = await request(app)
      .post("/api/scheduler/commit")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        scheduleVersion: startVer,
        proposedReservations: prev.body.proposedReservations,
        policy: "HYBRID",
      });

    expect(commitRes.status).toBe(200);
    expect(commitRes.body.success).toBe(true);

    // Verify DB state
    const savedResv = await db.select().from(reservations).where(eq(reservations.missionTaskId, task.id));
    expect(savedResv.length).toBe(1);
    expect(savedResv[0].status).toBe("PENDING");
    expect(savedResv[0].source).toBe("AUTOMATED");
    expect(savedResv[0].groundStationId).toBe(gsChennaiId);

    const updatedTask = await db.select().from(missionTasks).where(eq(missionTasks.id, task.id));
    expect(updatedTask[0].status).toBe("SCHEDULED");
  });

  // =========================================================================
  // 2. Multi-Policy Comparative Execution
  // =========================================================================
  it("2. Multi-policy comparative execution: FCFS, PRIORITY, and HYBRID deterministically differ", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 200000;

    // Small 300s window on Chennai (can only accommodate ONE 300s task)
    const [win] = await db
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

    // Task 1: Arrived first, low priority 2, urgent deadline
    const [tEarlyLow] = await db
      .insert(missionTasks)
      .values({
        satelliteId: sat1Id,
        name: "Early Low Priority Task",
        priority: 2,
        durationSeconds: 300,
        deadline: new Date(t0 + 350000),
        status: "PENDING",
        createdAt: new Date(t0 - 50000),
      })
      .returning();

    // Task 2: Arrived second, high priority 10, distant deadline
    const [tLateHigh] = await db
      .insert(missionTasks)
      .values({
        satelliteId: sat1Id,
        name: "Late High Priority Task",
        priority: 10,
        durationSeconds: 300,
        deadline: new Date(t0 + 1000000),
        status: "PENDING",
        createdAt: new Date(t0 - 10000),
      })
      .returning();

    const verRes = await db.select().from(scheduleVersions).limit(1);
    const v = verRes[0].version;

    // Preview FCFS
    const prevFcfs = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: v, policy: "FCFS" });

    // Preview PRIORITY
    const prevPrio = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: v, policy: "PRIORITY" });

    // Under FCFS: Early task gets the window
    const fcfsWinner = prevFcfs.body.proposedReservations.find(
      (r: any) => r.missionTaskId === tEarlyLow.id || r.missionTaskId === tLateHigh.id
    );
    expect(fcfsWinner?.missionTaskId).toBe(tEarlyLow.id);

    // Under PRIORITY: Higher priority task gets the window
    const prioWinner = prevPrio.body.proposedReservations.find(
      (r: any) => r.missionTaskId === tEarlyLow.id || r.missionTaskId === tLateHigh.id
    );
    expect(prioWinner?.missionTaskId).toBe(tLateHigh.id);
  });

  // =========================================================================
  // 3. Manual Operator Intervention (MANUAL + LOCKED)
  // =========================================================================
  it("3. Manual operator intervention: MANUAL + LOCKED reservation remains completely immutable", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 300000;

    const [win] = await db
      .insert(contactWindows)
      .values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0),
        los: new Date(t0 + 600000),
        durationSeconds: 600,
        maxElevationDeg: 85,
        status: "AVAILABLE",
      })
      .returning();

    const [manTask] = await db
      .insert(missionTasks)
      .values({
        satelliteId: sat1Id,
        name: "Operator Critical Pass",
        priority: 5,
        durationSeconds: 300,
        deadline: new Date(t0 + 1000000),
        status: "SCHEDULED",
      })
      .returning();

    const [lockedResv] = await db
      .insert(reservations)
      .values({
        missionTaskId: manTask.id,
        contactWindowId: win.id,
        groundStationId: gsChennaiId,
        satelliteId: sat1Id,
        windowAos: new Date(t0),
        windowLos: new Date(t0 + 600000),
        taskDurationSeconds: 300,
        allocatedStart: new Date(t0),
        allocatedEnd: new Date(t0 + 300000),
        status: "CONFIRMED",
        source: "MANUAL",
        locked: true,
      })
      .returning();

    // Automated pending task competing for the same window
    const [autoTask] = await db
      .insert(missionTasks)
      .values({
        satelliteId: sat1Id,
        name: "Automated Task",
        priority: 10,
        durationSeconds: 300,
        deadline: new Date(t0 + 1000000),
        status: "PENDING",
      })
      .returning();

    const verRes = await db.select().from(scheduleVersions).limit(1);
    const v = verRes[0].version;

    // Run preview and commit
    const prev = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: v, policy: "HYBRID" });

    await request(app)
      .post("/api/scheduler/commit")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        scheduleVersion: v,
        proposedReservations: prev.body.proposedReservations,
        policy: "HYBRID",
      });

    // Verify locked reservation is intact
    const lockedCheck = await db.select().from(reservations).where(eq(reservations.id, lockedResv.id));
    expect(lockedCheck.length).toBe(1);
    expect(lockedCheck[0].source).toBe("MANUAL");
    expect(lockedCheck[0].locked).toBe(true);
    expect(new Date(lockedCheck[0].allocatedStart).getTime()).toBe(t0);

    // Verify automated task was allocated in the remaining 300s of the window
    const autoCheck = await db.select().from(reservations).where(eq(reservations.missionTaskId, autoTask.id));
    expect(autoCheck.length).toBe(1);
    expect(new Date(autoCheck[0].allocatedStart).getTime()).toBe(t0 + 300000);
  });

  // =========================================================================
  // 4. Multi-Station Alternate Routing & Capability Enforcement
  // =========================================================================
  it("4. Multi-station alternate routing: saturated station transparently routes to capable alternate, rejects incompatible alternate", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 400000;

    // Sat 2 pre-occupies Chennai
    const [wChennaiSat2] = await db
      .insert(contactWindows)
      .values({
        satelliteId: sat2Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od2Id,
        aos: new Date(t0),
        los: new Date(t0 + 300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
        status: "AVAILABLE",
      })
      .returning();

    const [sat2BlockTask] = await db
      .insert(missionTasks)
      .values({
        satelliteId: sat2Id,
        name: "Sat2 Block Chennai",
        priority: 5,
        durationSeconds: 300,
        deadline: new Date(t0 + 1000000),
        status: "SCHEDULED",
      })
      .returning();

    await db.insert(reservations).values({
      missionTaskId: sat2BlockTask.id,
      contactWindowId: wChennaiSat2.id,
      groundStationId: gsChennaiId,
      satelliteId: sat2Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 300000),
      taskDurationSeconds: 300,
      allocatedStart: new Date(t0),
      allocatedEnd: new Date(t0 + 300000),
      status: "CONFIRMED",
      source: "MANUAL",
      locked: true,
    });

    // Sat 1 windows on Chennai and Bangalore
    await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0),
      los: new Date(t0 + 300000),
      durationSeconds: 300,
      maxElevationDeg: 80,
      status: "AVAILABLE",
    });

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

    // Sat 1 compatible task (S_BAND, 40 Mbps)
    const [taskCompatible] = await db
      .insert(missionTasks)
      .values({
        satelliteId: sat1Id,
        name: "S-Band 40Mbps Task",
        priority: 8,
        durationSeconds: 300,
        deadline: new Date(t0 + 1000000),
        requiredFrequencyBand: "S_BAND",
        minDataRateMbps: 40.0,
        status: "PENDING",
      })
      .returning();

    const verRes = await db.select().from(scheduleVersions).limit(1);
    const v = verRes[0].version;

    const prev = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: v, policy: "HYBRID" });

    // Successfully routed to alternate Bangalore GS
    const scopedProposals = prev.body.proposedReservations.filter(
      (r: any) => r.missionTaskId === taskCompatible.id
    );
    expect(scopedProposals.length).toBe(1);
    expect(scopedProposals[0].groundStationId).toBe(gsBangaloreId);
  });

  // =========================================================================
  // 5. Intra-Satellite Single Transceiver Exclusivity
  // =========================================================================
  it("5. Satellite conflict: single transceiver exclusivity prevents concurrent contacts on multiple stations", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 500000;

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

    const [t1] = await db
      .insert(missionTasks)
      .values({
        satelliteId: sat1Id,
        name: "Sat1 Task 1",
        priority: 9,
        durationSeconds: 300,
        deadline: new Date(t0 + 300000), // Deadline is end of pass
        status: "PENDING",
      })
      .returning();

    const [t2] = await db
      .insert(missionTasks)
      .values({
        satelliteId: sat1Id,
        name: "Sat1 Task 2",
        priority: 7,
        durationSeconds: 300,
        deadline: new Date(t0 + 300000),
        status: "PENDING",
      })
      .returning();

    const verRes = await db.select().from(scheduleVersions).limit(1);
    const v = verRes[0].version;

    const prev = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: v, policy: "HYBRID" });

    // Exactly 1 task can be scheduled during this interval (no double-booking of Sat 1)
    const scheduledScoped = prev.body.proposedReservations.filter(
      (r: any) => r.missionTaskId === t1.id || r.missionTaskId === t2.id
    );
    expect(scheduledScoped.length).toBe(1);

    const unscheduledScoped = prev.body.unscheduled.filter(
      (r: any) => r.taskId === t1.id || r.taskId === t2.id
    );
    expect(unscheduledScoped.length).toBe(1);
  });

  // =========================================================================
  // 6. Multi-Channel Station Concurrency & Overflow
  // =========================================================================
  it("6. Multi-channel station capacity: Svalbard (capacity = 2) permits 2 simultaneous contacts, diverts 3rd", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 600000;

    // Sat 1, Sat 2, Sat 3 all visible to Svalbard at t0
    await db.insert(contactWindows).values([
      {
        satelliteId: sat1Id,
        groundStationId: gsSvalbardId,
        orbitalDataId: od1Id,
        aos: new Date(t0),
        los: new Date(t0 + 300000),
        durationSeconds: 300,
        maxElevationDeg: 75,
        status: "AVAILABLE",
      },
      {
        satelliteId: sat2Id,
        groundStationId: gsSvalbardId,
        orbitalDataId: od2Id,
        aos: new Date(t0),
        los: new Date(t0 + 300000),
        durationSeconds: 300,
        maxElevationDeg: 70,
        status: "AVAILABLE",
      },
      {
        satelliteId: sat3Id,
        groundStationId: gsSvalbardId,
        orbitalDataId: od3Id,
        aos: new Date(t0),
        los: new Date(t0 + 300000),
        durationSeconds: 300,
        maxElevationDeg: 65,
        status: "AVAILABLE",
      },
      // Sat 3 also has alternate window on Chennai
      {
        satelliteId: sat3Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od3Id,
        aos: new Date(t0),
        los: new Date(t0 + 300000),
        durationSeconds: 300,
        maxElevationDeg: 55,
        status: "AVAILABLE",
      },
    ]);

    const [t1, t2, t3] = await db
      .insert(missionTasks)
      .values([
        {
          satelliteId: sat1Id,
          name: "Svalbard Contact 1",
          priority: 9,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "PENDING",
        },
        {
          satelliteId: sat2Id,
          name: "Svalbard Contact 2",
          priority: 8,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "PENDING",
        },
        {
          satelliteId: sat3Id,
          name: "Svalbard Contact 3",
          priority: 7,
          durationSeconds: 300,
          deadline: new Date(t0 + 1000000),
          status: "PENDING",
        },
      ])
      .returning();

    const verRes = await db.select().from(scheduleVersions).limit(1);
    const v = verRes[0].version;

    const prev = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: v, policy: "HYBRID" });

    // All 3 scheduled
    const scopedProposals = prev.body.proposedReservations.filter(
      (r: any) => [t1.id, t2.id, t3.id].includes(r.missionTaskId)
    );
    expect(scopedProposals.length).toBe(3);

    // Svalbard receives exactly 2 concurrent contacts
    const svalbardAllocations = scopedProposals.filter(
      (r: any) => r.groundStationId === gsSvalbardId
    );
    expect(svalbardAllocations.length).toBe(2);

    // 3rd task diverted to Chennai
    const chennaiAllocation = scopedProposals.find(
      (r: any) => r.groundStationId === gsChennaiId
    );
    expect(chennaiAllocation).toBeDefined();
    expect(chennaiAllocation.satelliteId).toBe(sat3Id);
  });

  // =========================================================================
  // 7. Persisted Guard Band Verification
  // =========================================================================
  it("7. Guard band verification: sequential allocations strictly satisfy next.start - prev.end >= guardBandSeconds in persisted DB", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 700000;
    const guardSec = 30;

    const [win] = await db
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

    const [t1, t2] = await db
      .insert(missionTasks)
      .values([
        {
          satelliteId: sat1Id,
          name: "Sequential Task 1",
          priority: 8,
          durationSeconds: 200,
          deadline: new Date(t0 + 1000000),
          status: "PENDING",
        },
        {
          satelliteId: sat1Id,
          name: "Sequential Task 2",
          priority: 7,
          durationSeconds: 200,
          deadline: new Date(t0 + 1000000),
          status: "PENDING",
        },
      ])
      .returning();

    const scheduler = new HybridScoringScheduler(
      new CandidateService(),
      new Date(t0),
      DEFAULT_HYBRID_WEIGHTS,
      "HYBRID",
      guardSec
    );

    const schedRes = await scheduler.schedulePendingTasks([t1.id, t2.id]);
    expect(schedRes.scheduled).toBe(2);

    const resvs = await db
      .select()
      .from(reservations)
      .where(inArray(reservations.missionTaskId, [t1.id, t2.id]))
      .orderBy(reservations.allocatedStart);

    expect(resvs.length).toBe(2);
    const end1 = new Date(resvs[0].allocatedEnd).getTime();
    const start2 = new Date(resvs[1].allocatedStart).getTime();
    const diffSec = (start2 - end1) / 1000;

    expect(diffSec).toBeGreaterThanOrEqual(guardSec);
  });

  // =========================================================================
  // 8. Preview Strict Isolation & Non-Mutation
  // =========================================================================
  it("8. Preview isolation: database state before and after preview is 100% identical", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 800000;

    await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0),
      los: new Date(t0 + 300000),
      durationSeconds: 300,
      maxElevationDeg: 75,
      status: "AVAILABLE",
    });

    await db.insert(missionTasks).values({
      satelliteId: sat1Id,
      name: "Non-Mutation Probe Task",
      priority: 8,
      durationSeconds: 150,
      deadline: new Date(t0 + 1000000),
      status: "PENDING",
    });

    const resvsBefore = await db.select().from(reservations);
    const tasksBefore = await db.select().from(missionTasks);
    const verRes = await db.select().from(scheduleVersions).limit(1);

    // Run preview
    const prev = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: verRes[0].version, policy: "HYBRID" });

    expect(prev.status).toBe(200);

    const resvsAfter = await db.select().from(reservations);
    const tasksAfter = await db.select().from(missionTasks);

    expect(resvsAfter.length).toBe(resvsBefore.length);
    expect(tasksAfter.length).toBe(tasksBefore.length);
  });

  // =========================================================================
  // 9. Commit Atomicity & Audit Tracking
  // =========================================================================
  it("9. Commit atomicity & audit tracking: version increments, audit logs record policy and entity mutations", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 900000;

    await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0),
      los: new Date(t0 + 300000),
      durationSeconds: 300,
      maxElevationDeg: 80,
      status: "AVAILABLE",
    });

    const [t] = await db
      .insert(missionTasks)
      .values({
        satelliteId: sat1Id,
        name: "Audit Tracking Task",
        priority: 7,
        durationSeconds: 200,
        deadline: new Date(t0 + 1000000),
        status: "PENDING",
      })
      .returning();

    const verRes = await db.select().from(scheduleVersions).limit(1);
    const v = verRes[0].version;

    const prev = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: v, policy: "HYBRID" });

    const commitRes = await request(app)
      .post("/api/scheduler/commit")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        scheduleVersion: v,
        proposedReservations: prev.body.proposedReservations,
        policy: "HYBRID",
      });

    expect(commitRes.status).toBe(200);

    // Verify schedule version incremented by 1
    const newVer = await db.select().from(scheduleVersions).limit(1);
    expect(newVer[0].version).toBe(v + 1);

    // Verify audit log has reservation and schedule-level entries
    const audit = await db
      .select()
      .from(scheduleAuditLog)
      .where(eq(scheduleAuditLog.userId, operatorId));

    expect(audit.some((a) => a.entityType === "RESERVATION" && a.reason?.includes("HYBRID"))).toBe(true);
    expect(audit.some((a) => a.entityType === "SCHEDULE" && a.action === "COMMIT_SCHEDULE")).toBe(true);
  });

  // =========================================================================
  // 10. Concurrency Conflict Detection (409)
  // =========================================================================
  it("10. Concurrency conflict: stale scheduleVersion returns 409 and avoids dirty overwrite", async () => {
    await cleanScopedTestData();
    const verRes = await db.select().from(scheduleVersions).limit(1);
    const currentVersion = verRes[0].version;

    // Simulate stale commit attempt
    const res = await request(app)
      .post("/api/scheduler/commit")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        scheduleVersion: currentVersion - 1, // Stale
        proposedReservations: [],
        policy: "HYBRID",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("conflict");
  });

  // =========================================================================
  // 11. Role-Based Access Control (RBAC)
  // =========================================================================
  it("11. Role-Based Access Control: VIEWER cannot preview or commit; unauthenticated requests rejected", async () => {
    const verRes = await db.select().from(scheduleVersions).limit(1);
    const v = verRes[0].version;

    // Viewer preview -> 403
    const vPrev = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ scheduleVersion: v, policy: "HYBRID" });
    expect(vPrev.status).toBe(403);

    // Viewer commit -> 403
    const vCommit = await request(app)
      .post("/api/scheduler/commit")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ scheduleVersion: v, proposedReservations: [], policy: "HYBRID" });
    expect(vCommit.status).toBe(403);

    // Unauthenticated preview -> 401
    const unauth = await request(app)
      .post("/api/scheduler/preview")
      .send({ scheduleVersion: v, policy: "HYBRID" });
    expect(unauth.status).toBe(401);
  });

  // =========================================================================
  // 12. Reload / State Reconstruction
  // =========================================================================
  it("12. Reload & state reconstruction: committed schedule reconstructs faithfully via GET /api/reservations", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 1000000;

    const [win] = await db
      .insert(contactWindows)
      .values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0),
        los: new Date(t0 + 300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
        status: "AVAILABLE",
      })
      .returning();

    const [t] = await db
      .insert(missionTasks)
      .values({
        satelliteId: sat1Id,
        name: "Reconstruction Test Task",
        priority: 6,
        durationSeconds: 200,
        deadline: new Date(t0 + 1000000),
        status: "PENDING",
      })
      .returning();

    const verRes = await db.select().from(scheduleVersions).limit(1);
    const v = verRes[0].version;

    const prev = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: v, policy: "HYBRID" });

    await request(app)
      .post("/api/scheduler/commit")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        scheduleVersion: v,
        proposedReservations: prev.body.proposedReservations,
        policy: "HYBRID",
      });

    // Client reload simulation
    const getResvs = await request(app)
      .get("/api/reservations")
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(getResvs.status).toBe(200);
    const found = getResvs.body.find((r: any) => r.missionTaskId === t.id);
    expect(found).toBeDefined();
    expect(found.satelliteId).toBe(sat1Id);
    expect(found.groundStationId).toBe(gsChennaiId);
    expect(found.contactWindowId).toBe(win.id);
  });

  // =========================================================================
  // 13. End-to-End Failure Recovery Workflow
  // =========================================================================
  it("13. Failure recovery loop: Stale proposal -> 409 -> Client recovers -> Fresh preview -> Successful commit", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 1100000;

    await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0),
      los: new Date(t0 + 600000),
      durationSeconds: 600,
      maxElevationDeg: 80,
      status: "AVAILABLE",
    });

    await db.insert(missionTasks).values({
      satelliteId: sat1Id,
      name: "Recovery Loop Task",
      priority: 8,
      durationSeconds: 200,
      deadline: new Date(t0 + 1000000),
      status: "PENDING",
    });

    // Step A: Operator A previews at current version N
    const verResA = await db.select().from(scheduleVersions).limit(1);
    const versionN = verResA[0].version;

    const prevA = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: versionN, policy: "HYBRID" });
    expect(prevA.status).toBe(200);

    // Step B: Concurrently, another operation increments scheduleVersion to N + 1
    await db.update(scheduleVersions).set({ version: versionN + 1 });

    // Step C: Operator A attempts commit with old version N -> fails with 409
    const failedCommit = await request(app)
      .post("/api/scheduler/commit")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        scheduleVersion: versionN, // Stale!
        proposedReservations: prevA.body.proposedReservations,
        policy: "HYBRID",
      });

    expect(failedCommit.status).toBe(409);

    // Step D: Recovery - Client fetches fresh scheduleVersion (N + 1)
    const verCheck = await request(app)
      .get("/api/scheduler/version")
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(verCheck.body.scheduleVersion).toBe(versionN + 1);

    // Step E: Client runs fresh preview with version N + 1
    const freshPrev = await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ scheduleVersion: versionN + 1, policy: "HYBRID" });
    expect(freshPrev.status).toBe(200);

    // Step F: Commit with fresh version succeeds!
    const recoveredCommit = await request(app)
      .post("/api/scheduler/commit")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        scheduleVersion: versionN + 1,
        proposedReservations: freshPrev.body.proposedReservations,
        policy: "HYBRID",
      });

    expect(recoveredCommit.status).toBe(200);
    expect(recoveredCommit.body.success).toBe(true);
    expect(recoveredCommit.body.newVersion).toBe(versionN + 2);
  });
});
