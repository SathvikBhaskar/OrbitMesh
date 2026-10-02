import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { eq, inArray, desc } from "drizzle-orm";
import { app } from "../app";
import { db } from "../db/client";
import {
  users,
  satellites,
  groundStations,
  satelliteOrbitalData,
  contactWindows,
  missionTasks,
  reservations,
  scheduleVersions,
  executionTelemetryEvents,
} from "../db/schema";
import { env } from "../config/env";
import { executionService } from "../modules/execution/execution.service";
import { InboundExecutionEvent } from "../modules/execution/execution.types";

describe("Phase 5.5 — Operational Execution Awareness, Telemetry Bridge & Contract Reconciliation", () => {
  let operatorId: string;
  let operatorToken: string;
  let viewerId: string;
  let viewerToken: string;

  let sat1Id: string;
  let sat2Id: string;
  let gsChennaiId: string;
  let gsBangaloreId: string;
  let od1Id: string;
  let od2Id: string;

  const epochBase = Date.now() + 500000000;

  beforeAll(async () => {
    // 1. Operator and Viewer users
    const [op] = await db
      .insert(users)
      .values({
        email: `op55-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "OPERATOR",
      })
      .returning();
    operatorId = op.id;
    operatorToken = jwt.sign({ sub: op.id, role: "OPERATOR" }, env.jwtSecret);

    const [vi] = await db
      .insert(users)
      .values({
        email: `view55-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "VIEWER",
      })
      .returning();
    viewerId = vi.id;
    viewerToken = jwt.sign({ sub: vi.id, role: "VIEWER" }, env.jwtSecret);

    // 2. Satellites
    const [s1] = await db
      .insert(satellites)
      .values({
        noradId: 92551 + (Date.now() % 10000),
        name: "Sat-55-Exec-Alpha",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat1Id = s1.id;

    const [s2] = await db
      .insert(satellites)
      .values({
        noradId: 92552 + (Date.now() % 10000),
        name: "Sat-55-Exec-Beta",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat2Id = s2.id;

    // 3. Ground Stations
    const [gs1] = await db
      .insert(groundStations)
      .values({
        code: `GS-CHE-55-${Date.now() % 10000}`,
        name: "Chennai Exec Telemetry Station",
        latitude: 13.0827,
        longitude: 80.2707,
        altitudeM: 15,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 2,
        maxDataRateMbps: 300,
      })
      .returning();
    gsChennaiId = gs1.id;

    const [gs2] = await db
      .insert(groundStations)
      .values({
        code: `GS-BLR-55-${Date.now() % 10000}`,
        name: "Bangalore Exec Telemetry Station",
        latitude: 12.9716,
        longitude: 77.5946,
        altitudeM: 920,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 2,
        maxDataRateMbps: 300,
      })
      .returning();
    gsBangaloreId = gs2.id;

    // 4. Orbital Ephemeris
    const [od1] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: sat1Id,
        source: "CELESTRAK",
        tleLine1: "1 92551U 26001A   26270.00000000  .00000000  00000-0  00000-0 0  9991",
        tleLine2: "2 92551  97.5000 120.0000 0010000  60.0000 300.0000 15.10000000    11",
        tleEpoch: new Date("2026-10-01T00:00:00Z"),
        receivedAt: new Date(),
      })
      .returning();
    od1Id = od1.id;

    const [od2] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: sat2Id,
        source: "CELESTRAK",
        tleLine1: "1 92552U 26001B   26270.00000000  .00000000  00000-0  00000-0 0  9992",
        tleLine2: "2 92552  97.5000 125.0000 0010000  65.0000 305.0000 15.10000000    12",
        tleEpoch: new Date("2026-10-01T00:00:00Z"),
        receivedAt: new Date(),
      })
      .returning();
    od2Id = od2.id;

    // Seed schedule versions if empty
    const versions = await db.select().from(scheduleVersions);
    if (versions.length === 0) {
      await db.insert(scheduleVersions).values({ version: 1 });
    }
  });

  afterAll(async () => {
    await db.delete(executionTelemetryEvents);
    await db.delete(reservations).where(inArray(reservations.satelliteId, [sat1Id, sat2Id]));
    await db.delete(missionTasks).where(inArray(missionTasks.satelliteId, [sat1Id, sat2Id]));
    await db.delete(contactWindows).where(inArray(contactWindows.satelliteId, [sat1Id, sat2Id]));
    await db.delete(satelliteOrbitalData).where(inArray(satelliteOrbitalData.satelliteId, [sat1Id, sat2Id]));
    await db.delete(satellites).where(inArray(satellites.id, [sat1Id, sat2Id]));
    await db.delete(groundStations).where(inArray(groundStations.id, [gsChennaiId, gsBangaloreId]));
    await db.delete(users).where(inArray(users.id, [operatorId, viewerId]));
  });

  async function cleanScopedTestData() {
    await db.delete(executionTelemetryEvents);
    await db.delete(reservations).where(inArray(reservations.satelliteId, [sat1Id, sat2Id]));
    await db.delete(missionTasks).where(inArray(missionTasks.satelliteId, [sat1Id, sat2Id]));
    await db.delete(contactWindows).where(inArray(contactWindows.satelliteId, [sat1Id, sat2Id]));
  }

  // =========================================================================
  // WORKSTREAM 5.5.1: Execution Contract & State Machine
  // =========================================================================
  describe("5.5.1 — Execution Contract & State Machine", () => {
    it("1. Scenario 1: Nominal Downlink Pass transitions cleanly from SCHEDULED to COMPLETED", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 100000;

      const [win] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Nominal Pass Task",
        priority: 6,
        durationSeconds: 200,
        deadline: new Date(t0 + 5000000),
        status: "SCHEDULED",
        targetBytes: 1000000000,
        fulfilledBytes: 0,
        remainingBytes: 1000000000,
      }).returning();

      const [res] = await db.insert(reservations).values({
        missionTaskId: task.id,
        contactWindowId: win.id,
        groundStationId: gsChennaiId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 1000000),
        windowLos: new Date(t0 + 1300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 1000000),
        allocatedEnd: new Date(t0 + 1200000),
        status: "CONFIRMED",
        executionState: "SCHEDULED",
        bytesTransferred: 0,
      }).returning();

      // Step 1: Outbound Dispatch
      const manifest = await executionService.generateDispatchManifest(res.id, new Date(t0 + 900000));
      expect(manifest.dispatchId).toBeDefined();
      expect(manifest.reservationId).toBe(res.id);

      const [resDispatched] = await db.select().from(reservations).where(eq(reservations.id, res.id));
      expect(resDispatched.executionState).toBe("EXECUTION_READY");
      expect(resDispatched.activeDispatchId).toBe(manifest.dispatchId);

      // Step 2: Ground ACK
      const ackRes = await executionService.ingestExecutionTelemetry({
        eventId: crypto.randomUUID(),
        reservationId: res.id,
        dispatchId: manifest.dispatchId,
        eventType: "DISPATCH_ACK",
        sourceTimestamp: new Date(t0 + 950000).toISOString(),
        sequenceNumber: 1,
        idempotencyKey: `ack-${manifest.dispatchId}`,
        payload: {
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
        },
      });
      expect(ackRes.newState).toBe("DISPATCHED");

      // Step 3: Carrier Lock (AOS)
      const aosRes = await executionService.ingestExecutionTelemetry({
        eventId: crypto.randomUUID(),
        reservationId: res.id,
        dispatchId: manifest.dispatchId,
        eventType: "AOS_ACQUIRED",
        sourceTimestamp: new Date(t0 + 1000000).toISOString(),
        sequenceNumber: 2,
        idempotencyKey: `aos-${manifest.dispatchId}`,
        payload: {
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
          carrierLocked: true,
          snrDb: 18.5,
        },
      });
      expect(aosRes.newState).toBe("IN_PROGRESS");

      // Step 4: Downlink Data Streaming (Stats)
      const statsRes = await executionService.ingestExecutionTelemetry({
        eventId: crypto.randomUUID(),
        reservationId: res.id,
        dispatchId: manifest.dispatchId,
        eventType: "TELEMETRY_STATS",
        sourceTimestamp: new Date(t0 + 1100000).toISOString(),
        sequenceNumber: 3,
        idempotencyKey: `stats-${manifest.dispatchId}`,
        payload: {
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
          bytesTransferred: 500000000,
        },
      });
      expect(statsRes.newState).toBe("IN_PROGRESS");
      expect(statsRes.bytesTransferred).toBe(500000000);

      // Step 5: Clean LOS Terminated (100% target met)
      const losRes = await executionService.ingestExecutionTelemetry({
        eventId: crypto.randomUUID(),
        reservationId: res.id,
        dispatchId: manifest.dispatchId,
        eventType: "LOS_TERMINATED",
        sourceTimestamp: new Date(t0 + 1200000).toISOString(),
        sequenceNumber: 4,
        idempotencyKey: `los-${manifest.dispatchId}`,
        payload: {
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
          bytesTransferred: 1000000000,
        },
      });
      expect(losRes.newState).toBe("COMPLETED");

      // Verify DB Final State
      const [finalRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
      expect(finalRes.executionState).toBe("COMPLETED");
      expect(finalRes.status).toBe("COMPLETED");
      expect(finalRes.bytesTransferred).toBe(1000000000);

      const [finalTask] = await db.select().from(missionTasks).where(eq(missionTasks.id, task.id));
      expect(finalTask.status).toBe("COMPLETED");
      expect(finalTask.fulfilledBytes).toBe(1000000000);
      expect(finalTask.remainingBytes).toBe(0);
      expect(finalTask.targetBytes).toBe(1000000000);
    });
  });

  // =========================================================================
  // WORKSTREAM 5.5.2 & 5.5.3: Actuals, Multi-Pass Quotas & Provenance
  // =========================================================================
  describe("5.5.2 & 5.5.3 — Multi-Pass Quota Reconciliation & Provenance", () => {
    it("2. Scenario 2: Partial transfer preserves targetBytes and re-queues task with exact remaining demand", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 200000;

      // Initial task requiring 1,000,000,000 bytes (1 GB)
      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Multi-Pass Big File",
        priority: 7,
        durationSeconds: 200,
        deadline: new Date(t0 + 6000000),
        status: "SCHEDULED",
        targetBytes: 1000000000,
        fulfilledBytes: 0,
        remainingBytes: 1000000000,
      }).returning();

      // Window 1: Pass 1
      const [w1] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
      }).returning();

      const [res1] = await db.insert(reservations).values({
        missionTaskId: task.id,
        contactWindowId: w1.id,
        groundStationId: gsChennaiId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 1000000),
        windowLos: new Date(t0 + 1300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 1000000),
        allocatedEnd: new Date(t0 + 1200000),
        status: "CONFIRMED",
        executionState: "IN_PROGRESS",
        activeDispatchId: "disp-p1",
      }).returning();

      // Pass 1 ends prematurely at LOS with only 600 MB transferred
      const p1Result = await executionService.ingestExecutionTelemetry({
        eventId: crypto.randomUUID(),
        reservationId: res1.id,
        dispatchId: "disp-p1",
        eventType: "LOS_TERMINATED",
        sourceTimestamp: new Date(t0 + 1200000).toISOString(),
        sequenceNumber: 1,
        idempotencyKey: "p1-los",
        payload: {
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
          bytesTransferred: 600000000,
        },
      });

      expect(p1Result.newState).toBe("PARTIAL");
      expect(p1Result.hasSchedulingConsequence).toBe(true);

      // Verify Task Multi-Pass Accounting
      const [taskAfterP1] = await db.select().from(missionTasks).where(eq(missionTasks.id, task.id));
      expect(taskAfterP1.targetBytes).toBe(1000000000); // Immutable original requirement
      expect(taskAfterP1.fulfilledBytes).toBe(600000000);
      expect(taskAfterP1.remainingBytes).toBe(400000000);
      expect(taskAfterP1.status).toBe("PENDING"); // Re-queued for next window

      // Pass 2: Window 2 fulfills the remaining 400 MB
      const [w2] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsBangaloreId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 2000000),
        los: new Date(t0 + 2300000),
        durationSeconds: 300,
        maxElevationDeg: 75,
      }).returning();

      const [res2] = await db.insert(reservations).values({
        missionTaskId: task.id,
        contactWindowId: w2.id,
        groundStationId: gsBangaloreId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 2000000),
        windowLos: new Date(t0 + 2300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 2000000),
        allocatedEnd: new Date(t0 + 2200000),
        status: "CONFIRMED",
        executionState: "IN_PROGRESS",
        activeDispatchId: "disp-p2",
      }).returning();

      const p2Result = await executionService.ingestExecutionTelemetry({
        eventId: crypto.randomUUID(),
        reservationId: res2.id,
        dispatchId: "disp-p2",
        eventType: "LOS_TERMINATED",
        sourceTimestamp: new Date(t0 + 2200000).toISOString(),
        sequenceNumber: 1,
        idempotencyKey: "p2-los",
        payload: {
          groundStationId: gsBangaloreId,
          satelliteId: sat1Id,
          bytesTransferred: 400000000,
        },
      });

      expect(p2Result.newState).toBe("COMPLETED");

      // Verify Final Task Accounting
      const [finalTask] = await db.select().from(missionTasks).where(eq(missionTasks.id, task.id));
      expect(finalTask.targetBytes).toBe(1000000000);
      expect(finalTask.fulfilledBytes).toBe(1000000000);
      expect(finalTask.remainingBytes).toBe(0);
      expect(finalTask.status).toBe("COMPLETED");
    });

    it("3. Scenario 7: Duplicate telemetry is strictly idempotent with zero duplicate state transitions", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 300000;

      const [w] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Idempotency Test Task",
        priority: 5,
        durationSeconds: 200,
        deadline: new Date(t0 + 5000000),
        status: "SCHEDULED",
      }).returning();

      const [res] = await db.insert(reservations).values({
        missionTaskId: task.id,
        contactWindowId: w.id,
        groundStationId: gsChennaiId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 1000000),
        windowLos: new Date(t0 + 1300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 1000000),
        allocatedEnd: new Date(t0 + 1200000),
        status: "CONFIRMED",
        executionState: "DISPATCHED",
        activeDispatchId: "disp-idemp",
      }).returning();

      const eventInput: InboundExecutionEvent = {
        eventId: crypto.randomUUID(),
        reservationId: res.id,
        dispatchId: "disp-idemp",
        eventType: "AOS_ACQUIRED",
        sourceTimestamp: new Date(t0 + 1000000).toISOString(),
        sequenceNumber: 1,
        idempotencyKey: `idemp-key-${Date.now()}`,
        payload: {
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
        },
      };

      // Ingest once
      const first = await executionService.ingestExecutionTelemetry(eventInput);
      expect(first.newState).toBe("IN_PROGRESS");

      // Ingest duplicate 5 times in parallel
      const duplicates = await Promise.all(
        Array(5).fill(null).map(() => executionService.ingestExecutionTelemetry(eventInput))
      );

      for (const d of duplicates) {
        expect(d.newState).toBe("IN_PROGRESS");
        expect(d.bytesTransferred).toBe(first.bytesTransferred);
      }

      // Confirm only 1 event record in ledger
      const auditRecords = await db
        .select()
        .from(executionTelemetryEvents)
        .where(eq(executionTelemetryEvents.idempotencyKey, eventInput.idempotencyKey));
      expect(auditRecords.length).toBe(1);
    });

    it("4. Scenario 8: Out-of-order telemetry preserves monotonic max byte count without regression", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 400000;

      const [w] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Monotonicity Task",
        priority: 5,
        durationSeconds: 200,
        deadline: new Date(t0 + 5000000),
        status: "SCHEDULED",
      }).returning();

      const [res] = await db.insert(reservations).values({
        missionTaskId: task.id,
        contactWindowId: w.id,
        groundStationId: gsChennaiId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 1000000),
        windowLos: new Date(t0 + 1300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 1000000),
        allocatedEnd: new Date(t0 + 1200000),
        status: "CONFIRMED",
        executionState: "IN_PROGRESS",
        activeDispatchId: "disp-mono",
        bytesTransferred: 0,
      }).returning();

      // Later packet arrives first (500 MB)
      await executionService.ingestExecutionTelemetry({
        eventId: crypto.randomUUID(),
        reservationId: res.id,
        dispatchId: "disp-mono",
        eventType: "TELEMETRY_STATS",
        sourceTimestamp: new Date(t0 + 1150000).toISOString(),
        sequenceNumber: 10,
        idempotencyKey: `stats-500mb-${Date.now()}`,
        payload: {
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
          bytesTransferred: 500000000,
        },
      });

      const [resAfterFirst] = await db.select().from(reservations).where(eq(reservations.id, res.id));
      expect(resAfterFirst.bytesTransferred).toBe(500000000);

      // Delayed earlier packet arrives later (300 MB)
      await executionService.ingestExecutionTelemetry({
        eventId: crypto.randomUUID(),
        reservationId: res.id,
        dispatchId: "disp-mono",
        eventType: "TELEMETRY_STATS",
        sourceTimestamp: new Date(t0 + 1050000).toISOString(),
        sequenceNumber: 5,
        idempotencyKey: `stats-300mb-${Date.now()}`,
        payload: {
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
          bytesTransferred: 300000000,
        },
      });

      // Invariant: Monotonic max preserved: does NOT regress to 300 MB!
      const [resAfterDelayed] = await db.select().from(reservations).where(eq(reservations.id, res.id));
      expect(resAfterDelayed.bytesTransferred).toBe(500000000);
    });

    it("5. Scenario 10: Stale dispatch telemetry from an older attempt is strictly rejected", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 500000;

      const [w] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Stale Dispatch Task",
        priority: 5,
        durationSeconds: 200,
        deadline: new Date(t0 + 5000000),
        status: "SCHEDULED",
      }).returning();

      const [res] = await db.insert(reservations).values({
        missionTaskId: task.id,
        contactWindowId: w.id,
        groundStationId: gsChennaiId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 1000000),
        windowLos: new Date(t0 + 1300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 1000000),
        allocatedEnd: new Date(t0 + 1200000),
        status: "CONFIRMED",
        executionState: "DISPATCHED",
        activeDispatchId: "disp-ACTIVE-02",
      }).returning();

      // Late telemetry arrives mentioning rejected attempt disp-STALE-01
      await expect(
        executionService.ingestExecutionTelemetry({
          eventId: crypto.randomUUID(),
          reservationId: res.id,
          dispatchId: "disp-STALE-01",
          eventType: "AOS_ACQUIRED",
          sourceTimestamp: new Date(t0 + 1000000).toISOString(),
          sequenceNumber: 1,
          idempotencyKey: `stale-aos-${Date.now()}`,
          payload: {
            groundStationId: gsChennaiId,
            satelliteId: sat1Id,
          },
        })
      ).rejects.toThrow(/Stale dispatch rejected/);

      // Verify active dispatch remains authoritative
      const [resCheck] = await db.select().from(reservations).where(eq(reservations.id, res.id));
      expect(resCheck.activeDispatchId).toBe("disp-ACTIVE-02");
    });
  });

  // =========================================================================
  // WORKSTREAM 5.5.4: Watchdogs & Race Resolution
  // =========================================================================
  describe("5.5.4 — Watchdogs & Deterministic Race Resolution", () => {
    it("6. Scenario 3: Missed AOS watchdog expires when carrier lock fails within tolerance", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 600000;

      const [w] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Watchdog Expiry Task",
        priority: 5,
        durationSeconds: 200,
        deadline: new Date(t0 + 5000000),
        status: "SCHEDULED",
      }).returning();

      const [res] = await db.insert(reservations).values({
        missionTaskId: task.id,
        contactWindowId: w.id,
        groundStationId: gsChennaiId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 1000000),
        windowLos: new Date(t0 + 1300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 1000000),
        allocatedEnd: new Date(t0 + 1200000),
        status: "CONFIRMED",
        executionState: "DISPATCHED",
        activeDispatchId: "disp-watchdog",
      }).returning();

      // Reference time is 90 seconds after allocatedStart (tolerance is 60s)
      const refTime = new Date(t0 + 1090000);
      const watchdogActions = await executionService.evaluateWatchdogs(refTime, {
        aosToleranceSeconds: 60,
      });

      expect(watchdogActions.length).toBe(1);
      expect(watchdogActions[0]!.newState).toBe("FAILED");
      expect(watchdogActions[0]!.failureReason).toBe("NO_AOS");

      // Verify reservation and task status
      const [resAfter] = await db.select().from(reservations).where(eq(reservations.id, res.id));
      expect(resAfter.executionState).toBe("FAILED");
      expect(resAfter.failureReason).toBe("NO_AOS");

      const [taskAfter] = await db.select().from(missionTasks).where(eq(missionTasks.id, task.id));
      expect(taskAfter.status).toBe("PENDING"); // Preserved for rescue
    });

    it("7. Scenario 9: Deterministic Watchdog/Telemetry race gives physical AOS precedence over timeout", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 700000;

      const [w] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Race Test Task",
        priority: 5,
        durationSeconds: 200,
        deadline: new Date(t0 + 5000000),
        status: "SCHEDULED",
      }).returning();

      const [res] = await db.insert(reservations).values({
        missionTaskId: task.id,
        contactWindowId: w.id,
        groundStationId: gsChennaiId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 1000000),
        windowLos: new Date(t0 + 1300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 1000000),
        allocatedEnd: new Date(t0 + 1200000),
        status: "CONFIRMED",
        executionState: "DISPATCHED",
        activeDispatchId: "disp-race",
      }).returning();

      // Physical telemetry AOS arrives
      const aosResult = await executionService.ingestExecutionTelemetry({
        eventId: crypto.randomUUID(),
        reservationId: res.id,
        dispatchId: "disp-race",
        eventType: "AOS_ACQUIRED",
        sourceTimestamp: new Date(t0 + 1000000).toISOString(),
        sequenceNumber: 1,
        idempotencyKey: `aos-race-${Date.now()}`,
        payload: {
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
        },
      });
      expect(aosResult.newState).toBe("IN_PROGRESS");

      // Concurrent or delayed WATCHDOG_TIMEOUT arrives
      const watchdogResult = await executionService.ingestExecutionTelemetry({
        eventId: crypto.randomUUID(),
        reservationId: res.id,
        dispatchId: "disp-race",
        eventType: "WATCHDOG_TIMEOUT",
        sourceTimestamp: new Date(t0 + 1070000).toISOString(),
        sequenceNumber: 9999,
        idempotencyKey: `watchdog-race-${Date.now()}`,
        payload: {
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
          failureReason: "NO_AOS",
        },
      });

      // Deterministic resolution: physical AOS won, watchdog transition rejected as superseded
      expect(watchdogResult.newState).toBe("IN_PROGRESS");
      const [resFinal] = await db.select().from(reservations).where(eq(reservations.id, res.id));
      expect(resFinal.executionState).toBe("IN_PROGRESS");
    });

    it("8. Scenario 4: Ground station hardware fault transitions reservation to FAILED with reason", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 800000;

      const [w] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "HW Fault Task",
        priority: 5,
        durationSeconds: 200,
        deadline: new Date(t0 + 5000000),
        status: "SCHEDULED",
      }).returning();

      const [res] = await db.insert(reservations).values({
        missionTaskId: task.id,
        contactWindowId: w.id,
        groundStationId: gsChennaiId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 1000000),
        windowLos: new Date(t0 + 1300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 1000000),
        allocatedEnd: new Date(t0 + 1200000),
        status: "CONFIRMED",
        executionState: "IN_PROGRESS",
        activeDispatchId: "disp-fault",
      }).returning();

      const faultResult = await executionService.ingestExecutionTelemetry({
        eventId: crypto.randomUUID(),
        reservationId: res.id,
        dispatchId: "disp-fault",
        eventType: "GROUND_HARDWARE_FAULT",
        sourceTimestamp: new Date(t0 + 1100000).toISOString(),
        sequenceNumber: 2,
        idempotencyKey: `fault-${Date.now()}`,
        payload: {
          groundStationId: gsChennaiId,
          satelliteId: sat1Id,
          failureReason: "GROUND_HARDWARE_FAULT",
          details: { code: "MOTOR_AZIMUTH_STALL" },
        },
      });

      expect(faultResult.newState).toBe("FAILED");
      expect(faultResult.failureReason).toBe("GROUND_HARDWARE_FAULT");

      const [resAfter] = await db.select().from(reservations).where(eq(reservations.id, res.id));
      expect(resAfter.executionState).toBe("FAILED");
      expect(resAfter.failureReason).toBe("GROUND_HARDWARE_FAULT");
    });
  });

  // =========================================================================
  // WORKSTREAM 5.5.5: End-to-End API Integration & Invariant Gates
  // =========================================================================
  describe("5.5.5 — End-to-End API Integration & Invariant Gates", () => {
    it("9. Scenario 5: Invariant Gate — Routine telemetry does NOT increment schedule versions", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 900000;

      const [w] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Version Invariant Task",
        priority: 5,
        durationSeconds: 200,
        deadline: new Date(t0 + 5000000),
        status: "SCHEDULED",
      }).returning();

      const [res] = await db.insert(reservations).values({
        missionTaskId: task.id,
        contactWindowId: w.id,
        groundStationId: gsChennaiId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 1000000),
        windowLos: new Date(t0 + 1300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 1000000),
        allocatedEnd: new Date(t0 + 1200000),
        status: "CONFIRMED",
        executionState: "EXECUTION_READY",
        activeDispatchId: "disp-ver",
      }).returning();

      const vInitial = (await db.select().from(scheduleVersions).limit(1))[0].version;

      // 1. Post DISPATCH_ACK via API
      await request(app)
        .post("/api/execution/telemetry")
        .send({
          eventId: crypto.randomUUID(),
          reservationId: res.id,
          dispatchId: "disp-ver",
          eventType: "DISPATCH_ACK",
          sourceTimestamp: new Date(t0 + 950000).toISOString(),
          sequenceNumber: 1,
          idempotencyKey: `ver-ack-${Date.now()}`,
          payload: { groundStationId: gsChennaiId, satelliteId: sat1Id },
        })
        .expect(200);

      // 2. Post AOS_ACQUIRED via API
      await request(app)
        .post("/api/execution/telemetry")
        .send({
          eventId: crypto.randomUUID(),
          reservationId: res.id,
          dispatchId: "disp-ver",
          eventType: "AOS_ACQUIRED",
          sourceTimestamp: new Date(t0 + 1000000).toISOString(),
          sequenceNumber: 2,
          idempotencyKey: `ver-aos-${Date.now()}`,
          payload: { groundStationId: gsChennaiId, satelliteId: sat1Id },
        })
        .expect(200);

      // 3. Post TELEMETRY_STATS via API
      await request(app)
        .post("/api/execution/telemetry")
        .send({
          eventId: crypto.randomUUID(),
          reservationId: res.id,
          dispatchId: "disp-ver",
          eventType: "TELEMETRY_STATS",
          sourceTimestamp: new Date(t0 + 1050000).toISOString(),
          sequenceNumber: 3,
          idempotencyKey: `ver-stats-${Date.now()}`,
          payload: { groundStationId: gsChennaiId, satelliteId: sat1Id, bytesTransferred: 250000000 },
        })
        .expect(200);

      const vFinal = (await db.select().from(scheduleVersions).limit(1))[0].version;

      // Invariant: Schedule version did NOT advance for routine telemetry
      expect(vFinal).toBe(vInitial);
    });

    it("10. Scenario 6: Contract Inspection GET /api/execution/reservations/:id exposes contract state & audit history", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 1000000;

      const [w] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Inspect Contract Task",
        priority: 5,
        durationSeconds: 200,
        deadline: new Date(t0 + 5000000),
        status: "SCHEDULED",
      }).returning();

      const [res] = await db.insert(reservations).values({
        missionTaskId: task.id,
        contactWindowId: w.id,
        groundStationId: gsChennaiId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 1000000),
        windowLos: new Date(t0 + 1300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 1000000),
        allocatedEnd: new Date(t0 + 1200000),
        status: "CONFIRMED",
        executionState: "IN_PROGRESS",
        activeDispatchId: "disp-inspect",
        bytesTransferred: 450000000,
      }).returning();

      // Insert audit history record
      await db.insert(executionTelemetryEvents).values({
        reservationId: res.id,
        dispatchId: "disp-inspect",
        eventType: "TELEMETRY_STATS",
        sequenceNumber: 1,
        sourceTimestamp: new Date(t0 + 1050000),
        idempotencyKey: `inspect-event-${Date.now()}`,
        payload: { bytesTransferred: 450000000 },
      });

      const inspectRes = await request(app)
        .get(`/api/execution/reservations/${res.id}`)
        .set("Authorization", `Bearer ${viewerToken}`);

      expect(inspectRes.status).toBe(200);
      expect(inspectRes.body.reservation.executionState).toBe("IN_PROGRESS");
      expect(inspectRes.body.reservation.activeDispatchId).toBe("disp-inspect");
      expect(inspectRes.body.reservation.bytesTransferred).toBe(450000000);
      expect(inspectRes.body.telemetryHistory.length).toBe(1);
    });
  });
});
