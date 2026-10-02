/**
 * OrbitMesh Phase 4.3 - HybridScoringScheduler & Multi-Policy Engine
 * 
 * Formal implementation of the Phase 4.3 Scheduling Pipeline:
 * 
 *   Candidate
 *      ↓
 *   ConstraintValidationService (Hard Operational & Capability Constraints)
 *      ↓
 *   FEASIBLE candidates only
 *      ↓
 *   ┌──────────────────────────────┐
 *   │ Policy Selection             │
 *   │                              │
 *   │ FCFS                         │
 *   │ PRIORITY                     │
 *   │ HYBRID                       │
 *   └──────────────┬───────────────┘
 *                  ↓
 *             Score / Rank
 *                  ↓
 *             Select Allocation
 * 
 * Core Invariants:
 * 1. Hard constraints upstream: Feasibility is strictly determined by
 *    ConstraintValidationService BEFORE any candidate is scored or ranked.
 * 2. Feasibility can never be overcome by policy score or priority.
 * 3. Locked (MANUAL + LOCKED) reservations are strictly respected as hard barriers.
 * 4. Deterministic tie-breaking:
 *    - FCFS: createdAt ASC -> windowAos ASC -> taskId ASC
 *    - PRIORITY: priority DESC -> windowAos ASC -> deadline ASC -> createdAt ASC -> taskId ASC
 *    - HYBRID: compositeScore DESC -> priority DESC -> windowAos ASC -> createdAt ASC -> taskId ASC
 * 5. Multi-channel station concurrent capacity and single transceiver satellite constraints enforced.
 */

import { db, txContext } from "../../db/client";
import { missionTasks, reservations, contactWindows, groundStations } from "../../db/schema";
import { eq, and, ne } from "drizzle-orm";
import { CandidateService } from "./candidate-service";
import { SchedulerResult, TaskOutcome } from "./types";
import { SchedulerPolicy } from "./hybrid-policy";
import { constraintValidator } from "../reservations/constraint-validator";
import {
  calculateHybridCandidateScore,
  calculateBenchmarkMetrics,
  HybridScoringWeights,
  DEFAULT_HYBRID_WEIGHTS,
  PolicyBenchmarkMetrics,
} from "./scoring";

export type SchedulerPolicyType = "FCFS" | "PRIORITY" | "HYBRID";

export interface CandidatePair {
  task: any;
  window: any;
  station: any;
  compositeScore: number;
  normPriority: number;
  normUrgency: number;
  normElevation: number;
}

/**
 * Checks if a candidate interval [startMs, endMs] can be accommodated
 * on a ground station without exceeding its maxConcurrentContacts capacity.
 */
function isStationCapacityAvailable(
  startMs: number,
  endMs: number,
  stationResvs: Array<{ allocatedStart: Date; allocatedEnd: Date }>,
  capacity: number
): boolean {
  const overlapping = stationResvs.filter(
    (r) => r.allocatedStart.getTime() < endMs && r.allocatedEnd.getTime() > startMs
  );
  if (overlapping.length < capacity) {
    return true;
  }
  const subPoints = new Set<number>([startMs, endMs]);
  for (const r of overlapping) {
    const s = r.allocatedStart.getTime();
    const e = r.allocatedEnd.getTime();
    if (s > startMs && s < endMs) subPoints.add(s);
    if (e > startMs && e < endMs) subPoints.add(e);
  }
  const sortedSub = Array.from(subPoints).sort((a, b) => a - b);
  for (let i = 0; i < sortedSub.length - 1; i++) {
    const s0 = sortedSub[i]!;
    const s1 = sortedSub[i + 1]!;
    const mid = (s0 + s1) / 2;
    const concurrentAtMid = overlapping.filter(
      (r) => r.allocatedStart.getTime() < mid && r.allocatedEnd.getTime() > mid
    ).length;
    if (concurrentAtMid >= capacity) {
      return false;
    }
  }
  return true;
}

/**
 * Finds the earliest feasible interval in a contact window that satisfies:
 * 1. Window bounds: [window.aos, window.los]
 * 2. Task deadline: allocatedEnd <= task.deadline
 * 3. Satellite transceiver exclusivity: no other contact for satelliteId at the same time
 * 4. Ground station concurrent contacts <= stationCapacity
 */
function findEarliestFeasibleSlotInWindow(
  task: { id: string; satelliteId: string; durationSeconds: number; deadline: Date },
  window: { aos: Date; los: Date; groundStationId: string },
  stationCapacity: number,
  stationResvs: Array<{ allocatedStart: Date; allocatedEnd: Date }>,
  satelliteResvs: Array<{ allocatedStart: Date; allocatedEnd: Date }>
): { start: Date; end: Date } | null {
  const durationMs = task.durationSeconds * 1000;
  const winAos = window.aos.getTime();
  const winLos = window.los.getTime();
  const deadlineMs = task.deadline.getTime();

  const points = new Set<number>([winAos]);
  for (const r of stationResvs) {
    const s = r.allocatedStart.getTime();
    const e = r.allocatedEnd.getTime();
    if (s >= winAos && s < winLos) points.add(s);
    if (e >= winAos && e < winLos) points.add(e);
  }
  for (const r of satelliteResvs) {
    const s = r.allocatedStart.getTime();
    const e = r.allocatedEnd.getTime();
    if (s >= winAos && s < winLos) points.add(s);
    if (e >= winAos && e < winLos) points.add(e);
  }

  const sortedPoints = Array.from(points).sort((a, b) => a - b);

  for (const pt of sortedPoints) {
    const startMs = pt;
    const endMs = startMs + durationMs;

    if (endMs > winLos) break;
    if (endMs > deadlineMs) break;

    // Check satellite conflict (single transceiver exclusivity)
    const satConflict = satelliteResvs.some(
      (r) => r.allocatedStart.getTime() < endMs && r.allocatedEnd.getTime() > startMs
    );
    if (satConflict) continue;

    // Check ground station concurrent capacity
    if (!isStationCapacityAvailable(startMs, endMs, stationResvs, stationCapacity)) {
      continue;
    }

    return { start: new Date(startMs), end: new Date(endMs) };
  }

  return null;
}

export class HybridScoringScheduler implements SchedulerPolicy {
  constructor(
    private candidateService: CandidateService = new CandidateService(),
    private referenceTime: Date = new Date(),
    private weights: HybridScoringWeights = DEFAULT_HYBRID_WEIGHTS,
    public policyType: SchedulerPolicyType = "HYBRID"
  ) {}

  async schedulePendingTasks(targetTaskIds?: string[]): Promise<SchedulerResult> {
    const dbOrTx = txContext.getStore() || db;

    // 1. Fetch active reservations to avoid one_active_reservation_per_task violations
    const existingReservations = await dbOrTx
      .select()
      .from(reservations)
      .where(and(ne(reservations.status, "CANCELLED"), ne(reservations.status, "FAILED")));

    const activeTaskIds = new Set(existingReservations.map((r: any) => r.missionTaskId));

    const activeReservationsByStation = new Map<string, any[]>();
    const activeReservationsBySatellite = new Map<string, any[]>();

    for (const resv of existingReservations) {
      const gsList = activeReservationsByStation.get(resv.groundStationId) || [];
      gsList.push(resv);
      activeReservationsByStation.set(resv.groundStationId, gsList);

      const satList = activeReservationsBySatellite.get(resv.satelliteId) || [];
      satList.push(resv);
      activeReservationsBySatellite.set(resv.satelliteId, satList);
    }

    // 2. Fetch pending tasks
    const allPending = await dbOrTx
      .select()
      .from(missionTasks)
      .where(eq(missionTasks.status, "PENDING"));

    const pendingTasks = allPending
      .filter((t: any) => !activeTaskIds.has(t.id))
      .filter((t: any) => !targetTaskIds || targetTaskIds.includes(t.id));

    if (pendingTasks.length === 0) {
      return { scheduled: 0, unscheduled: 0, results: [] };
    }

    // 3. Fetch windows and stations
    const allWindows = await dbOrTx.select().from(contactWindows);
    const allStations = await dbOrTx.select().from(groundStations);

    const groundStationsById = new Map<string, any>();
    for (const gs of allStations) {
      groundStationsById.set(gs.id, gs);
    }

    // 4. Upstream Candidate Generation & Hard Constraint Validation (Feasibility First)
    const candidatePairs: CandidatePair[] = [];
    const taskFeasibilityMap = new Map<string, { isFeasible: boolean; reason?: string | undefined }>();
    const scoreBreakdowns: any[] = [];

    for (const task of pendingTasks) {
      const satWindows = allWindows
        .filter((w: any) => w.satelliteId === task.satelliteId)
        .sort((a: any, b: any) => a.aos.getTime() - b.aos.getTime());

      if (satWindows.length === 0) {
        taskFeasibilityMap.set(task.id, { isFeasible: false, reason: "NO_FEASIBLE_WINDOW" });
        continue;
      }

      let anyWindowFeasible = false;
      let primaryReason: string | undefined = undefined;

      for (const window of satWindows) {
        const station = groundStationsById.get(window.groundStationId);

        // Authoritative Static Hard Constraints via ConstraintValidationService
        const winVal = constraintValidator.validateCandidateWindow(task, window, station);
        if (!winVal.valid) {
          if (!primaryReason) {
            const hasBandErr = winVal.errors.some((e) => e.code === "INCOMPATIBLE_FREQUENCY_BAND");
            const hasRateErr = winVal.errors.some((e) => e.code === "INSUFFICIENT_STATION_DATA_RATE");
            const hasDeadlineErr = winVal.errors.some(
              (e) => e.code === "DEADLINE_EXCEEDED" || e.code === "INSUFFICIENT_SLACK"
            );
            if (hasBandErr) primaryReason = "INCOMPATIBLE_FREQUENCY_BAND";
            else if (hasRateErr) primaryReason = "INSUFFICIENT_STATION_DATA_RATE";
            else if (hasDeadlineErr) primaryReason = "DEADLINE_EXCEEDED";
            else primaryReason = "NO_FEASIBLE_WINDOW";
          }
          continue;
        }

        anyWindowFeasible = true;

        // Calculate Multi-Attribute Hybrid Score:
        // Score = w_prio * NormPriority + w_urg * NormUrgency + w_qual * NormElevation
        const score = calculateHybridCandidateScore(
          task,
          window,
          this.referenceTime,
          this.weights
        );

        candidatePairs.push({
          task,
          window,
          station,
          compositeScore: score.compositeScore,
          normPriority: score.normPriority,
          normUrgency: score.normUrgency,
          normElevation: score.normElevation,
        });

        scoreBreakdowns.push({
          taskId: task.id,
          windowId: window.id,
          ...score,
        });
      }

      taskFeasibilityMap.set(task.id, {
        isFeasible: anyWindowFeasible,
        reason: anyWindowFeasible ? undefined : (primaryReason || "NO_FEASIBLE_WINDOW"),
      });
    }

    // 5. Policy Ranking Layer
    // Strictly orders the FEASIBLE candidate pairs based on the active policy:
    // FCFS, PRIORITY, or HYBRID.
    if (this.policyType === "FCFS") {
      candidatePairs.sort((a, b) => {
        const timeDiff = a.task.createdAt.getTime() - b.task.createdAt.getTime();
        if (timeDiff !== 0) return timeDiff;
        const aosDiff = a.window.aos.getTime() - b.window.aos.getTime();
        if (aosDiff !== 0) return aosDiff;
        return a.task.id.localeCompare(b.task.id);
      });
    } else if (this.policyType === "PRIORITY") {
      candidatePairs.sort((a, b) => {
        if (a.task.priority !== b.task.priority) {
          return b.task.priority - a.task.priority; // Priority DESC
        }
        const aosDiff = a.window.aos.getTime() - b.window.aos.getTime();
        if (aosDiff !== 0) return aosDiff;
        const dlDiff = a.task.deadline.getTime() - b.task.deadline.getTime();
        if (dlDiff !== 0) return dlDiff;
        const crDiff = a.task.createdAt.getTime() - b.task.createdAt.getTime();
        if (crDiff !== 0) return crDiff;
        return a.task.id.localeCompare(b.task.id);
      });
    } else {
      // HYBRID Policy: multi-attribute composite score DESC
      candidatePairs.sort((a, b) => {
        if (Math.abs(a.compositeScore - b.compositeScore) > 0.0001) {
          return b.compositeScore - a.compositeScore; // Score DESC
        }
        if (a.task.priority !== b.task.priority) {
          return b.task.priority - a.task.priority; // Tie-breaker: Priority DESC
        }
        const aosDiff = a.window.aos.getTime() - b.window.aos.getTime();
        if (aosDiff !== 0) return aosDiff;
        const crDiff = a.task.createdAt.getTime() - b.task.createdAt.getTime();
        if (crDiff !== 0) return crDiff;
        return a.task.id.localeCompare(b.task.id);
      });
    }

    // 6. Dynamic Slot Selection & Allocation Execution
    const scheduledTaskIds = new Set<string>();
    const allocatedReservations: any[] = [];
    const results: TaskOutcome[] = [];
    let scheduled = 0;
    let unscheduled = 0;

    for (const cand of candidatePairs) {
      if (scheduledTaskIds.has(cand.task.id)) {
        continue; // Task already scheduled in its highest-ranked window
      }

      const task = cand.task;
      const window = cand.window;
      const station = cand.station;
      const stationCapacity = station?.maxConcurrentContacts ?? 1;

      const currentStationResvs = activeReservationsByStation.get(window.groundStationId) || [];
      const currentSatResvs = activeReservationsBySatellite.get(task.satelliteId) || [];

      // Find earliest feasible slot dynamically
      const slot = findEarliestFeasibleSlotInWindow(
        task,
        window,
        stationCapacity,
        currentStationResvs,
        currentSatResvs
      );

      if (!slot) {
        // Cannot fit in this window; continue to next candidate pair for this or other tasks
        continue;
      }

      // Final authoritative check via ConstraintValidationService
      const validation = await constraintValidator.validate(
        {
          taskId: task.id,
          contactWindowId: window.id,
          startTime: slot.start,
          endTime: slot.end,
        },
        dbOrTx
      );

      if (!validation.valid) continue;

      // Atomic commit
      try {
        const resvId = await dbOrTx.transaction(async (tx: any) => {
          const updateTask = await tx
            .update(missionTasks)
            .set({ status: "SCHEDULED" })
            .where(and(eq(missionTasks.id, task.id), eq(missionTasks.status, "PENDING")))
            .returning();

          if (updateTask.length === 0) {
            throw new Error("TASK_ALREADY_HANDLED");
          }

          const [inserted] = await tx
            .insert(reservations)
            .values({
              missionTaskId: task.id,
              contactWindowId: window.id,
              groundStationId: window.groundStationId,
              satelliteId: task.satelliteId,
              windowAos: window.aos,
              windowLos: window.los,
              taskDurationSeconds: task.durationSeconds,
              allocatedStart: slot.start,
              allocatedEnd: slot.end,
              status: "PENDING",
              source: "AUTOMATED",
              locked: false,
            })
            .returning();

          return inserted.id;
        });

        // Add to active reservation maps
        const newResvRecord = {
          id: resvId,
          missionTaskId: task.id,
          contactWindowId: window.id,
          groundStationId: window.groundStationId,
          satelliteId: task.satelliteId,
          allocatedStart: slot.start,
          allocatedEnd: slot.end,
          status: "PENDING",
          source: "AUTOMATED",
          locked: false,
        };

        currentStationResvs.push(newResvRecord);
        activeReservationsByStation.set(window.groundStationId, currentStationResvs);

        currentSatResvs.push(newResvRecord);
        activeReservationsBySatellite.set(task.satelliteId, currentSatResvs);

        allocatedReservations.push(newResvRecord);
        scheduledTaskIds.add(task.id);
        scheduled++;
        results.push({
          taskId: task.id,
          status: "SCHEDULED",
          reservationId: resvId,
        });
      } catch (err: any) {
        if (err.message === "TASK_ALREADY_HANDLED") {
          scheduledTaskIds.add(task.id);
          continue;
        }
        const errMsg = err.message || "";
        const causeMsg = err.cause?.message || "";
        if (
          errMsg.includes("one_active_reservation_per_task") ||
          causeMsg.includes("one_active_reservation_per_task")
        ) {
          scheduledTaskIds.add(task.id);
          continue;
        }
        throw err;
      }
    }

    // 7. Collect Unscheduled Tasks
    for (const task of pendingTasks) {
      if (!scheduledTaskIds.has(task.id)) {
        unscheduled++;
        const feas = taskFeasibilityMap.get(task.id);
        results.push({
          taskId: task.id,
          status: "UNSCHEDULED",
          reason: feas?.reason || "NO_FEASIBLE_WINDOW",
        });
      }
    }

    // 8. Compute Standardized Benchmark Metrics
    const metrics: PolicyBenchmarkMetrics = calculateBenchmarkMetrics(
      pendingTasks,
      allWindows,
      allocatedReservations,
      results
    );

    return {
      scheduled,
      unscheduled,
      results,
      metrics,
      scoreBreakdowns,
    };
  }
}
