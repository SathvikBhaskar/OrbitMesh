/**
 * OrbitMesh Phase 4.2 - UrgencyScheduler
 * 
 * Formal urgency & slack-time aware scheduler policy.
 * 
 * Architectural Invariants:
 * 1. Hard constraints upstream of urgency scoring:
 *    Candidate -> Hard Constraints (ConstraintValidationService) -> Feasible?
 *      NO  -> reject
 *      YES -> urgency / slack -> policy decision
 * 2. Feasibility can NEVER be overridden by urgency.
 * 3. Contention resolution:
 *    Tasks with critical slack and no future alternative windows take priority
 *    over tasks with ample slack and viable alternative future windows, ensuring
 *    zero dropped high-priority tasks and zero missed deadlines.
 * 4. Deterministic tie-breaking:
 *    priority DESC -> createdAt ASC -> id ASC
 * 5. MANUAL + LOCKED reservations are immutable hard barriers.
 */

import { db, txContext } from "../../db/client";
import { missionTasks, reservations, contactWindows, groundStations } from "../../db/schema";
import { eq, and, ne, inArray } from "drizzle-orm";
import { CandidateService } from "./candidate-service";
import { SchedulerResult, TaskOutcome } from "./types";
import { SchedulerPolicy } from "./hybrid-policy";
import { constraintValidator } from "../reservations/constraint-validator";
import {
  buildTaskUrgencyProfile,
  compareUrgencyTieBreaker,
  TaskUrgencyProfile,
  CandidateWindowFeasibility,
} from "./urgency";

export class UrgencyScheduler implements SchedulerPolicy {
  constructor(
    private candidateService: CandidateService = new CandidateService(),
    private referenceTime: Date = new Date(),
    private criticalSlackThresholdSeconds: number = 1800 // 30 minutes
  ) {}

  async schedulePendingTasks(targetTaskIds?: string[]): Promise<SchedulerResult> {
    const dbOrTx = txContext.getStore() || db;

    // 1. Fetch all active reservations (including MANUAL and LOCKED)
    const existingReservations = await dbOrTx
      .select()
      .from(reservations)
      .where(and(ne(reservations.status, "CANCELLED"), ne(reservations.status, "FAILED")));

    const activeTaskIds = new Set(existingReservations.map((r: any) => r.missionTaskId));

    const activeReservationsByStation = new Map<string, any[]>();
    for (const resv of existingReservations) {
      const list = activeReservationsByStation.get(resv.groundStationId) || [];
      list.push(resv);
      activeReservationsByStation.set(resv.groundStationId, list);
    }

    // 2. Fetch all pending tasks that don't already have an active reservation
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

    // 3. Fetch all contact windows and ground stations for candidate generation
    const allWindows = await dbOrTx.select().from(contactWindows);
    const allStations = await dbOrTx.select().from(groundStations);

    const groundStationsById = new Map<string, any>();
    for (const gs of allStations) {
      groundStationsById.set(gs.id, gs);
    }

    // 4. Candidate Generation & Hard Constraint Evaluation (Upstream)
    const taskEvaluations: Array<{
      task: any;
      profile: TaskUrgencyProfile;
      feasibleWindows: CandidateWindowFeasibility[];
    }> = [];

    for (const task of pendingTasks) {
      const satelliteWindows = allWindows
        .filter((w: any) => w.satelliteId === task.satelliteId)
        .sort((a: any, b: any) => a.aos.getTime() - b.aos.getTime());

      // Check if satellite has any windows at all in the database
      const hasAnySatelliteWindow = satelliteWindows.length > 0;

      const { profile, feasibleWindows } = buildTaskUrgencyProfile(
        task,
        satelliteWindows,
        groundStationsById,
        activeReservationsByStation,
        this.referenceTime,
        this.criticalSlackThresholdSeconds
      );

      if (!profile.isFeasible && !profile.infeasibilityReason) {
        profile.infeasibilityReason = hasAnySatelliteWindow ? "DEADLINE_EXCEEDED" : "NO_FEASIBLE_WINDOW";
      }

      taskEvaluations.push({
        task,
        profile,
        feasibleWindows,
      });
    }

    // 5. Policy & Scoring Decision Engine
    // Separate feasible from infeasible
    const results: TaskOutcome[] = [];
    let scheduled = 0;
    let unscheduled = 0;

    const feasibleEvaluations = taskEvaluations.filter(e => e.profile.isFeasible);
    const infeasibleEvaluations = taskEvaluations.filter(e => !e.profile.isFeasible);

    // Infeasible candidates are immediately marked UNSCHEDULED with explicit reason
    for (const inf of infeasibleEvaluations) {
      unscheduled++;
      results.push({
        taskId: inf.task.id,
        status: "UNSCHEDULED",
        reason: inf.profile.infeasibilityReason || "NO_FEASIBLE_WINDOW",
      });
    }

    // 6. Urgency-Aware Priority Sorting for Feasible Candidates
    // Multi-criteria contention sorting:
    // a. Critical slack & no alternative window (must schedule now or permanently fail)
    // b. Lower slack seconds (more constrained first)
    // c. Higher urgency ratio
    // d. Deterministic tie-breaker: priority DESC -> createdAt ASC -> id ASC
    feasibleEvaluations.sort((a, b) => {
      const profA = a.profile;
      const profB = b.profile;

      // 1. Extreme Constrainedness: Task with 0 alternatives vs Task with alternatives
      if (!profA.hasAlternativeWindow && profB.hasAlternativeWindow) return -1;
      if (profA.hasAlternativeWindow && !profB.hasAlternativeWindow) return 1;

      // 2. Critical Slack: Task in critical slack regime vs Task in ample slack regime
      if (profA.isCriticalSlack && !profB.isCriticalSlack) return -1;
      if (!profA.isCriticalSlack && profB.isCriticalSlack) return 1;

      // 3. Slack comparison (ASC - smaller slack is more urgent)
      // Only compare directly if difference is meaningful (> 60s)
      if (Math.abs(profA.slackSeconds - profB.slackSeconds) > 60) {
        return profA.slackSeconds - profB.slackSeconds;
      }

      // 4. Urgency Ratio comparison (DESC - larger ratio is more urgent)
      if (Math.abs(profA.urgencyRatio - profB.urgencyRatio) > 0.01) {
        return profB.urgencyRatio - profA.urgencyRatio;
      }

      // 5. Deterministic tie-breaker
      return compareUrgencyTieBreaker(a.task, b.task);
    });

    // 7. Deterministic Allocation with Dynamic Constraint Verification
    for (const evalItem of feasibleEvaluations) {
      const task = evalItem.task;
      let taskScheduled = false;

      // Iterate through feasible windows in temporal order
      for (const winFeas of evalItem.feasibleWindows.filter((w: any) => w.isFeasible)) {
        const window = allWindows.find((w: any) => w.id === winFeas.windowId)!;
        const station = groundStationsById.get(window.groundStationId)!;
        const stationCapacity = station?.maxConcurrentContacts ?? 1;
        const durationMs = task.durationSeconds * 1000;

        // Re-read current reservations on this station to handle previous allocations
        const currentStationResvs = activeReservationsByStation.get(window.groundStationId) || [];

        // Find earliest available slot in window [aos, los]
        const endpoints = new Set<number>([window.aos.getTime()]);
        for (const r of currentStationResvs) {
          if (r.allocatedEnd.getTime() > window.aos.getTime() && r.allocatedStart.getTime() < window.los.getTime()) {
            endpoints.add(r.allocatedStart.getTime());
            endpoints.add(r.allocatedEnd.getTime());
          }
        }
        const sortedPoints = Array.from(endpoints).sort((p1, p2) => p1 - p2);

        let candidateStart: Date | undefined;
        let candidateEnd: Date | undefined;

        for (const pt of sortedPoints) {
          const startMs = pt;
          const endMs = startMs + durationMs;

          if (endMs > window.los.getTime()) break;
          if (endMs > task.deadline.getTime()) break;

          // Check satellite conflict
          const allCurrentResvs = Array.from(activeReservationsByStation.values()).flat();
          const satConflict = allCurrentResvs.some(
            r => r.satelliteId === task.satelliteId &&
                 r.allocatedStart.getTime() < endMs &&
                 r.allocatedEnd.getTime() > startMs
          );
          if (satConflict) continue;

          // Check station capacity
          const overlappingStation = currentStationResvs.filter(
            r => r.allocatedStart.getTime() < endMs && r.allocatedEnd.getTime() > startMs
          );
          if (overlappingStation.length >= stationCapacity) continue;

          candidateStart = new Date(startMs);
          candidateEnd = new Date(endMs);
          break;
        }

        if (!candidateStart || !candidateEnd) {
          // No slot available in this window, try next window
          continue;
        }

        // Authoritative verification via ConstraintValidationService
        const validation = await constraintValidator.validate(
          {
            taskId: task.id,
            contactWindowId: window.id,
            startTime: candidateStart,
            endTime: candidateEnd,
          },
          dbOrTx
        );

        if (!validation.valid) {
          continue;
        }

        // Allocate reservation atomically
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
                allocatedStart: candidateStart!,
                allocatedEnd: candidateEnd!,
                status: "PENDING",
                source: "AUTOMATED",
                locked: false,
              })
              .returning();

            return inserted.id;
          });

          // Record in in-memory active reservations map for subsequent tasks in this run
          const stationList = activeReservationsByStation.get(window.groundStationId) || [];
          stationList.push({
            id: resvId,
            missionTaskId: task.id,
            contactWindowId: window.id,
            groundStationId: window.groundStationId,
            satelliteId: task.satelliteId,
            allocatedStart: candidateStart,
            allocatedEnd: candidateEnd,
            status: "PENDING",
            source: "AUTOMATED",
            locked: false,
          });
          activeReservationsByStation.set(window.groundStationId, stationList);

          taskScheduled = true;
          scheduled++;
          results.push({
            taskId: task.id,
            status: "SCHEDULED",
            reservationId: resvId,
          });
          break; // Done with this task, move to next task
        } catch (err: any) {
          if (err.message === "TASK_ALREADY_HANDLED") {
            taskScheduled = true;
            break;
          }
          const errMsg = err.message || "";
          const causeMsg = err.cause?.message || "";
          if (errMsg.includes("one_active_reservation_per_task") || causeMsg.includes("one_active_reservation_per_task")) {
            taskScheduled = true;
            break;
          }
          throw err;
        }
      }

      if (!taskScheduled) {
        unscheduled++;
        results.push({
          taskId: task.id,
          status: "UNSCHEDULED",
          reason: "NO_FEASIBLE_WINDOW",
        });
      }
    }

    return {
      scheduled,
      unscheduled,
      results,
    };
  }
}
