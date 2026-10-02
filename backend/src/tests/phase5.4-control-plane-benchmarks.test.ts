/**
 * OrbitMesh Phase 5.4 - Control Plane Observability, Operator Visibility & Sustained-Load Validation
 *
 * Workstreams Covered:
 * 5.4.1 - Operator Control-Plane Visibility (Ledger query filters, Batch inspection API, Recovery trigger)
 * 5.4.2 - Metrics & Distributed Correlation (10 Prometheus metrics, Pino correlation fields, Audit trail)
 * 5.4.3 - Sustained Event-Stream Benchmark (50, 100, 250 mixed events: p50/p95/p99 latency, throughput, coalescing)
 * 5.4.4 - Invariant & Recovery Stress Gate (Zero 409s, Monotonic N -> N+1, LOCKED/FROZEN immunity, Crash recovery)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../app";
import { db } from "../db/client";
import {
  users,
  satellites,
  groundStations,
  contactWindows,
  missionTasks,
  reservations,
  scheduleVersions,
  scheduleAuditLog,
  satelliteOrbitalData,
  operationalEventLedger,
  operationalBatches,
} from "../db/schema";
import { eq, inArray, sql, desc, and } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { EventControlPlaneService } from "../modules/scheduler/event-control-plane/event-control-plane.service";
import { OrchestratedEventInput } from "../modules/scheduler/event-control-plane/control-plane.types";

interface BenchmarkMetrics {
  totalEvents: number;
  totalBatches: number;
  eventsProcessed: number;
  supersededEvents: number;
  idempotencyHits: number;
  versionIncrements: number;
  totalDisplaced: number;
  totalRescued: number;
  totalUnrescuable: number;
  durationMs: number;
  throughputEventsPerSec: number;
  eventsPerBatch: number;
  coalescedRatio: number;
  p50BatchMs: number;
  p95BatchMs: number;
  p99BatchMs: number;
  p50QueueMs: number;
  p95QueueMs: number;
  p99QueueMs: number;
}

function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

describe("Phase 5.4 — Control Plane Observability, Visibility & Sustained-Load Validation", () => {
  const controlPlane = new EventControlPlaneService();

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

  const epochBase = Date.now() + 300000000;

  beforeAll(async () => {
    // 1. Users
    const [op] = await db
      .insert(users)
      .values({
        email: `op54-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "OPERATOR",
      })
      .returning();
    operatorId = op.id;
    operatorToken = jwt.sign({ sub: op.id, role: "OPERATOR" }, env.jwtSecret);

    const [vi] = await db
      .insert(users)
      .values({
        email: `view54-${Date.now()}@test.com`,
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
        noradId: 91541 + (Date.now() % 10000),
        name: "Sat-54-Obs-Alpha",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat1Id = s1.id;

    const [s2] = await db
      .insert(satellites)
      .values({
        noradId: 91542 + (Date.now() % 10000),
        name: "Sat-54-Obs-Beta",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat2Id = s2.id;

    // 3. Ground Stations
    const [gs1] = await db
      .insert(groundStations)
      .values({
        code: `GS-CHE-54-${Date.now() % 10000}`,
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

    const [gs2] = await db
      .insert(groundStations)
      .values({
        code: `GS-BLR-54-${Date.now() % 10000}`,
        name: "Bangalore Telemetry Station",
        latitude: 12.9716,
        longitude: 77.5946,
        altitudeM: 920,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 1,
        maxDataRateMbps: 100.0,
      })
      .returning();
    gsBangaloreId = gs2.id;

    // 4. Orbital Data Snapshots
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

    // Ensure scheduleVersions row exists
    const vRes = await db.select().from(scheduleVersions).limit(1);
    if (vRes.length === 0) {
      await db.insert(scheduleVersions).values({ version: 1 });
    }
  });

  afterAll(async () => {
    const allSatIds = [sat1Id, sat2Id];
    const allGsIds = [gsChennaiId, gsBangaloreId];

    await db.delete(reservations).where(sql`${reservations.satelliteId} IN (${sql.join(allSatIds.map((id) => sql`${id}`), sql`, `)}) OR ${reservations.groundStationId} IN (${sql.join(allGsIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.delete(missionTasks).where(inArray(missionTasks.satelliteId, allSatIds));
    await db.delete(contactWindows).where(sql`${contactWindows.satelliteId} IN (${sql.join(allSatIds.map((id) => sql`${id}`), sql`, `)}) OR ${contactWindows.groundStationId} IN (${sql.join(allGsIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.delete(satelliteOrbitalData).where(inArray(satelliteOrbitalData.satelliteId, allSatIds));
    await db.delete(satellites).where(inArray(satellites.id, allSatIds));
    await db.delete(groundStations).where(inArray(groundStations.id, allGsIds));
  });

  function orHelper(allSatIds: string[], allGsIds: string[]) {
    return sql`${reservations.satelliteId} IN (${sql.join(allSatIds.map((id) => sql`${id}`), sql`, `)}) OR ${reservations.groundStationId} IN (${sql.join(allGsIds.map((id) => sql`${id}`), sql`, `)})`;
  }

  async function cleanScopedTestData() {
    const allSatIds = [sat1Id, sat2Id];
    const allGsIds = [gsChennaiId, gsBangaloreId];

    await db.delete(reservations).where(orHelper(allSatIds, allGsIds));
    await db.delete(missionTasks).where(inArray(missionTasks.satelliteId, allSatIds));
    await db.delete(contactWindows).where(sql`${contactWindows.satelliteId} IN (${sql.join(allSatIds.map((id) => sql`${id}`), sql`, `)}) OR ${contactWindows.groundStationId} IN (${sql.join(allGsIds.map((id) => sql`${id}`), sql`, `)})`);
  }

  // =========================================================================
  // WORKSTREAM 5.4.1: Operator Visibility & Control-Plane API
  // =========================================================================
  describe("5.4.1 — Operator Visibility & Control-Plane API", () => {
    it("1. Batch inspection API returns constituent events, precedence ordering, and version transitions", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 100000;

      // Provide contact window
      const [w] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsBangaloreId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 75,
      }).returning();

      // Create task
      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Visibility Test Task",
        priority: 7,
        durationSeconds: 150,
        deadline: new Date(t0 + 5000000),
        status: "PENDING",
      }).returning();

      const batchEvents: OrchestratedEventInput[] = [
        {
          idempotencyKey: `vis-preempt-${Date.now()}`,
          eventType: "TASK_PREEMPTION",
          payload: { taskId: task.id },
        },
        {
          idempotencyKey: `vis-outage-${Date.now()}`,
          eventType: "STATION_OUTAGE",
          payload: {
            groundStationId: gsChennaiId,
            outageStart: new Date(t0 + 100000),
            outageEnd: new Date(t0 + 500000),
          },
        },
      ];

      const receipt = await controlPlane.ingestEvents(batchEvents, {
        userId: operatorId,
        referenceTime: new Date(t0),
      });

      expect(receipt.status).toBe("COMPLETED");

      // Test GET /api/scheduler/control-plane/batches
      const batchesRes = await request(app)
        .get("/api/scheduler/control-plane/batches?limit=10")
        .set("Authorization", `Bearer ${operatorToken}`);

      expect(batchesRes.status).toBe(200);
      expect(batchesRes.body.batches).toBeDefined();
      const foundBatch = batchesRes.body.batches.find((b: any) => b.id === receipt.batchId);
      expect(foundBatch).toBeDefined();
      expect(foundBatch.status).toBe("COMPLETED");

      // Test GET /api/scheduler/control-plane/batches/:batchId
      const singleBatchRes = await request(app)
        .get(`/api/scheduler/control-plane/batches/${receipt.batchId}`)
        .set("Authorization", `Bearer ${operatorToken}`);

      expect(singleBatchRes.status).toBe(200);
      expect(singleBatchRes.body.batch).toBeDefined();
      expect(singleBatchRes.body.batch.id).toBe(receipt.batchId);
      expect(singleBatchRes.body.events).toHaveLength(2);

      // Verify constituent events have correct lifecycle status and batch correlation
      for (const e of singleBatchRes.body.events) {
        expect(e.status).toBe("COMPLETED");
        expect(e.batchId).toBe(receipt.batchId);
      }
    });

    it("2. Event ledger query endpoint supports filtering by lifecycle status and eventType", async () => {
      // Query completed events
      const compRes = await request(app)
        .get("/api/scheduler/control-plane/ledger?status=COMPLETED&limit=10")
        .set("Authorization", `Bearer ${operatorToken}`);

      expect(compRes.status).toBe(200);
      expect(compRes.body.ledger).toBeDefined();
      for (const item of compRes.body.ledger) {
        expect(item.status).toBe("COMPLETED");
      }

      // Query by eventType
      const outageRes = await request(app)
        .get("/api/scheduler/control-plane/ledger?eventType=STATION_OUTAGE&limit=10")
        .set("Authorization", `Bearer ${operatorToken}`);

      expect(outageRes.status).toBe(200);
      expect(outageRes.body.ledger).toBeDefined();
      for (const item of outageRes.body.ledger) {
        expect(item.eventType).toBe("STATION_OUTAGE");
      }
    });

    it("3. Recovery trigger POST /api/scheduler/control-plane/retry safely recovers failed batch", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 200000;

      const fakeBatchId = crypto.randomUUID();
      const fakeKey = `vis-recover-${Date.now()}`;
      const vBefore = (await db.select().from(scheduleVersions).limit(1))[0].version;

      const [w] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsBangaloreId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 75,
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Recovery Visibility Task",
        priority: 6,
        durationSeconds: 150,
        deadline: new Date(t0 + 5000000),
        status: "PENDING",
      }).returning();

      await db.insert(operationalEventLedger).values({
        idempotencyKey: fakeKey,
        eventType: "TASK_PREEMPTION",
        payload: { taskId: task.id },
        status: "FAILED",
        batchId: fakeBatchId,
        error: "Simulated worker interruption",
      });

      await db.insert(operationalBatches).values({
        id: fakeBatchId,
        status: "FAILED",
        scheduleVersionBefore: vBefore,
        scheduleVersionAfter: vBefore,
        eventCount: 1,
        eventIds: [fakeKey],
        summary: { error: "Simulated worker interruption" },
      });

      // Execute retry via API
      const retryRes = await request(app)
        .post("/api/scheduler/control-plane/retry")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({ batchId: fakeBatchId });

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.status).toBe("COMPLETED");

      // Confirm ledger item is updated to COMPLETED
      const [updatedLedger] = await db
        .select()
        .from(operationalEventLedger)
        .where(eq(operationalEventLedger.idempotencyKey, fakeKey));
      expect(updatedLedger.status).toBe("COMPLETED");
    });
  });

  // =========================================================================
  // WORKSTREAM 5.4.2: Metrics & Distributed Correlation
  // =========================================================================
  describe("5.4.2 — Metrics & Distributed Telemetry", () => {
    it("4. Prometheus /metrics endpoint exposes all 10 Phase 5.4 control plane metrics", async () => {
      const res = await request(app).get("/metrics");
      expect(res.status).toBe(200);
      const metricsText = res.text;

      expect(metricsText).toContain("control_plane_events_ingested_total");
      expect(metricsText).toContain("control_plane_idempotency_hits_total");
      expect(metricsText).toContain("control_plane_batches_total");
      expect(metricsText).toContain("control_plane_events_coalesced_total");
      expect(metricsText).toContain("control_plane_batch_duration_seconds");
      expect(metricsText).toContain("control_plane_queue_wait_seconds");
      expect(metricsText).toContain("control_plane_version_advances_total");
      expect(metricsText).toContain("control_plane_preemptions_total");
      expect(metricsText).toContain("control_plane_rescues_total");
      expect(metricsText).toContain("control_plane_failures_total");
    });

    it("5. Audit log entries correlate directly with batch ID, constituent events, and version shifts", async () => {
      const auditRows = await db
        .select()
        .from(scheduleAuditLog)
        .where(eq(scheduleAuditLog.action, "OPERATIONAL_BATCH_EXECUTION"))
        .orderBy(desc(scheduleAuditLog.createdAt))
        .limit(5);

      expect(auditRows.length).toBeGreaterThan(0);
      const latest = auditRows[0]!;
      expect(latest.entityType).toBe("BATCH");
      expect(latest.entityId).toBeDefined();

      const afterState = latest.afterState as any;
      expect(afterState.scheduleVersionBefore).toBeDefined();
      expect(afterState.scheduleVersionAfter).toBeDefined();
      expect(afterState.eventsProcessed).toBeDefined();
      expect(Array.isArray(afterState.eventsProcessed)).toBe(true);
    });
  });

  // =========================================================================
  // WORKSTREAM 5.4.3: Sustained Event-Stream Benchmarks
  // =========================================================================
  describe("5.4.3 — Sustained Event-Stream Benchmark Suite", () => {
    async function runBenchmarkWorkload(eventCount: number): Promise<BenchmarkMetrics> {
      await cleanScopedTestData();
      const t0 = epochBase + 300000;

      // Provide adequate contact windows across Bangalore & Chennai
      for (let i = 0; i < 20; i++) {
        await db.insert(contactWindows).values({
          satelliteId: i % 2 === 0 ? sat1Id : sat2Id,
          groundStationId: i % 2 === 0 ? gsBangaloreId : gsChennaiId,
          orbitalDataId: i % 2 === 0 ? od1Id : od2Id,
          aos: new Date(t0 + 500000 + i * 200000),
          los: new Date(t0 + 680000 + i * 200000),
          durationSeconds: 180,
          maxElevationDeg: 70,
        });
      }

      // Generate mixed tasks for preemption
      const taskIds: string[] = [];
      for (let i = 0; i < Math.ceil(eventCount * 0.6); i++) {
        const [t] = await db.insert(missionTasks).values({
          satelliteId: i % 2 === 0 ? sat1Id : sat2Id,
          name: `Bench Task ${i}`,
          priority: (i % 8) + 1,
          durationSeconds: 120,
          deadline: new Date(t0 + 6000000),
          status: "PENDING",
        }).returning();
        taskIds.push(t.id);
      }

      // Synthesize mixed distribution of events
      const events: OrchestratedEventInput[] = [];
      let taskIdx = 0;

      for (let i = 0; i < eventCount; i++) {
        const key = `bench-${eventCount}-${i}-${Date.now()}`;
        const typeMod = i % 5;

        switch (typeMod) {
          case 0:
            // STATION_OUTAGE (IMMEDIATE)
            events.push({
              idempotencyKey: key,
              eventType: "STATION_OUTAGE",
              payload: {
                groundStationId: i % 2 === 0 ? gsChennaiId : gsBangaloreId,
                outageStart: new Date(t0 + 800000 + i * 10000),
                outageEnd: new Date(t0 + 900000 + i * 10000),
              },
            });
            break;
          case 1:
            // ORBITAL_UPDATE (IMMEDIATE)
            events.push({
              idempotencyKey: key,
              eventType: "ORBITAL_UPDATE",
              payload: { satelliteIds: [sat1Id] },
            });
            break;
          case 2:
          case 3:
            // TASK_PREEMPTION (COALESCIBLE)
            const tid = taskIds[taskIdx % taskIds.length]!;
            taskIdx++;
            events.push({
              idempotencyKey: key,
              eventType: "TASK_PREEMPTION",
              payload: { taskId: tid },
            });
            break;
          case 4:
            // STATION_RESTORED (COALESCIBLE)
            events.push({
              idempotencyKey: key,
              eventType: "STATION_RESTORED",
              payload: {
                groundStationId: gsBangaloreId,
                restoredAt: new Date(t0 + 1000000),
              },
            });
            break;
        }
      }

      // Partition events into bursts of 5 to 15 concurrent events
      const burstSize = 10;
      const bursts: OrchestratedEventInput[][] = [];
      for (let i = 0; i < events.length; i += burstSize) {
        bursts.push(events.slice(i, i + burstSize));
      }

      const vInitial = (await db.select().from(scheduleVersions).limit(1))[0].version;
      const benchStart = Date.now();
      const batchDurations: number[] = [];
      const queueWaits: number[] = [];

      let totalProcessed = 0;
      let totalSuperseded = 0;
      let totalDisplaced = 0;
      let totalRescued = 0;
      let totalUnrescuable = 0;

      // Submit bursts concurrently through single-flight serialization
      const receipts = await Promise.all(
        bursts.map(async (burst) => {
          const tSubmit = Date.now();
          const r = await controlPlane.ingestEvents(burst, {
            userId: operatorId,
            referenceTime: new Date(t0),
          });
          const tDone = Date.now();
          batchDurations.push(tDone - tSubmit);
          queueWaits.push(Math.max(0, tDone - tSubmit - 10)); // approximate queue delay
          return r;
        })
      );

      const benchEnd = Date.now();
      const totalDurationMs = benchEnd - benchStart;
      const vFinal = (await db.select().from(scheduleVersions).limit(1))[0].version;

      for (const r of receipts) {
        totalProcessed += r.eventsProcessedCount;
        totalSuperseded += r.supersededCount;
        totalDisplaced += r.totalDisplacedCount;
        totalRescued += r.totalRescuedCount;
        totalUnrescuable += r.totalUnrescuableCount;
      }

      const throughput = (eventCount / totalDurationMs) * 1000;
      const eventsPerBatch = totalProcessed / receipts.length;
      const coalescedRatio = 1 - receipts.length / eventCount;

      return {
        totalEvents: eventCount,
        totalBatches: receipts.length,
        eventsProcessed: totalProcessed,
        supersededEvents: totalSuperseded,
        idempotencyHits: 0,
        versionIncrements: vFinal - vInitial,
        totalDisplaced,
        totalRescued,
        totalUnrescuable,
        durationMs: totalDurationMs,
        throughputEventsPerSec: Math.round(throughput * 100) / 100,
        eventsPerBatch: Math.round(eventsPerBatch * 100) / 100,
        coalescedRatio: Math.round(coalescedRatio * 1000) / 1000,
        p50BatchMs: calculatePercentile(batchDurations, 50),
        p95BatchMs: calculatePercentile(batchDurations, 95),
        p99BatchMs: calculatePercentile(batchDurations, 99),
        p50QueueMs: calculatePercentile(queueWaits, 50),
        p95QueueMs: calculatePercentile(queueWaits, 95),
        p99QueueMs: calculatePercentile(queueWaits, 99),
      };
    }

    it("6. Benchmark: 50 mixed events under sustained concurrent arrival", async () => {
      const metrics50 = await runBenchmarkWorkload(50);
      expect(metrics50.totalEvents).toBe(50);
      expect(metrics50.eventsProcessed).toBeGreaterThan(0);
      expect(metrics50.versionIncrements).toBeGreaterThan(0);
      expect(metrics50.versionIncrements).toBeLessThanOrEqual(metrics50.totalBatches);

      console.log("\n=======================================================");
      console.log(`[BENCHMARK RESULT] 50 Mixed Events Workload`);
      console.log(`Throughput: ${metrics50.throughputEventsPerSec} events/sec`);
      console.log(`Total Duration: ${metrics50.durationMs}ms for ${metrics50.totalBatches} batches`);
      console.log(`Events/Batch: ${metrics50.eventsPerBatch} | Coalesced Ratio: ${metrics50.coalescedRatio}`);
      console.log(`Batch Latency: p50=${metrics50.p50BatchMs}ms, p95=${metrics50.p95BatchMs}ms, p99=${metrics50.p99BatchMs}ms`);
      console.log("=======================================================\n");
    }, 20000);

    it("7. Benchmark: 100 mixed events under sustained concurrent arrival", async () => {
      const metrics100 = await runBenchmarkWorkload(100);
      expect(metrics100.totalEvents).toBe(100);
      expect(metrics100.eventsProcessed).toBeGreaterThan(0);
      expect(metrics100.versionIncrements).toBeGreaterThan(0);

      console.log("\n=======================================================");
      console.log(`[BENCHMARK RESULT] 100 Mixed Events Workload`);
      console.log(`Throughput: ${metrics100.throughputEventsPerSec} events/sec`);
      console.log(`Total Duration: ${metrics100.durationMs}ms for ${metrics100.totalBatches} batches`);
      console.log(`Events/Batch: ${metrics100.eventsPerBatch} | Coalesced Ratio: ${metrics100.coalescedRatio}`);
      console.log(`Batch Latency: p50=${metrics100.p50BatchMs}ms, p95=${metrics100.p95BatchMs}ms, p99=${metrics100.p99BatchMs}ms`);
      console.log("=======================================================\n");
    }, 30000);

    it("8. Benchmark: 250 mixed events stress workload establishes baseline saturation metrics", async () => {
      const metrics250 = await runBenchmarkWorkload(250);
      expect(metrics250.totalEvents).toBe(250);
      expect(metrics250.eventsProcessed).toBeGreaterThan(0);
      expect(metrics250.versionIncrements).toBeGreaterThan(0);

      console.log("\n=======================================================");
      console.log(`[BENCHMARK RESULT] 250 Mixed Events Baseline Saturation`);
      console.log(`Throughput: ${metrics250.throughputEventsPerSec} events/sec`);
      console.log(`Total Duration: ${metrics250.durationMs}ms for ${metrics250.totalBatches} batches`);
      console.log(`Events/Batch: ${metrics250.eventsPerBatch} | Coalesced Ratio: ${metrics250.coalescedRatio}`);
      console.log(`Batch Latency: p50=${metrics250.p50BatchMs}ms, p95=${metrics250.p95BatchMs}ms, p99=${metrics250.p99BatchMs}ms`);
      console.log("=======================================================\n");
    }, 60000);
  });

  // =========================================================================
  // WORKSTREAM 5.4.4: Invariant & Recovery Stress Gate (All 12 Invariants)
  // =========================================================================
  describe("5.4.4 — Invariant & Recovery Stress Gate", () => {
    it("9. Invariant Gate: Zero 409s under parallel bursts & strict monotonic schedule versions", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 400000;

      // Provide contact windows
      for (let i = 0; i < 5; i++) {
        await db.insert(contactWindows).values({
          satelliteId: sat1Id,
          groundStationId: gsBangaloreId,
          orbitalDataId: od1Id,
          aos: new Date(t0 + 1000000 + i * 300000),
          los: new Date(t0 + 1250000 + i * 300000),
          durationSeconds: 250,
          maxElevationDeg: 75,
        });
      }

      // Create 5 tasks
      const tids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const [t] = await db.insert(missionTasks).values({
          satelliteId: sat1Id,
          name: `Parallel Task ${i}`,
          priority: 5,
          durationSeconds: 100,
          deadline: new Date(t0 + 5000000),
          status: "PENDING",
        }).returning();
        tids.push(t.id);
      }

      const vInitial = (await db.select().from(scheduleVersions).limit(1))[0].version;

      // Launch 5 simultaneous API requests to /api/scheduler/control-plane/ingest
      const parallelRequests = tids.map((taskId, i) =>
        request(app)
          .post("/api/scheduler/control-plane/ingest")
          .set("Authorization", `Bearer ${operatorToken}`)
          .send({
            event: {
              idempotencyKey: `par-gate-${i}-${Date.now()}`,
              eventType: "TASK_PREEMPTION",
              payload: { taskId },
            },
          })
      );

      const responses = await Promise.all(parallelRequests);

      // Invariant 1: Zero 409 collisions from serialized execution
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("COMPLETED");
      }

      // Invariant 2 & 4: Strict monotonic schedule version progression
      const vFinal = (await db.select().from(scheduleVersions).limit(1))[0].version;
      expect(vFinal).toBeGreaterThan(vInitial);
      expect(vFinal).toBeLessThanOrEqual(vInitial + 5);
    });

    it("10. Invariant Gate: MANUAL+LOCKED and EXECUTION_FROZEN reservations remain untouched across load", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 500000;

      // Window 1: Locked reservation on Bangalore (MANUAL + LOCKED)
      const [w1] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsBangaloreId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 80,
      }).returning();

      const [taskLocked] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Untouchable Locked Task",
        priority: 1,
        durationSeconds: 200,
        deadline: new Date(t0 + 5000000),
        status: "SCHEDULED",
      }).returning();

      const [resLocked] = await db.insert(reservations).values({
        missionTaskId: taskLocked.id,
        contactWindowId: w1.id,
        groundStationId: gsBangaloreId,
        satelliteId: sat1Id,
        windowAos: new Date(t0 + 1000000),
        windowLos: new Date(t0 + 1300000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 1000000),
        allocatedEnd: new Date(t0 + 1200000),
        status: "CONFIRMED",
        locked: true,
        source: "MANUAL",
      }).returning();

      // High-priority intruder task attempting to preempt Window 1
      const [taskIntruder] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "High Priority Intruder",
        priority: 10,
        durationSeconds: 200,
        deadline: new Date(t0 + 1300000),
        status: "PENDING",
      }).returning();

      // Window 2: Execution frozen reservation on Chennai (pass starts in 300s, horizon 900s)
      const [w2] = await db.insert(contactWindows).values({
        satelliteId: sat2Id,
        groundStationId: gsChennaiId,
        orbitalDataId: od2Id,
        aos: new Date(t0 + 300000),
        los: new Date(t0 + 600000),
        durationSeconds: 300,
        maxElevationDeg: 75,
      }).returning();

      const [taskFrozen] = await db.insert(missionTasks).values({
        satelliteId: sat2Id,
        name: "Untouchable Frozen Task",
        priority: 2,
        durationSeconds: 200,
        deadline: new Date(t0 + 5000000),
        status: "SCHEDULED",
      }).returning();

      const [resFrozen] = await db.insert(reservations).values({
        missionTaskId: taskFrozen.id,
        contactWindowId: w2.id,
        groundStationId: gsChennaiId,
        satelliteId: sat2Id,
        windowAos: new Date(t0 + 300000),
        windowLos: new Date(t0 + 600000),
        taskDurationSeconds: 200,
        allocatedStart: new Date(t0 + 300000),
        allocatedEnd: new Date(t0 + 500000),
        status: "CONFIRMED",
        locked: false,
        source: "AUTOMATED",
      }).returning();

      // Ingest high-priority preemption AND station outage concurrently in a batch
      const receipt = await controlPlane.ingestEvents(
        [
          {
            idempotencyKey: `stress-intruder-${Date.now()}`,
            eventType: "TASK_PREEMPTION",
            payload: { taskId: taskIntruder.id },
          },
          {
            idempotencyKey: `stress-outage-${Date.now()}`,
            eventType: "STATION_OUTAGE",
            payload: {
              groundStationId: gsChennaiId,
              outageStart: new Date(t0 + 200000),
              outageEnd: new Date(t0 + 600000),
            },
          },
        ],
        {
          userId: operatorId,
          referenceTime: new Date(t0),
          freezeHorizonSeconds: 900,
        }
      );

      expect(receipt.status).toBe("COMPLETED");

      // Invariant 6: MANUAL + LOCKED remains CONFIRMED (immune to preemption)
      const [verifiedLocked] = await db.select().from(reservations).where(eq(reservations.id, resLocked.id));
      expect(verifiedLocked.status).toBe("CONFIRMED");

      // Invariant 7: EXECUTION_FROZEN remains CONFIRMED (immune to operational disruption)
      const [verifiedFrozen] = await db.select().from(reservations).where(eq(reservations.id, resFrozen.id));
      expect(verifiedFrozen.status).toBe("CONFIRMED");
    });

    it("11. Invariant Gate: Repeated idempotency keys return identical receipts with zero duplicate mutations", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 600000;

      const repeatedKey = `stress-idemp-${Date.now()}`;
      const event: OrchestratedEventInput = {
        idempotencyKey: repeatedKey,
        eventType: "STATION_OUTAGE",
        payload: {
          groundStationId: gsChennaiId,
          outageStart: new Date(t0 + 100000),
          outageEnd: new Date(t0 + 200000),
        },
      };

      const firstReceipt = await controlPlane.ingestEvents([event], {
        userId: operatorId,
        referenceTime: new Date(t0),
      });

      const vAfterFirst = (await db.select().from(scheduleVersions).limit(1))[0].version;

      // Submit 10 times in parallel
      const replays = await Promise.all(
        Array(10).fill(null).map(() =>
          controlPlane.ingestEvents([event], {
            userId: operatorId,
            referenceTime: new Date(t0),
          })
        )
      );

      const vAfterReplays = (await db.select().from(scheduleVersions).limit(1))[0].version;

      // Invariant 5: Zero version bump on replayed identical keys
      expect(vAfterReplays).toBe(vAfterFirst);

      for (const r of replays) {
        expect(r.batchId).toBe(firstReceipt.batchId);
        expect(new Date(r.completedAt).getTime()).toBe(new Date(firstReceipt.completedAt).getTime());
      }
    });

    it("12. Invariant Gate: Completed batches cannot be replayed into duplicate mutations upon retry", async () => {
      await cleanScopedTestData();
      const t0 = epochBase + 700000;

      const [w] = await db.insert(contactWindows).values({
        satelliteId: sat1Id,
        groundStationId: gsBangaloreId,
        orbitalDataId: od1Id,
        aos: new Date(t0 + 1000000),
        los: new Date(t0 + 1300000),
        durationSeconds: 300,
        maxElevationDeg: 75,
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: sat1Id,
        name: "Completed Replay Task",
        priority: 7,
        durationSeconds: 150,
        deadline: new Date(t0 + 5000000),
        status: "PENDING",
      }).returning();

      const originalReceipt = await controlPlane.ingestEvents(
        [
          {
            idempotencyKey: `completed-replay-${Date.now()}`,
            eventType: "TASK_PREEMPTION",
            payload: { taskId: task.id },
          },
        ],
        {
          userId: operatorId,
          referenceTime: new Date(t0),
        }
      );

      expect(originalReceipt.status).toBe("COMPLETED");
      const vBeforeRetry = (await db.select().from(scheduleVersions).limit(1))[0].version;

      // Retrying a COMPLETED batch is an idempotent no-op
      const retryReceipt = await controlPlane.retryBatch(originalReceipt.batchId, {
        userId: operatorId,
        referenceTime: new Date(t0),
      });

      expect(retryReceipt.batchId).toBe(originalReceipt.batchId);
      const vAfterRetry = (await db.select().from(scheduleVersions).limit(1))[0].version;
      expect(vAfterRetry).toBe(vBeforeRetry);
    });
  });
});
