/**
 * OrbitMesh Phase 5.2 - Operational Replanning & Anti-Thrashing Engine
 *
 * Implements continuous operational event processing with strict stability controls:
 * 1. Ground Station Outage locality (IR_station <= E_GS)
 * 2. Dynamically derived Execution Freeze Horizon (zero stale persisted state)
 * 3. Deterministic minimal-cost priority preemption hierarchy:
 *    MANUAL + LOCKED > EXECUTION_FROZEN > automated reservation > unscheduled task
 * 4. Deterministic preemption selection:
 *    priority ASC -> slack DESC -> duration ASC -> reservationId ASC
 * 5. Targeted rescue of displaced tasks with explicit audit tracking
 * 6. Score hysteresis to prevent schedule thrashing / jitter
 * 7. Optimistic concurrency control via atomic scheduleVersion increments
 */

import { db, txContext } from "../../../db/client";
import {
  reservations,
  missionTasks,
  contactWindows,
  groundStations,
  scheduleVersions,
  scheduleAuditLog,
  satelliteOrbitalData,
} from "../../../db/schema";
import { eq, and, inArray, sql, desc, asc, ne } from "drizzle-orm";
import {
  OperationalEvent,
  OperationalReplanningOptions,
  OperationalReplanningResult,
  PreemptionCandidate,
  isExecutionFrozen,
  comparePreemptionCandidates,
} from "./operational-event.types";
import { CandidateService } from "../candidate-service";
import { HybridScoringScheduler } from "../hybrid-scoring-scheduler";
import { UrgencyScheduler } from "../urgency-scheduler";
import { DEFAULT_HYBRID_WEIGHTS } from "../scoring";
import { constraintValidator } from "../../reservations/constraint-validator";

export class OperationalReplanningService {
  private candidateService = new CandidateService();

  /**
   * Main entry point to process an operational event under optimistic concurrency
   * and anti-thrashing guardrails.
   */
  public async handleOperationalEvent(
    event: OperationalEvent,
    options: OperationalReplanningOptions
  ): Promise<OperationalReplanningResult> {
    const refTime = options.referenceTime || new Date();
    const freezeHorizon = options.freezeHorizonSeconds ?? 900; // 15 min default
    const policy = options.policy || "HYBRID";

    // Concurrency Check
    const versionRes = await db.select().from(scheduleVersions).limit(1);
    const vBefore = versionRes[0]?.version || 0;

    switch (event.type) {
      case "STATION_OUTAGE":
        return await this.processStationOutage(event, vBefore, refTime, freezeHorizon, policy, options.userId);
      case "TASK_PREEMPTION":
        return await this.processTaskPreemption(event, vBefore, refTime, freezeHorizon, policy, options.userId);
      case "STATION_RESTORED":
        return await this.processStationRestored(event, vBefore, refTime, policy, options.userId);
      case "CAPACITY_RELEASE":
        return await this.processCapacityRelease(event, vBefore, refTime, policy, options.userId);
      default:
        throw new Error(`Unsupported operational event type: ${(event as any).type}`);
    }
  }

  /**
   * 1. Ground Station Outage Locality
   * Outage on gsId invalidates only overlapping reservations on that station,
   * respecting EXECUTION_FROZEN guardrails, and rescuing displaced tasks.
   */
  private async processStationOutage(
    event: { groundStationId: string; outageStart: Date; outageEnd: Date; reason?: string | undefined },
    vBefore: number,
    refTime: Date,
    freezeHorizon: number,
    policy: string,
    userId: string
  ): Promise<OperationalReplanningResult> {
    const outStart = new Date(event.outageStart);
    const outEnd = new Date(event.outageEnd);

    // Find all active reservations on this ground station overlapping the outage interval
    const candidates = await db
      .select({
        res: reservations,
        task: missionTasks,
      })
      .from(reservations)
      .innerJoin(missionTasks, eq(reservations.missionTaskId, missionTasks.id))
      .where(
        and(
          eq(reservations.groundStationId, event.groundStationId),
          inArray(reservations.status, ["PENDING", "CONFIRMED"]),
          sql`${reservations.allocatedStart} < ${outEnd}`,
          sql`${reservations.allocatedEnd} > ${outStart}`
        )
      );

    if (candidates.length === 0) {
      // No-Op: Outage does not intersect any scheduled pass
      return {
        eventType: "STATION_OUTAGE",
        scheduleVersionBefore: vBefore,
        scheduleVersionAfter: vBefore,
        isNoOp: true,
        displacedReservationsCount: 0,
        frozenBlockedCount: 0,
        rescuedCount: 0,
        unrescuableCount: 0,
        displacedReservationIds: [],
        rescuedReservationIds: [],
        unrescuableTaskIds: [],
        frozenBlockedReservationIds: [],
        details: [],
      };
    }

    const toDisplace: typeof candidates = [];
    const frozenBlocked: typeof candidates = [];

    for (const item of candidates) {
      if (isExecutionFrozen(item.res, refTime, freezeHorizon)) {
        frozenBlocked.push(item);
      } else {
        toDisplace.push(item);
      }
    }

    const displacedIds = toDisplace.map((c) => c.res.id);
    const affectedTaskIds = toDisplace.map((c) => c.task.id);
    const frozenBlockedIds = frozenBlocked.map((c) => c.res.id);

    let rescuedCount = 0;
    let unrescuableCount = 0;
    const rescuedReservationIds: string[] = [];
    const unrescuableTaskIds: string[] = [];
    const details: OperationalReplanningResult["details"] = [];

    await db.transaction(async (tx) => {
      await txContext.run(tx, async () => {
        // Record audit logs for execution-frozen reservations that could not be displaced
        for (const item of frozenBlocked) {
          await tx.insert(scheduleAuditLog).values({
            userId,
            action: "EXECUTION_FREEZE_BLOCKED",
            entityType: "RESERVATION",
            entityId: item.res.id,
            reason: "STATION_OUTAGE_IMMINENT_PASS_PROTECTED",
          });
          details.push({
            action: "EXECUTION_FREEZE_BLOCKED",
            entityId: item.res.id,
            reason: "STATION_OUTAGE_IMMINENT_PASS_PROTECTED",
          });
        }

        // Cancel displaced reservations & reset tasks to PENDING
        if (displacedIds.length > 0) {
          await tx
            .update(reservations)
            .set({ status: "CANCELLED", updatedAt: new Date() })
            .where(inArray(reservations.id, displacedIds));

          await tx
            .update(missionTasks)
            .set({ status: "PENDING", updatedAt: new Date() })
            .where(inArray(missionTasks.id, affectedTaskIds));

          for (const item of toDisplace) {
            await tx.insert(scheduleAuditLog).values({
              userId,
              action: "CANCEL_RESERVATION",
              entityType: "RESERVATION",
              entityId: item.res.id,
              reason: "STATION_OUTAGE_DISPLACEMENT",
            });
            details.push({
              action: "CANCEL_RESERVATION",
              entityId: item.res.id,
              reason: "STATION_OUTAGE_DISPLACEMENT",
            });
          }

          // Reschedule affected tasks onto surviving operational windows
          const scheduler =
            policy === "URGENCY"
              ? new UrgencyScheduler(this.candidateService)
              : new HybridScoringScheduler(this.candidateService, refTime, DEFAULT_HYBRID_WEIGHTS, policy as any);

          const scheduleRes = await scheduler.schedulePendingTasks(affectedTaskIds);
          rescuedCount = scheduleRes.scheduled;
          unrescuableCount = scheduleRes.unscheduled;

          for (const out of scheduleRes.results) {
            if (out.status === "SCHEDULED" && out.reservationId) {
              rescuedReservationIds.push(out.reservationId);
              await tx.insert(scheduleAuditLog).values({
                userId,
                action: "CREATE_RESERVATION",
                entityType: "RESERVATION",
                entityId: out.reservationId,
                reason: `STATION_OUTAGE_RESCUE_${policy}`,
              });
              details.push({
                action: "CREATE_RESERVATION",
                entityId: out.reservationId,
                reason: `STATION_OUTAGE_RESCUE_${policy}`,
              });
            } else if (out.status === "UNSCHEDULED") {
              unrescuableTaskIds.push(out.taskId);
              details.push({
                action: "TASK_UNSCHEDULED",
                entityId: out.taskId,
                reason: out.reason || "NO_ALTERNATE_WINDOW",
              });
            }
          }
        }

        // Increment schedule version if any state change occurred
        if (displacedIds.length > 0 || frozenBlocked.length > 0) {
          await tx
            .update(scheduleVersions)
            .set({ version: vBefore + 1, updatedAt: new Date() })
            .where(eq(scheduleVersions.version, vBefore));
        }
      });
    });

    const isNoOp = displacedIds.length === 0 && frozenBlockedIds.length === 0;

    return {
      eventType: "STATION_OUTAGE",
      scheduleVersionBefore: vBefore,
      scheduleVersionAfter: isNoOp ? vBefore : vBefore + 1,
      isNoOp,
      displacedReservationsCount: displacedIds.length,
      frozenBlockedCount: frozenBlockedIds.length,
      rescuedCount,
      unrescuableCount,
      displacedReservationIds: displacedIds,
      rescuedReservationIds,
      unrescuableTaskIds,
      frozenBlockedReservationIds: frozenBlockedIds,
      details,
    };
  }

  /**
   * 2. Priority Preemption Under Contention
   * Displaces lower-priority automated reservations only when no feasible unoccupied
   * candidate exists, selecting the minimal-cost candidate deterministically.
   */
  private async processTaskPreemption(
    event: { taskId: string; requestedBy?: string | undefined },
    vBefore: number,
    refTime: Date,
    freezeHorizon: number,
    policy: string,
    userId: string
  ): Promise<OperationalReplanningResult> {
    // 1. Fetch high-priority task details
    const [highPriTask] = await db
      .select()
      .from(missionTasks)
      .where(eq(missionTasks.id, event.taskId))
      .limit(1);

    if (!highPriTask) {
      throw new Error(`Task with id ${event.taskId} not found for preemption`);
    }

    // Step A: Attempt non-preemptive scheduling first!
    const nonPreemptiveScheduler =
      policy === "URGENCY"
        ? new UrgencyScheduler(this.candidateService)
        : new HybridScoringScheduler(this.candidateService, refTime, DEFAULT_HYBRID_WEIGHTS, policy as any);

    const initialTry = await nonPreemptiveScheduler.schedulePendingTasks([highPriTask.id]);
    if (initialTry.scheduled === 1 && initialTry.results[0]?.status === "SCHEDULED") {
      const resId = initialTry.results[0].reservationId!;
      await db
        .update(scheduleVersions)
        .set({ version: vBefore + 1, updatedAt: new Date() })
        .where(eq(scheduleVersions.version, vBefore));

      return {
        eventType: "TASK_PREEMPTION",
        scheduleVersionBefore: vBefore,
        scheduleVersionAfter: vBefore + 1,
        isNoOp: false,
        displacedReservationsCount: 0,
        frozenBlockedCount: 0,
        rescuedCount: 0,
        unrescuableCount: 0,
        displacedReservationIds: [],
        rescuedReservationIds: [],
        unrescuableTaskIds: [],
        frozenBlockedReservationIds: [],
        details: [
          {
            action: "SCHEDULED_WITHOUT_PREEMPTION",
            entityId: resId,
            reason: "UNOCCUPIED_SLOT_AVAILABLE",
          },
        ],
      };
    }

    // Step B: Contention! Find candidate contact windows for highPriTask
    const candidateWindows = await this.candidateService.findCandidateWindows(
      highPriTask.satelliteId,
      highPriTask.deadline
    );

    if (candidateWindows.length === 0) {
      return {
        eventType: "TASK_PREEMPTION",
        scheduleVersionBefore: vBefore,
        scheduleVersionAfter: vBefore,
        isNoOp: true,
        displacedReservationsCount: 0,
        frozenBlockedCount: 0,
        rescuedCount: 0,
        unrescuableCount: 1,
        displacedReservationIds: [],
        rescuedReservationIds: [],
        unrescuableTaskIds: [highPriTask.id],
        frozenBlockedReservationIds: [],
        details: [{ action: "NO_WINDOWS_AVAILABLE", entityId: highPriTask.id, reason: "NO_FEASIBLE_WINDOW" }],
      };
    }

    // Load ground stations to check RF constraints
    const allStations = await db.select().from(groundStations);
    const stationMap = new Map<string, any>(allStations.map((gs) => [gs.id, gs]));

    // Query all active reservations overlapping these candidate windows
    const activeResvs = await db
      .select({
        res: reservations,
        task: missionTasks,
      })
      .from(reservations)
      .innerJoin(missionTasks, eq(reservations.missionTaskId, missionTasks.id))
      .where(inArray(reservations.status, ["PENDING", "CONFIRMED"]));

    // Step C: Identify preemptible candidates strictly following the hierarchy:
    // 1. MANUAL + LOCKED -> IMMUNE
    // 2. EXECUTION_FROZEN -> IMMUNE
    // 3. taskPriority >= highPriTask.priority -> IMMUNE
    const preemptionCandidates: PreemptionCandidate[] = [];

    for (const win of candidateWindows) {
      const station = stationMap.get(win.groundStationId);
      const validation = constraintValidator.validateCandidateWindow(highPriTask, win, station);
      if (!validation.valid) continue; // Window cannot physically serve the high-priority task

      // Find overlapping reservations on this station or satellite during this window
      const overlapping = activeResvs.filter(
        (item) =>
          (item.res.groundStationId === win.groundStationId || item.res.satelliteId === highPriTask.satelliteId) &&
          new Date(item.res.allocatedStart).getTime() < new Date(win.los).getTime() &&
          new Date(item.res.allocatedEnd).getTime() > new Date(win.aos).getTime()
      );

      for (const item of overlapping) {
        // Hierarchy check 1: MANUAL + LOCKED
        if (item.res.locked) continue;
        if (item.res.source === "MANUAL") continue;

        // Hierarchy check 2: EXECUTION_FROZEN
        if (isExecutionFrozen(item.res, refTime, freezeHorizon)) continue;

        // Hierarchy check 3: Priority must be strictly lower
        if (item.task.priority >= highPriTask.priority) continue;

        const allocatedEndMs = new Date(item.res.allocatedEnd).getTime();
        const deadlineMs = new Date(item.task.deadline).getTime();
        const slackSeconds = Math.max(0, Math.floor((deadlineMs - allocatedEndMs) / 1000));

        preemptionCandidates.push({
          reservationId: item.res.id,
          taskId: item.task.id,
          taskPriority: item.task.priority,
          slackSeconds,
          durationSeconds: item.task.durationSeconds,
          allocatedStart: new Date(item.res.allocatedStart),
          allocatedEnd: new Date(item.res.allocatedEnd),
          groundStationId: item.res.groundStationId,
          satelliteId: item.res.satelliteId,
          contactWindowId: item.res.contactWindowId,
        });
      }
    }

    if (preemptionCandidates.length === 0) {
      // High-priority task cannot be scheduled because all conflicting slots are protected
      return {
        eventType: "TASK_PREEMPTION",
        scheduleVersionBefore: vBefore,
        scheduleVersionAfter: vBefore,
        isNoOp: true,
        displacedReservationsCount: 0,
        frozenBlockedCount: 0,
        rescuedCount: 0,
        unrescuableCount: 1,
        displacedReservationIds: [],
        rescuedReservationIds: [],
        unrescuableTaskIds: [highPriTask.id],
        frozenBlockedReservationIds: [],
        details: [
          {
            action: "PREEMPTION_BLOCKED",
            entityId: highPriTask.id,
            reason: "ALL_CONFLICTING_SLOTS_PROTECTED_OR_HIGHER_PRIORITY",
          },
        ],
      };
    }

    // Step D: Deterministic Minimal-Cost Selection
    preemptionCandidates.sort(comparePreemptionCandidates);
    const chosen = preemptionCandidates[0]!;

    let rescuedCount = 0;
    let unrescuableCount = 0;
    const rescuedReservationIds: string[] = [];
    const unrescuableTaskIds: string[] = [];
    const details: OperationalReplanningResult["details"] = [];

    await db.transaction(async (tx) => {
      await txContext.run(tx, async () => {
        // 1. Cancel chosen lower-priority reservation & reset task to PENDING
        await tx
          .update(reservations)
          .set({ status: "CANCELLED", updatedAt: new Date() })
          .where(eq(reservations.id, chosen.reservationId));

        await tx
          .update(missionTasks)
          .set({ status: "PENDING", updatedAt: new Date() })
          .where(eq(missionTasks.id, chosen.taskId));

        await tx.insert(scheduleAuditLog).values({
          userId,
          action: "CANCEL_RESERVATION",
          entityType: "RESERVATION",
          entityId: chosen.reservationId,
          reason: "PRIORITY_PREEMPTION_DISPLACEMENT",
        });

        details.push({
          action: "CANCEL_RESERVATION",
          entityId: chosen.reservationId,
          reason: "PRIORITY_PREEMPTION_DISPLACEMENT",
        });

        // 2. Schedule the high-priority task into the opened slot
        const highPriScheduler =
          policy === "URGENCY"
            ? new UrgencyScheduler(this.candidateService)
            : new HybridScoringScheduler(this.candidateService, refTime, DEFAULT_HYBRID_WEIGHTS, policy as any);

        const highPriResult = await highPriScheduler.schedulePendingTasks([highPriTask.id]);
        if (highPriResult.scheduled === 1 && highPriResult.results[0]?.reservationId) {
          const highPriResId = highPriResult.results[0].reservationId;
          await tx.insert(scheduleAuditLog).values({
            userId,
            action: "CREATE_RESERVATION",
            entityType: "RESERVATION",
            entityId: highPriResId,
            reason: "HIGH_PRIORITY_PREEMPTION_ALLOCATION",
          });
          details.push({
            action: "CREATE_RESERVATION",
            entityId: highPriResId,
            reason: "HIGH_PRIORITY_PREEMPTION_ALLOCATION",
          });
        }

        // 3. Attempt targeted rescue of the displaced task
        const rescueScheduler =
          policy === "URGENCY"
            ? new UrgencyScheduler(this.candidateService)
            : new HybridScoringScheduler(this.candidateService, refTime, DEFAULT_HYBRID_WEIGHTS, policy as any);

        const rescueResult = await rescueScheduler.schedulePendingTasks([chosen.taskId]);
        if (rescueResult.scheduled === 1 && rescueResult.results[0]?.reservationId) {
          rescuedCount = 1;
          const rescueResId = rescueResult.results[0].reservationId;
          rescuedReservationIds.push(rescueResId);
          await tx.insert(scheduleAuditLog).values({
            userId,
            action: "CREATE_RESERVATION",
            entityType: "RESERVATION",
            entityId: rescueResId,
            reason: "PREEMPTION_RESCUE_SCHEDULED",
          });
          details.push({
            action: "CREATE_RESERVATION",
            entityId: rescueResId,
            reason: "PREEMPTION_RESCUE_SCHEDULED",
          });
        } else {
          // Preemption rescue failure: task remains PENDING with explicit reason
          unrescuableCount = 1;
          unrescuableTaskIds.push(chosen.taskId);
          await tx.insert(scheduleAuditLog).values({
            userId,
            action: "UNSCHEDULE_TASK",
            entityType: "MISSION_TASK",
            entityId: chosen.taskId,
            reason: "PREEMPTION_RESCUE_FAILED",
          });
          details.push({
            action: "UNSCHEDULE_TASK",
            entityId: chosen.taskId,
            reason: "PREEMPTION_RESCUE_FAILED",
          });
        }

        // Atomic schedule version increment
        await tx
          .update(scheduleVersions)
          .set({ version: vBefore + 1, updatedAt: new Date() })
          .where(eq(scheduleVersions.version, vBefore));
      });
    });

    return {
      eventType: "TASK_PREEMPTION",
      scheduleVersionBefore: vBefore,
      scheduleVersionAfter: vBefore + 1,
      isNoOp: false,
      displacedReservationsCount: 1,
      frozenBlockedCount: 0,
      rescuedCount,
      unrescuableCount,
      displacedReservationIds: [chosen.reservationId],
      rescuedReservationIds,
      unrescuableTaskIds,
      frozenBlockedReservationIds: [],
      details,
    };
  }

  /**
   * 3. Ground Station Restored
   * Checks if any pending/unscheduled tasks can be placed on newly restored capacity
   * without displacing confirmed reservations.
   */
  private async processStationRestored(
    event: { groundStationId: string; restoredAt: Date },
    vBefore: number,
    refTime: Date,
    policy: string,
    userId: string
  ): Promise<OperationalReplanningResult> {
    const scheduler =
      policy === "URGENCY"
        ? new UrgencyScheduler(this.candidateService)
        : new HybridScoringScheduler(this.candidateService, refTime, DEFAULT_HYBRID_WEIGHTS, policy as any);

    const scheduleRes = await scheduler.schedulePendingTasks();
    if (scheduleRes.scheduled === 0) {
      return {
        eventType: "STATION_RESTORED",
        scheduleVersionBefore: vBefore,
        scheduleVersionAfter: vBefore,
        isNoOp: true,
        displacedReservationsCount: 0,
        frozenBlockedCount: 0,
        rescuedCount: 0,
        unrescuableCount: 0,
        displacedReservationIds: [],
        rescuedReservationIds: [],
        unrescuableTaskIds: [],
        frozenBlockedReservationIds: [],
        details: [],
      };
    }

    const rescuedReservationIds: string[] = [];
    for (const r of scheduleRes.results) {
      if (r.status === "SCHEDULED" && r.reservationId) {
        rescuedReservationIds.push(r.reservationId);
      }
    }

    await db
      .update(scheduleVersions)
      .set({ version: vBefore + 1, updatedAt: new Date() })
      .where(eq(scheduleVersions.version, vBefore));

    return {
      eventType: "STATION_RESTORED",
      scheduleVersionBefore: vBefore,
      scheduleVersionAfter: vBefore + 1,
      isNoOp: false,
      displacedReservationsCount: 0,
      frozenBlockedCount: 0,
      rescuedCount: scheduleRes.scheduled,
      unrescuableCount: 0,
      displacedReservationIds: [],
      rescuedReservationIds,
      unrescuableTaskIds: [],
      frozenBlockedReservationIds: [],
      details: [{ action: "CAPACITY_RESTORED_ALLOCATION", entityId: event.groundStationId, reason: "STATION_AVAILABLE" }],
    };
  }

  /**
   * 4. Capacity Release
   * Cancels a released reservation and opportunities pending tasks.
   */
  private async processCapacityRelease(
    event: { releasedReservationId: string; reason?: string | undefined },
    vBefore: number,
    refTime: Date,
    policy: string,
    userId: string
  ): Promise<OperationalReplanningResult> {
    const [res] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, event.releasedReservationId))
      .limit(1);

    if (!res) {
      return {
        eventType: "CAPACITY_RELEASE",
        scheduleVersionBefore: vBefore,
        scheduleVersionAfter: vBefore,
        isNoOp: true,
        displacedReservationsCount: 0,
        frozenBlockedCount: 0,
        rescuedCount: 0,
        unrescuableCount: 0,
        displacedReservationIds: [],
        rescuedReservationIds: [],
        unrescuableTaskIds: [],
        frozenBlockedReservationIds: [],
        details: [],
      };
    }

    await db
      .update(reservations)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(eq(reservations.id, res.id));

    await db
      .update(missionTasks)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(eq(missionTasks.id, res.missionTaskId));

    await db.insert(scheduleAuditLog).values({
      userId,
      action: "CANCEL_RESERVATION",
      entityType: "RESERVATION",
      entityId: res.id,
      reason: event.reason || "OPERATIONAL_CAPACITY_RELEASE",
    });

    // Opportunistically schedule any pending tasks
    const scheduler =
      policy === "URGENCY"
        ? new UrgencyScheduler(this.candidateService)
        : new HybridScoringScheduler(this.candidateService, refTime, DEFAULT_HYBRID_WEIGHTS, policy as any);

    const scheduleRes = await scheduler.schedulePendingTasks();

    await db
      .update(scheduleVersions)
      .set({ version: vBefore + 1, updatedAt: new Date() })
      .where(eq(scheduleVersions.version, vBefore));

    return {
      eventType: "CAPACITY_RELEASE",
      scheduleVersionBefore: vBefore,
      scheduleVersionAfter: vBefore + 1,
      isNoOp: false,
      displacedReservationsCount: 1,
      frozenBlockedCount: 0,
      rescuedCount: scheduleRes.scheduled,
      unrescuableCount: 0,
      displacedReservationIds: [res.id],
      rescuedReservationIds: scheduleRes.results.filter((r) => r.reservationId).map((r) => r.reservationId!),
      unrescuableTaskIds: [],
      frozenBlockedReservationIds: [],
      details: [{ action: "CAPACITY_RELEASED", entityId: res.id, reason: event.reason || "OPERATIONAL_CAPACITY_RELEASE" }],
    };
  }
}
