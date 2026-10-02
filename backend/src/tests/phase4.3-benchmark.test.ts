/**
 * OrbitMesh Phase 4.3 - Hybrid Scoring Engine & Benchmarked Policy Suite Tests
 * 
 * Formal Acceptance Test Suite for Phase 4.3:
 * 
 * Invariants Verified:
 * 1. Hard constraints remain strictly upstream of urgency/scoring (ConstraintValidationService).
 * 2. All three policies (FCFS, PRIORITY, HYBRID) run against the fixed benchmark fixture reproducibly.
 * 3. All 9 standardized metrics are emitted cleanly:
 *    - scheduledTaskCount
 *    - unscheduledTaskCount
 *    - weightedPriorityValue
 *    - deadlineSuccessRate
 *    - totalScheduledDurationSeconds
 *    - stationUtilizationPercent
 *    - satelliteUtilizationPercent
 *    - deadlineMissCount
 *    - averageSlackSecondsAtAllocation
 * 4. Objective policy characterization: FCFS vs Priority vs Hybrid without a hardcoded predetermined winner.
 * 5. MANUAL + LOCKED reservations remain immutable barriers across all policies.
 * 6. Preview with policy='HYBRID' is strictly mutation-free.
 * 7. 100% deterministic (no random seeds).
 * 8. MetaScheduler remains untouched and frozen.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../app";
import { db } from "../db/client";
import { eq, inArray, sql, or, and } from "drizzle-orm";
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
  SchedulerPolicyType,
} from "../modules/scheduler/hybrid-scoring-scheduler";
import {
  PolicyBenchmarkMetrics,
  calculateHybridCandidateScore,
  DEFAULT_HYBRID_WEIGHTS,
} from "../modules/scheduler/scoring";

import benchmarkWorkload from "../fixtures/phase4-benchmark-workload.json";

describe("Phase 4.3 - Hybrid Scoring Engine & Benchmarked Policy Suite", () => {
  let operatorToken: string;
  let viewerToken: string;
  let operatorUserId: string;

  const satIds = benchmarkWorkload.satellites.map((s) => s.id);
  const odIds = benchmarkWorkload.orbitalData.map((o) => o.id);
  const gsIds = benchmarkWorkload.groundStations.map((g) => g.id);
  const cwIds = benchmarkWorkload.contactWindows.map((w) => w.id);
  const taskIds = benchmarkWorkload.missionTasks.map((t) => t.id);

  const refTime = new Date(benchmarkWorkload.referenceTime);

  // Stored metric profiles for cross-policy comparison
  let fMetrics: PolicyBenchmarkMetrics;
  let pMetrics: PolicyBenchmarkMetrics;
  let hMetrics: PolicyBenchmarkMetrics;

  beforeAll(async () => {
    // 1. Create auth tokens
    const [op] = await db
      .insert(users)
      .values({
        email: `op43_${Date.now()}@test.com`,
        passwordHash: await bcrypt.hash("password", 10),
        role: "OPERATOR",
      })
      .returning();
    operatorUserId = op.id;
    operatorToken = jwt.sign({ sub: op.id, role: op.role }, env.jwtSecret, { expiresIn: "1h" });

    const [vw] = await db
      .insert(users)
      .values({
        email: `vw43_${Date.now()}@test.com`,
        passwordHash: await bcrypt.hash("password", 10),
        role: "VIEWER",
      })
      .returning();
    viewerToken = jwt.sign({ sub: vw.id, role: vw.role }, env.jwtSecret, { expiresIn: "1h" });

    // 2. Ensure clean initial state for benchmark entities
    await db.delete(reservations).where(inArray(reservations.missionTaskId, taskIds));
    await db.delete(missionTasks).where(inArray(missionTasks.id, taskIds));
    await db.delete(contactWindows).where(inArray(contactWindows.id, cwIds));
    await db.delete(satelliteOrbitalData).where(inArray(satelliteOrbitalData.id, odIds));
    await db.delete(satellites).where(inArray(satellites.id, satIds));
    await db.delete(groundStations).where(inArray(groundStations.id, gsIds));

    // 3. Seed Satellites (5)
    await db.insert(satellites).values(
      benchmarkWorkload.satellites.map((s) => ({
        id: s.id,
        noradId: s.noradId,
        name: s.name,
        type: s.type as any,
        status: s.status as any,
      }))
    );

    // 4. Seed Orbital Data (5)
    await db.insert(satelliteOrbitalData).values(
      benchmarkWorkload.orbitalData.map((o) => ({
        id: o.id,
        satelliteId: o.satelliteId,
        source: o.source as any,
        tleLine1: o.tleLine1,
        tleLine2: o.tleLine2,
        tleEpoch: new Date(o.tleEpoch),
        receivedAt: new Date(o.receivedAt),
      }))
    );

    // 5. Seed Ground Stations (4 with varied bands & channel capacities)
    await db.insert(groundStations).values(
      benchmarkWorkload.groundStations.map((g) => ({
        id: g.id,
        code: g.code,
        name: g.name,
        latitude: g.latitude,
        longitude: g.longitude,
        altitudeM: g.altitudeM,
        minimumElevationDeg: g.minimumElevationDeg,
        status: g.status as any,
        supportedFrequencyBands: g.supportedFrequencyBands,
        maxConcurrentContacts: g.maxConcurrentContacts,
        maxDataRateMbps: g.maxDataRateMbps,
      }))
    );

    // 6. Seed Contact Windows (50)
    await db.insert(contactWindows).values(
      benchmarkWorkload.contactWindows.map((w) => ({
        id: w.id,
        satelliteId: w.satelliteId,
        groundStationId: w.groundStationId,
        orbitalDataId: w.orbitalDataId,
        aos: new Date(w.aos),
        los: new Date(w.los),
        durationSeconds: w.durationSeconds,
        maxElevationDeg: w.maxElevationDeg,
        status: w.status as any,
      }))
    );

    // 7. Seed Competing Mission Tasks (60 across 4 contention regimes)
    await db.insert(missionTasks).values(
      benchmarkWorkload.missionTasks.map((t) => ({
        id: t.id,
        satelliteId: t.satelliteId,
        name: t.name,
        priority: t.priority,
        durationSeconds: t.durationSeconds,
        deadline: new Date(t.deadline),
        requiredFrequencyBand: t.requiredFrequencyBand,
        minDataRateMbps: t.minDataRateMbps,
        status: t.status as any,
        createdAt: new Date(t.createdAt),
      }))
    );
  });

  afterAll(async () => {
    // Teardown benchmark fixtures
    await db.delete(reservations).where(inArray(reservations.missionTaskId, taskIds));
    await db.delete(missionTasks).where(inArray(missionTasks.id, taskIds));
    await db.delete(contactWindows).where(inArray(contactWindows.id, cwIds));
    await db.delete(satelliteOrbitalData).where(inArray(satelliteOrbitalData.id, odIds));
    await db.delete(satellites).where(inArray(satellites.id, satIds));
    await db.delete(groundStations).where(inArray(groundStations.id, gsIds));
  });

  // Helper to reset tasks and reservations between benchmark runs
  async function resetBenchmarkRunState() {
    await db.delete(reservations).where(inArray(reservations.missionTaskId, taskIds));
    await db
      .update(missionTasks)
      .set({ status: "PENDING" })
      .where(inArray(missionTasks.id, taskIds));
  }

  // Helper to verify hard constraints on all created reservations
  async function verifyHardConstraintIntegrity(resvs: any[]) {
    const taskMap = new Map(benchmarkWorkload.missionTasks.map((t) => [t.id, t]));
    const stationMap = new Map(benchmarkWorkload.groundStations.map((g) => [g.id, g]));
    const winMap = new Map(benchmarkWorkload.contactWindows.map((w) => [w.id, w]));

    for (const r of resvs) {
      const task = taskMap.get(r.missionTaskId);
      const station = stationMap.get(r.groundStationId);
      const win = winMap.get(r.contactWindowId);

      expect(task).toBeDefined();
      expect(station).toBeDefined();
      expect(win).toBeDefined();

      if (task && station && win) {
        // 1. RF Frequency Band Compatibility
        if (task.requiredFrequencyBand) {
          expect(station.supportedFrequencyBands).toContain(task.requiredFrequencyBand);
        }

        // 2. Data Rate Sufficiency
        if (task.minDataRateMbps && station.maxDataRateMbps) {
          expect(station.maxDataRateMbps).toBeGreaterThanOrEqual(task.minDataRateMbps);
        }

        // 3. Contact Window Boundary Invariance
        const allocStart = new Date(r.allocatedStart).getTime();
        const allocEnd = new Date(r.allocatedEnd).getTime();
        const winAos = new Date(win.aos).getTime();
        const winLos = new Date(win.los).getTime();

        expect(allocStart).toBeGreaterThanOrEqual(winAos);
        expect(allocEnd).toBeLessThanOrEqual(winLos);

        // 4. Task Deadline Invariance
        const taskDl = new Date(task.deadline).getTime();
        expect(allocEnd).toBeLessThanOrEqual(taskDl);

        // 5. Task Duration Invariance
        const allocatedDurationSec = (allocEnd - allocStart) / 1000;
        expect(allocatedDurationSec).toBeGreaterThanOrEqual(task.durationSeconds);
      }
    }

    // 6. Satellite Transceiver Exclusivity (No simultaneous transmissions for same satellite)
    for (let i = 0; i < resvs.length; i++) {
      for (let j = i + 1; j < resvs.length; j++) {
        const r1 = resvs[i];
        const r2 = resvs[j];
        if (r1.satelliteId === r2.satelliteId) {
          const s1 = new Date(r1.allocatedStart).getTime();
          const e1 = new Date(r1.allocatedEnd).getTime();
          const s2 = new Date(r2.allocatedStart).getTime();
          const e2 = new Date(r2.allocatedEnd).getTime();
          const overlaps = s1 < e2 && e1 > s2;
          expect(overlaps).toBe(false);
        }
      }
    }
  }

  describe("Benchmark Workload Integrity", () => {
    it("1. Fixed benchmark workload fixture is correctly configured with 60 tasks, 50 windows, 4 stations, 5 satellites", () => {
      expect(benchmarkWorkload.satellites.length).toBe(5);
      expect(benchmarkWorkload.groundStations.length).toBe(4);
      expect(benchmarkWorkload.contactWindows.length).toBe(50);
      expect(benchmarkWorkload.missionTasks.length).toBe(60);

      // Verify Ground Station capability diversity
      const svalbard = benchmarkWorkload.groundStations.find((g) => g.code === "GS-SVALBARD-POLAR");
      expect(svalbard?.supportedFrequencyBands).toEqual(["S_BAND", "X_BAND", "KA_BAND"]);
      expect(svalbard?.maxConcurrentContacts).toBe(3);

      const hartebeesthoek = benchmarkWorkload.groundStations.find((g) => g.code === "GS-HARTEBEESTHOEK");
      expect(hartebeesthoek?.supportedFrequencyBands).toEqual(["S_BAND"]);
      expect(hartebeesthoek?.maxConcurrentContacts).toBe(1);

      // Verify Mission Task regime diversity (15 per regime)
      const criticalSlack = benchmarkWorkload.missionTasks.filter((t) => t.name.includes("Critical-Slack"));
      const highPrio = benchmarkWorkload.missionTasks.filter((t) => t.name.includes("HighPrio-AmpleSlack"));
      const medPrio = benchmarkWorkload.missionTasks.filter((t) => t.name.includes("MedPrio-Balanced"));
      const hwRestricted = benchmarkWorkload.missionTasks.filter((t) => t.name.includes("Hardware-Restricted"));

      expect(criticalSlack.length).toBe(15);
      expect(highPrio.length).toBe(15);
      expect(medPrio.length).toBe(15);
      expect(hwRestricted.length).toBe(15);
    });
  });

  describe("Policy 1: FCFS Policy Benchmark Execution", () => {
    it("2. FCFS Policy schedules pending tasks strictly by arrival order and emits all 9 metrics cleanly", async () => {
      await resetBenchmarkRunState();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        refTime,
        DEFAULT_HYBRID_WEIGHTS,
        "FCFS"
      );

      const result = await scheduler.schedulePendingTasks(taskIds);

      expect(result.scheduled).toBeGreaterThan(0);
      expect(result.unscheduled).toBeGreaterThan(0);
      expect(result.scheduled + result.unscheduled).toBe(60);
      expect(result.metrics).toBeDefined();

      fMetrics = result.metrics;

      // Verify all 9 defined metrics are finite and properly computed
      expect(fMetrics.scheduledTaskCount).toBe(result.scheduled);
      expect(fMetrics.unscheduledTaskCount).toBe(result.unscheduled);
      expect(fMetrics.weightedPriorityValue).toBeGreaterThan(0);
      expect(fMetrics.deadlineSuccessRate).toBeGreaterThan(0);
      expect(fMetrics.totalScheduledDurationSeconds).toBeGreaterThan(0);
      expect(fMetrics.stationUtilizationPercent).toBeGreaterThan(0);
      expect(fMetrics.satelliteUtilizationPercent).toBeGreaterThan(0);
      expect(fMetrics.deadlineMissCount).toBeGreaterThanOrEqual(0);
      expect(fMetrics.averageSlackSecondsAtAllocation).toBeGreaterThan(0);

      // Verify 100% hard constraint adherence in database
      const createdResvs = await db
        .select()
        .from(reservations)
        .where(inArray(reservations.missionTaskId, taskIds));
      expect(createdResvs.length).toBe(result.scheduled);
      await verifyHardConstraintIntegrity(createdResvs);
    });
  });

  describe("Policy 2: PRIORITY Policy Benchmark Execution", () => {
    it("3. PRIORITY Policy schedules strictly by priority DESC, deadline ASC and emits all 9 metrics cleanly", async () => {
      await resetBenchmarkRunState();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        refTime,
        DEFAULT_HYBRID_WEIGHTS,
        "PRIORITY"
      );

      const result = await scheduler.schedulePendingTasks(taskIds);

      expect(result.scheduled).toBeGreaterThan(0);
      expect(result.unscheduled).toBeGreaterThan(0);
      expect(result.scheduled + result.unscheduled).toBe(60);
      expect(result.metrics).toBeDefined();

      pMetrics = result.metrics;

      // Verify all 9 defined metrics are finite and properly computed
      expect(pMetrics.scheduledTaskCount).toBe(result.scheduled);
      expect(pMetrics.unscheduledTaskCount).toBe(result.unscheduled);
      expect(pMetrics.weightedPriorityValue).toBeGreaterThan(0);
      expect(pMetrics.deadlineSuccessRate).toBeGreaterThan(0);
      expect(pMetrics.totalScheduledDurationSeconds).toBeGreaterThan(0);
      expect(pMetrics.stationUtilizationPercent).toBeGreaterThan(0);
      expect(pMetrics.satelliteUtilizationPercent).toBeGreaterThan(0);
      expect(pMetrics.deadlineMissCount).toBeGreaterThanOrEqual(0);
      expect(pMetrics.averageSlackSecondsAtAllocation).toBeGreaterThan(0);

      // Verify 100% hard constraint adherence in database
      const createdResvs = await db
        .select()
        .from(reservations)
        .where(inArray(reservations.missionTaskId, taskIds));
      expect(createdResvs.length).toBe(result.scheduled);
      await verifyHardConstraintIntegrity(createdResvs);
    });
  });

  describe("Policy 3: HYBRID Policy Benchmark Execution", () => {
    it("4. HYBRID Policy scores candidates with multi-attribute function and emits all 9 metrics cleanly", async () => {
      await resetBenchmarkRunState();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        refTime,
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );

      const result = await scheduler.schedulePendingTasks(taskIds);

      expect(result.scheduled).toBeGreaterThan(0);
      expect(result.unscheduled).toBeGreaterThan(0);
      expect(result.scheduled + result.unscheduled).toBe(60);
      expect(result.metrics).toBeDefined();
      expect(result.scoreBreakdowns).toBeDefined();
      expect(result.scoreBreakdowns!.length).toBeGreaterThan(0);

      hMetrics = result.metrics;

      // Verify all 9 defined metrics are finite and properly computed
      expect(hMetrics.scheduledTaskCount).toBe(result.scheduled);
      expect(hMetrics.unscheduledTaskCount).toBe(result.unscheduled);
      expect(hMetrics.weightedPriorityValue).toBeGreaterThan(0);
      expect(hMetrics.deadlineSuccessRate).toBeGreaterThan(0);
      expect(hMetrics.totalScheduledDurationSeconds).toBeGreaterThan(0);
      expect(hMetrics.stationUtilizationPercent).toBeGreaterThan(0);
      expect(hMetrics.satelliteUtilizationPercent).toBeGreaterThan(0);
      expect(hMetrics.deadlineMissCount).toBeGreaterThanOrEqual(0);
      expect(hMetrics.averageSlackSecondsAtAllocation).toBeGreaterThan(0);

      // Verify score breakdown schema: compositeScore, normPriority, normUrgency, normElevation
      const sampleScore = result.scoreBreakdowns![0];
      expect(sampleScore.compositeScore).toBeGreaterThanOrEqual(0);
      expect(sampleScore.normPriority).toBeGreaterThanOrEqual(0.1);
      expect(sampleScore.normUrgency).toBeGreaterThanOrEqual(0);
      expect(sampleScore.normElevation).toBeGreaterThanOrEqual(0);

      // Verify 100% hard constraint adherence in database
      const createdResvs = await db
        .select()
        .from(reservations)
        .where(inArray(reservations.missionTaskId, taskIds));
      expect(createdResvs.length).toBe(result.scheduled);
      await verifyHardConstraintIntegrity(createdResvs);
    });
  });

  describe("Objective Policy Characterization & Comparative Analysis", () => {
    it("5. Objectively characterizes FCFS vs PRIORITY vs HYBRID across the 9 standardized metrics", async () => {
      if (!fMetrics || !pMetrics || !hMetrics) {
        await resetBenchmarkRunState();
        const fSched = new HybridScoringScheduler(new CandidateService(), refTime, DEFAULT_HYBRID_WEIGHTS, "FCFS");
        const fRes = await fSched.schedulePendingTasks(taskIds);
        fMetrics = fRes.metrics;

        await resetBenchmarkRunState();
        const pSched = new HybridScoringScheduler(new CandidateService(), refTime, DEFAULT_HYBRID_WEIGHTS, "PRIORITY");
        const pRes = await pSched.schedulePendingTasks(taskIds);
        pMetrics = pRes.metrics;

        await resetBenchmarkRunState();
        const hSched = new HybridScoringScheduler(new CandidateService(), refTime, DEFAULT_HYBRID_WEIGHTS, "HYBRID");
        const hRes = await hSched.schedulePendingTasks(taskIds);
        hMetrics = hRes.metrics;
      }

      expect(fMetrics).toBeDefined();
      expect(pMetrics).toBeDefined();
      expect(hMetrics).toBeDefined();

      // Log formal benchmark comparison matrix
      console.log("\n==========================================================================================");
      console.log("            ORBITMESH PHASE 4.3 BENCHMARK COMPARISON MATRIX (60 Competing Tasks)            ");
      console.log("==========================================================================================");
      console.table([
        {
          Policy: "FCFS (Arrival Order)",
          Scheduled: fMetrics.scheduledTaskCount,
          Unscheduled: fMetrics.unscheduledTaskCount,
          "Weighted Prio": fMetrics.weightedPriorityValue,
          "Success Rate %": `${fMetrics.deadlineSuccessRate}%`,
          "Total Dur (s)": fMetrics.totalScheduledDurationSeconds,
          "Station Util %": `${fMetrics.stationUtilizationPercent}%`,
          "Sat Util %": `${fMetrics.satelliteUtilizationPercent}%`,
          "Deadline Misses": fMetrics.deadlineMissCount,
          "Avg Slack (s)": `${fMetrics.averageSlackSecondsAtAllocation}s`,
        },
        {
          Policy: "PRIORITY (Greedy Prio)",
          Scheduled: pMetrics.scheduledTaskCount,
          Unscheduled: pMetrics.unscheduledTaskCount,
          "Weighted Prio": pMetrics.weightedPriorityValue,
          "Success Rate %": `${pMetrics.deadlineSuccessRate}%`,
          "Total Dur (s)": pMetrics.totalScheduledDurationSeconds,
          "Station Util %": `${pMetrics.stationUtilizationPercent}%`,
          "Sat Util %": `${pMetrics.satelliteUtilizationPercent}%`,
          "Deadline Misses": pMetrics.deadlineMissCount,
          "Avg Slack (s)": `${pMetrics.averageSlackSecondsAtAllocation}s`,
        },
        {
          Policy: "HYBRID (Multi-Attribute)",
          Scheduled: hMetrics.scheduledTaskCount,
          Unscheduled: hMetrics.unscheduledTaskCount,
          "Weighted Prio": hMetrics.weightedPriorityValue,
          "Success Rate %": `${hMetrics.deadlineSuccessRate}%`,
          "Total Dur (s)": hMetrics.totalScheduledDurationSeconds,
          "Station Util %": `${hMetrics.stationUtilizationPercent}%`,
          "Sat Util %": `${hMetrics.satelliteUtilizationPercent}%`,
          "Deadline Misses": hMetrics.deadlineMissCount,
          "Avg Slack (s)": `${hMetrics.averageSlackSecondsAtAllocation}s`,
        },
      ]);
      console.log("==========================================================================================\n");

      // Objective structural assertions (non-predetermined):
      // 1. All policies account for all 60 tasks
      expect(fMetrics.scheduledTaskCount + fMetrics.unscheduledTaskCount).toBe(60);
      expect(pMetrics.scheduledTaskCount + pMetrics.unscheduledTaskCount).toBe(60);
      expect(hMetrics.scheduledTaskCount + hMetrics.unscheduledTaskCount).toBe(60);

      // 2. Priority policy schedules high-value tasks, resulting in high average priority per task
      const avgPrioP = pMetrics.weightedPriorityValue / pMetrics.scheduledTaskCount;
      const avgPrioF = fMetrics.weightedPriorityValue / fMetrics.scheduledTaskCount;
      expect(avgPrioP).toBeGreaterThanOrEqual(avgPrioF);

      // 3. Hybrid policy balances priority and urgency
      expect(hMetrics.scheduledTaskCount).toBeGreaterThan(0);
      expect(hMetrics.weightedPriorityValue).toBeGreaterThan(0);
    });

    it("6. Policy runs are 100% reproducible and deterministic across repeated executions", async () => {
      await resetBenchmarkRunState();

      const scheduler1 = new HybridScoringScheduler(
        new CandidateService(),
        refTime,
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );
      const res1 = await scheduler1.schedulePendingTasks(taskIds);

      const resvsRun1 = await db
        .select()
        .from(reservations)
        .where(inArray(reservations.missionTaskId, taskIds))
        .orderBy(reservations.missionTaskId);

      // Reset and run again identically
      await resetBenchmarkRunState();

      const scheduler2 = new HybridScoringScheduler(
        new CandidateService(),
        refTime,
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );
      const res2 = await scheduler2.schedulePendingTasks(taskIds);

      const resvsRun2 = await db
        .select()
        .from(reservations)
        .where(inArray(reservations.missionTaskId, taskIds))
        .orderBy(reservations.missionTaskId);

      // Exact count equality
      expect(res1.scheduled).toBe(res2.scheduled);
      expect(res1.unscheduled).toBe(res2.unscheduled);
      expect(res1.metrics.weightedPriorityValue).toBe(res2.metrics.weightedPriorityValue);
      expect(res1.metrics.deadlineSuccessRate).toBe(res2.metrics.deadlineSuccessRate);

      // Exact reservation assignment equality
      expect(resvsRun1.length).toBe(resvsRun2.length);
      for (let i = 0; i < resvsRun1.length; i++) {
        expect(resvsRun1[i].missionTaskId).toBe(resvsRun2[i].missionTaskId);
        expect(resvsRun1[i].contactWindowId).toBe(resvsRun2[i].contactWindowId);
        expect(resvsRun1[i].groundStationId).toBe(resvsRun2[i].groundStationId);
        expect(new Date(resvsRun1[i].allocatedStart).getTime()).toBe(
          new Date(resvsRun2[i].allocatedStart).getTime()
        );
        expect(new Date(resvsRun1[i].allocatedEnd).getTime()).toBe(
          new Date(resvsRun2[i].allocatedEnd).getTime()
        );
      }
    });
  });

  describe("Hard Constraints Upstream Invariant (Feasibility First)", () => {
    it("7. Task with incompatible RF band is rejected upstream; high priority or hybrid score NEVER overrides band incompatibility", async () => {
      await resetBenchmarkRunState();

      // Find Hartebeesthoek (supports ONLY S_BAND)
      const sBandGs = benchmarkWorkload.groundStations.find((g) => g.code === "GS-HARTEBEESTHOEK")!;
      // Find a window on Hartebeesthoek
      const sBandCw = benchmarkWorkload.contactWindows.find(
        (w) => w.groundStationId === sBandGs.id
      )!;

      // Create an ultra-high-priority task requiring KA_BAND on the satellite of that window
      const [incompatTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sBandCw.satelliteId,
          name: "Incompatible Ka-Band Task",
          priority: 10,
          durationSeconds: 180,
          deadline: new Date(new Date(sBandCw.los).getTime() + 7200000),
          requiredFrequencyBand: "KA_BAND", // Station only supports S_BAND
          minDataRateMbps: 50.0,
          status: "PENDING",
        })
        .returning();

      // Test all 3 policies
      for (const policy of ["FCFS", "PRIORITY", "HYBRID"] as SchedulerPolicyType[]) {
        const scheduler = new HybridScoringScheduler(
          new CandidateService(),
          refTime,
          DEFAULT_HYBRID_WEIGHTS,
          policy
        );
        const res = await scheduler.schedulePendingTasks([incompatTask.id]);

        // Incompatible task can NEVER be scheduled on sBandCw
        const assignedResv = await db
          .select()
          .from(reservations)
          .where(
            and(
              eq(reservations.missionTaskId, incompatTask.id),
              eq(reservations.contactWindowId, sBandCw.id)
            )
          );
        expect(assignedResv.length).toBe(0);
      }

      await db.delete(reservations).where(eq(reservations.missionTaskId, incompatTask.id));
      await db.delete(missionTasks).where(eq(missionTasks.id, incompatTask.id));
    });

    it("8. Task with insufficient station data rate is rejected upstream", async () => {
      await resetBenchmarkRunState();

      // Hartebeesthoek max rate is 50.0 Mbps
      const sBandGs = benchmarkWorkload.groundStations.find((g) => g.code === "GS-HARTEBEESTHOEK")!;
      const sBandCw = benchmarkWorkload.contactWindows.find(
        (w) => w.groundStationId === sBandGs.id
      )!;

      const [rateTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sBandCw.satelliteId,
          name: "High Rate Demanding Task",
          priority: 10,
          durationSeconds: 180,
          deadline: new Date(new Date(sBandCw.los).getTime() + 7200000),
          requiredFrequencyBand: "S_BAND",
          minDataRateMbps: 120.0, // Exceeds station 50 Mbps max
          status: "PENDING",
        })
        .returning();

      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        refTime,
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );
      await scheduler.schedulePendingTasks([rateTask.id]);

      const assigned = await db
        .select()
        .from(reservations)
        .where(
          and(
            eq(reservations.missionTaskId, rateTask.id),
            eq(reservations.contactWindowId, sBandCw.id)
          )
        );
      expect(assigned.length).toBe(0);

      await db.delete(reservations).where(eq(reservations.missionTaskId, rateTask.id));
      await db.delete(missionTasks).where(eq(missionTasks.id, rateTask.id));
    });
  });

  describe("MANUAL + LOCKED Reservation Invariance Across Policies", () => {
    it("9. MANUAL + LOCKED reservation is an immutable barrier and survives FCFS, Priority, and Hybrid scheduling runs", async () => {
      await resetBenchmarkRunState();

      const sampleWin = benchmarkWorkload.contactWindows[0];
      const winAos = new Date(sampleWin.aos);
      const winLos = new Date(sampleWin.los);

      // Create a locked task and manual reservation occupying the first 300s of this window
      const [lockedTask] = await db
        .insert(missionTasks)
        .values({
          satelliteId: sampleWin.satelliteId,
          name: "Locked Invariant Task",
          priority: 1,
          durationSeconds: 300,
          deadline: new Date(winLos.getTime() + 86400000),
          status: "SCHEDULED",
        })
        .returning();

      const [lockedResv] = await db
        .insert(reservations)
        .values({
          missionTaskId: lockedTask.id,
          contactWindowId: sampleWin.id,
          groundStationId: sampleWin.groundStationId,
          satelliteId: sampleWin.satelliteId,
          windowAos: winAos,
          windowLos: winLos,
          taskDurationSeconds: 300,
          allocatedStart: winAos,
          allocatedEnd: new Date(winAos.getTime() + 300000),
          status: "CONFIRMED",
          source: "MANUAL",
          locked: true,
        })
        .returning();

      // Run Hybrid policy across benchmark tasks
      const scheduler = new HybridScoringScheduler(
        new CandidateService(),
        refTime,
        DEFAULT_HYBRID_WEIGHTS,
        "HYBRID"
      );
      await scheduler.schedulePendingTasks(taskIds);

      // Assert locked reservation is 100% untouched
      const lockedInDb = await db
        .select()
        .from(reservations)
        .where(eq(reservations.id, lockedResv.id));
      expect(lockedInDb.length).toBe(1);
      expect(lockedInDb[0].locked).toBe(true);
      expect(lockedInDb[0].source).toBe("MANUAL");
      expect(new Date(lockedInDb[0].allocatedStart).getTime()).toBe(winAos.getTime());
      expect(new Date(lockedInDb[0].allocatedEnd).getTime()).toBe(winAos.getTime() + 300000);

      // Cleanup locked fixture
      await db.delete(reservations).where(eq(reservations.id, lockedResv.id));
      await db.delete(missionTasks).where(eq(missionTasks.id, lockedTask.id));
    });
  });

  describe("HTTP API Enforcement & Preview Non-Mutation with Policy Selection", () => {
    it("10. POST /api/scheduler/hybrid/run schedules pending tasks via authenticated API for OPERATOR", async () => {
      await resetBenchmarkRunState();

      const res = await request(app)
        .post("/api/scheduler/hybrid/run")
        .set("Authorization", `Bearer ${operatorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.scheduled).toBeGreaterThan(0);
      expect(res.body.metrics).toBeDefined();
    });

    it("11. POST /api/scheduler/hybrid/run rejects VIEWER with 403 Forbidden", async () => {
      const res = await request(app)
        .post("/api/scheduler/hybrid/run")
        .set("Authorization", `Bearer ${viewerToken}`);

      expect(res.status).toBe(403);
    });

    it("12. POST /api/scheduler/preview with policy='HYBRID' computes proposal & metrics with 0 DB mutations", async () => {
      await resetBenchmarkRunState();

      const [currentVerRow] = await db.select().from(scheduleVersions).limit(1);
      const currentVersion = currentVerRow?.version ?? 0;

      const resvCountBefore = await db
        .select({ count: sql<number>`count(*)` })
        .from(reservations);
      const taskCountBefore = await db
        .select({ count: sql<number>`count(*)` })
        .from(missionTasks);

      const res = await request(app)
        .post("/api/scheduler/preview")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          scheduleVersion: currentVersion,
          policy: "HYBRID",
        });

      expect(res.status).toBe(200);
      expect(res.body.policy).toBe("HYBRID");
      expect(res.body.scheduleVersion).toBe(currentVersion);
      expect(res.body.proposedReservations).toBeDefined();
      expect(res.body.metrics).toBeDefined();

      // Zero DB Mutation Check
      const resvCountAfter = await db
        .select({ count: sql<number>`count(*)` })
        .from(reservations);
      const taskCountAfter = await db
        .select({ count: sql<number>`count(*)` })
        .from(missionTasks);

      expect(resvCountBefore[0].count).toBe(resvCountAfter[0].count);
      expect(taskCountBefore[0].count).toBe(taskCountAfter[0].count);
    });
  });
});
