import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  reservations,
  missionTasks,
  contactWindows,
  executionTelemetryEvents,
} from "../../db/schema";
import {
  ExecutionState,
  FailureReason,
  InboundExecutionEvent,
  DispatchManifest,
  ExecutionTransitionResult,
  isValidExecutionTransition,
  isTerminalExecutionState,
} from "./execution.types";
import { logger } from "../../config/logger";

export class ExecutionService {
  /**
   * 1. Outbound Execution Dispatch Manifest Generator
   * Generates a unique execution attempt (dispatchId) and locks the reservation in EXECUTION_READY.
   */
  async generateDispatchManifest(reservationId: string, referenceTime: Date = new Date()): Promise<DispatchManifest> {
    const rows = await db
      .select({
        res: reservations,
        task: missionTasks,
        win: contactWindows,
      })
      .from(reservations)
      .innerJoin(missionTasks, eq(reservations.missionTaskId, missionTasks.id))
      .innerJoin(contactWindows, eq(reservations.contactWindowId, contactWindows.id))
      .where(eq(reservations.id, reservationId));

    if (rows.length === 0) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    const { res, task, win } = rows[0]!;
    if (isTerminalExecutionState(res.executionState as ExecutionState)) {
      throw new Error(`Cannot dispatch terminal reservation in state ${res.executionState}`);
    }

    const dispatchId = `disp-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date(referenceTime);

    await db
      .update(reservations)
      .set({
        executionState: "EXECUTION_READY",
        activeDispatchId: dispatchId,
        dispatchedAt: now,
        updatedAt: now,
      })
      .where(eq(reservations.id, reservationId));

    logger.info({
      reservationId,
      dispatchId,
      satelliteId: res.satelliteId,
      groundStationId: res.groundStationId,
      lifecycleStatus: "EXECUTION_READY",
      msg: "Generated outbound dispatch manifest",
    });

    return {
      dispatchId,
      reservationId: res.id,
      satelliteId: res.satelliteId,
      groundStationId: res.groundStationId,
      window: {
        aos: win.aos.toISOString(),
        los: win.los.toISOString(),
      },
      allocatedTime: {
        start: res.allocatedStart.toISOString(),
        end: res.allocatedEnd.toISOString(),
      },
      rfConfiguration: {
        frequencyBand: task.requiredFrequencyBand,
        minDataRateMbps: task.minDataRateMbps,
      },
      taskManifest: {
        taskId: task.id,
        priority: task.priority,
        targetBytes: task.targetBytes,
        remainingBytes: task.remainingBytes,
      },
      dispatchedAt: now.toISOString(),
    };
  }

  /**
   * 2. Inbound Execution Telemetry Ingestion & Contract Reconciliation
   * Enforces:
   * - Idempotency
   * - Station/Satellite verification
   * - Active dispatchId matching (rejection of stale dispatches)
   * - Monotonic bytesTransferred max tracking (rejection of out-of-order byte regressions)
   * - Deterministic transition matrix & terminal state immutability
   * - Multi-pass task quota updates (targetBytes preserved, remaining = target - fulfilled)
   */
  async ingestExecutionTelemetry(event: InboundExecutionEvent): Promise<ExecutionTransitionResult> {
    // 1. Idempotency Check
    const [existingEvent] = await db
      .select()
      .from(executionTelemetryEvents)
      .where(eq(executionTelemetryEvents.idempotencyKey, event.idempotencyKey));

    if (existingEvent) {
      logger.info({
        idempotencyKey: event.idempotencyKey,
        reservationId: event.reservationId,
        msg: "Execution telemetry idempotency hit: returning existing record",
      });

      const [res] = await db
        .select()
        .from(reservations)
        .where(eq(reservations.id, event.reservationId));

      return {
        reservationId: event.reservationId,
        dispatchId: event.dispatchId,
        previousState: (res?.executionState as ExecutionState) ?? "SCHEDULED",
        newState: (res?.executionState as ExecutionState) ?? "SCHEDULED",
        bytesTransferred: res?.bytesTransferred ?? 0,
        failureReason: (res?.failureReason as FailureReason) ?? undefined,
        hasSchedulingConsequence: false,
        schedulingConsequenceType: "NONE",
      };
    }

    // 2. Fetch Reservation and Mission Task
    const rows = await db
      .select({
        res: reservations,
        task: missionTasks,
      })
      .from(reservations)
      .innerJoin(missionTasks, eq(reservations.missionTaskId, missionTasks.id))
      .where(eq(reservations.id, event.reservationId));

    if (rows.length === 0) {
      throw new Error(`Reservation ${event.reservationId} not found`);
    }

    const { res, task } = rows[0]!;
    const currentState = res.executionState as ExecutionState;

    // 3. Station / Satellite Validation
    if (
      event.payload.groundStationId !== res.groundStationId ||
      event.payload.satelliteId !== res.satelliteId
    ) {
      throw new Error(
        `Physical station or satellite mismatch for reservation ${res.id}. Expected [${res.groundStationId}, ${res.satelliteId}], got [${event.payload.groundStationId}, ${event.payload.satelliteId}]`
      );
    }

    // 4. Stale Dispatch Check
    if (res.activeDispatchId && event.dispatchId !== res.activeDispatchId) {
      throw new Error(
        `Stale dispatch rejected: event dispatchId [${event.dispatchId}] does not match active dispatch [${res.activeDispatchId}]`
      );
    }

    // 5. Terminal State Check
    if (isTerminalExecutionState(currentState)) {
      logger.warn({
        reservationId: res.id,
        currentState,
        eventType: event.eventType,
        msg: "Ignored telemetry event for already-terminal reservation",
      });
      return {
        reservationId: res.id,
        dispatchId: event.dispatchId,
        previousState: currentState,
        newState: currentState,
        bytesTransferred: res.bytesTransferred,
        failureReason: (res.failureReason as FailureReason) ?? undefined,
        hasSchedulingConsequence: false,
        schedulingConsequenceType: "NONE",
      };
    }

    // 6. Monotonic Byte Calculation
    const incomingBytes = event.payload.bytesTransferred ?? 0;
    const resolvedBytes = Math.max(res.bytesTransferred, incomingBytes);

    // 7. Transition Determination
    let targetState: ExecutionState = currentState;
    let failureReason: FailureReason | undefined = undefined;
    let hasSchedulingConsequence = false;
    let consequenceType: "NONE" | "REPLAN_REMAINDER" | "RESCUE_TASK" | "RELEASE_SLOT" = "NONE";

    switch (event.eventType) {
      case "DISPATCH_ACK":
        targetState = "DISPATCHED";
        break;

      case "AOS_ACQUIRED":
        targetState = "IN_PROGRESS";
        break;

      case "TELEMETRY_STATS":
        targetState = "IN_PROGRESS";
        break;

      case "LOS_TERMINATED":
        // Evaluate target completion against task demand
        const remainingToFulfill = task.remainingBytes;
        if (resolvedBytes >= remainingToFulfill) {
          targetState = "COMPLETED";
          hasSchedulingConsequence = true;
          consequenceType = "RELEASE_SLOT";
        } else {
          targetState = "PARTIAL";
          hasSchedulingConsequence = true;
          consequenceType = "REPLAN_REMAINDER";
        }
        break;

      case "GROUND_HARDWARE_FAULT":
        targetState = "FAILED";
        failureReason = "GROUND_HARDWARE_FAULT";
        hasSchedulingConsequence = true;
        consequenceType = "RESCUE_TASK";
        break;

      case "WATCHDOG_TIMEOUT":
        if (event.payload.failureReason === "NO_AOS" && (currentState === "IN_PROGRESS" || res.aosActual)) {
          // Physical carrier lock was already established: NO_AOS timeout is superseded
          targetState = currentState;
          logger.info({
            reservationId: res.id,
            msg: "Watchdog NO_AOS superseded by physical AOS_ACQUIRED",
          });
        } else if (
          event.payload.failureReason === "DISPATCH_REJECTED" &&
          (currentState === "DISPATCHED" || res.dispatchAckAt)
        ) {
          // Ground dispatch was already accepted: dispatch timeout is superseded
          targetState = currentState;
        } else {
          targetState = "FAILED";
          failureReason = event.payload.failureReason ?? "TIMEOUT";
          hasSchedulingConsequence = true;
          consequenceType = "RESCUE_TASK";
        }
        break;
    }

    // 8. Transition Validity Check
    if (!isValidExecutionTransition(currentState, targetState)) {
      // Deterministic race handling: If physical telemetry (e.g. AOS_ACQUIRED) already moved pass to IN_PROGRESS,
      // a delayed or concurrent WATCHDOG_NO_AOS is superseded and safely no-ops.
      logger.warn({
        reservationId: res.id,
        currentState,
        attemptedState: targetState,
        eventType: event.eventType,
        msg: "Superseded or invalid execution state transition rejected safely",
      });

      return {
        reservationId: res.id,
        dispatchId: event.dispatchId,
        previousState: currentState,
        newState: currentState,
        bytesTransferred: res.bytesTransferred,
        failureReason: (res.failureReason as FailureReason) ?? undefined,
        hasSchedulingConsequence: false,
        schedulingConsequenceType: "NONE",
      };
    }

    // 9. Atomic Persistence
    const sourceTime = new Date(event.sourceTimestamp);

    await db.transaction(async (tx) => {
      // Record audit ledger entry
      await tx.insert(executionTelemetryEvents).values({
        reservationId: res.id,
        dispatchId: event.dispatchId,
        eventType: event.eventType,
        sequenceNumber: event.sequenceNumber,
        sourceTimestamp: sourceTime,
        idempotencyKey: event.idempotencyKey,
        payload: event.payload as any,
      });

      // Update reservation execution contract
      const updateData: Partial<typeof reservations.$inferInsert> = {
        executionState: targetState,
        bytesTransferred: resolvedBytes,
        updatedAt: new Date(),
      };

      if (event.eventType === "DISPATCH_ACK") {
        updateData.dispatchAckAt = sourceTime;
      } else if (event.eventType === "AOS_ACQUIRED") {
        updateData.aosActual = sourceTime;
      } else if (event.eventType === "LOS_TERMINATED") {
        updateData.losActual = sourceTime;
      }

      if (targetState === "FAILED" && failureReason) {
        updateData.failureReason = failureReason;
      }

      // If pass completed or partial, update reservation status to COMPLETED
      if (targetState === "COMPLETED" || targetState === "PARTIAL") {
        updateData.status = "COMPLETED";
      }

      await tx.update(reservations).set(updateData).where(eq(reservations.id, res.id));

      // Multi-pass Task Quota Reconciliation
      if (targetState === "COMPLETED" || targetState === "PARTIAL") {
        const deltaBytes = Math.min(resolvedBytes, task.remainingBytes);
        const newFulfilled = Math.min(task.targetBytes, task.fulfilledBytes + deltaBytes);
        const newRemaining = Math.max(0, task.targetBytes - newFulfilled);
        const taskStatus = newRemaining === 0 ? "COMPLETED" : "PENDING";

        await tx
          .update(missionTasks)
          .set({
            fulfilledBytes: newFulfilled,
            remainingBytes: newRemaining,
            status: taskStatus,
            updatedAt: new Date(),
          })
          .where(eq(missionTasks.id, task.id));
      } else if (targetState === "FAILED") {
        // Reset task to PENDING so control-plane replanning can rescue it
        await tx
          .update(missionTasks)
          .set({
            status: "PENDING",
            updatedAt: new Date(),
          })
          .where(eq(missionTasks.id, task.id));
      }
    });

    logger.info({
      reservationId: res.id,
      dispatchId: event.dispatchId,
      previousState: currentState,
      newState: targetState,
      bytesTransferred: resolvedBytes,
      hasSchedulingConsequence,
      consequenceType,
      msg: "Execution telemetry reconciled successfully",
    });

    return {
      reservationId: res.id,
      dispatchId: event.dispatchId,
      previousState: currentState,
      newState: targetState,
      bytesTransferred: resolvedBytes,
      failureReason,
      hasSchedulingConsequence,
      schedulingConsequenceType: consequenceType,
    };
  }

  /**
   * 3. Execution Watchdog Scanner
   * Evaluates timing deadlines against authoritative UTC reference time and routes all actions
   * through ingestExecutionTelemetry to preserve the single-writer invariant.
   */
  async evaluateWatchdogs(
    referenceTime: Date = new Date(),
    tolerances: {
      dispatchTimeoutSeconds?: number;
      aosToleranceSeconds?: number;
      heartbeatTimeoutSeconds?: number;
    } = {}
  ): Promise<ExecutionTransitionResult[]> {
    const dispatchTimeoutSec = tolerances.dispatchTimeoutSeconds ?? 300;
    const aosToleranceSec = tolerances.aosToleranceSeconds ?? 60;
    const refMs = referenceTime.getTime();

    // Fetch all non-terminal reservations
    const active = await db
      .select({
        res: reservations,
        task: missionTasks,
      })
      .from(reservations)
      .innerJoin(missionTasks, eq(reservations.missionTaskId, missionTasks.id))
      .where(
        and(
          sql`${reservations.executionState} NOT IN ('COMPLETED', 'PARTIAL', 'FAILED')`,
          eq(reservations.status, "CONFIRMED")
        )
      );

    const results: ExecutionTransitionResult[] = [];

    for (const item of active) {
      const startMs = new Date(item.res.allocatedStart).getTime();
      const state = item.res.executionState as ExecutionState;
      const dispatchId = item.res.activeDispatchId ?? `watchdog-${item.res.id.slice(0, 8)}`;

      // 1. Dispatch Timeout Watchdog
      // If EXECUTION_READY and pass start is within dispatchTimeoutSec with no DISPATCH_ACK
      if (state === "EXECUTION_READY" && refMs > startMs - dispatchTimeoutSec * 1000) {
        if (!item.res.dispatchAckAt) {
          const res = await this.ingestExecutionTelemetry({
            eventId: crypto.randomUUID(),
            reservationId: item.res.id,
            dispatchId,
            eventType: "WATCHDOG_TIMEOUT",
            sourceTimestamp: referenceTime.toISOString(),
            sequenceNumber: 999999,
            idempotencyKey: `watchdog-dispatch-timeout-${item.res.id}-${dispatchId}`,
            payload: {
              groundStationId: item.res.groundStationId,
              satelliteId: item.res.satelliteId,
              failureReason: "DISPATCH_REJECTED",
              details: { reason: "Ground station did not acknowledge dispatch before deadline" },
            },
          });
          results.push(res);
          continue;
        }
      }

      // 2. Missed AOS Watchdog
      // If DISPATCHED and pass has commenced past aosToleranceSec without AOS_ACQUIRED
      if (state === "DISPATCHED" && refMs > startMs + aosToleranceSec * 1000) {
        if (!item.res.aosActual) {
          const res = await this.ingestExecutionTelemetry({
            eventId: crypto.randomUUID(),
            reservationId: item.res.id,
            dispatchId,
            eventType: "WATCHDOG_TIMEOUT",
            sourceTimestamp: referenceTime.toISOString(),
            sequenceNumber: 999999,
            idempotencyKey: `watchdog-no-aos-${item.res.id}-${dispatchId}`,
            payload: {
              groundStationId: item.res.groundStationId,
              satelliteId: item.res.satelliteId,
              failureReason: "NO_AOS",
              details: { reason: "No carrier lock acquired within tolerance after allocated start" },
            },
          });
          results.push(res);
          continue;
        }
      }
    }

    return results;
  }
}

export const executionService = new ExecutionService();
