import { Router, Request, Response } from "express";
import { executionService } from "./execution.service";
import { EventControlPlaneService } from "../scheduler/event-control-plane/event-control-plane.service";
import { db } from "../../db/client";
import { reservations, executionTelemetryEvents } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import { authenticate, authorize } from "../../middlewares/auth";
import { logger } from "../../config/logger";

const router = Router();
const eventControlPlaneService = new EventControlPlaneService();

/**
 * 1. POST /api/execution/dispatch
 * Generates an outbound execution manifest for ground station schedulers
 */
router.post(
  "/dispatch",
  authenticate,
  authorize(["OPERATOR", "ADMIN"]),
  async (req: Request, res: Response) => {
    try {
      const { reservationId, referenceTime } = req.body;
      if (!reservationId) {
        return res.status(400).json({ error: "Missing required reservationId" });
      }

      const refDate = referenceTime ? new Date(referenceTime) : new Date();
      const manifest = await executionService.generateDispatchManifest(reservationId, refDate);

      return res.status(200).json(manifest);
    } catch (err: any) {
      logger.error({ err, msg: "Failed to generate execution dispatch manifest" });
      return res.status(400).json({ error: err.message });
    }
  }
);

/**
 * 2. POST /api/execution/telemetry
 * Ingests physical ground station telemetry events into the execution contract
 */
router.post("/telemetry", async (req: Request, res: Response) => {
  try {
    const event = req.body;
    if (!event.reservationId || !event.dispatchId || !event.eventType || !event.idempotencyKey) {
      return res.status(400).json({
        error: "Missing required fields: reservationId, dispatchId, eventType, idempotencyKey",
      });
    }

    const result = await executionService.ingestExecutionTelemetry(event);

    // If execution has a scheduling consequence, route through the Phase 5.3/5.4 Control Plane
    // to advance the schedule version atomically and trigger dynamic replanning
    if (result.hasSchedulingConsequence) {
      const [resRow] = await db
        .select()
        .from(reservations)
        .where(eq(reservations.id, result.reservationId));

      if (resRow) {
        if (result.newState === "PARTIAL" || result.newState === "FAILED") {
          // Re-queue and rescue unfulfilled task demand via Control Plane
          await eventControlPlaneService.ingestEvents(
            [
              {
                idempotencyKey: `exec-reconcile-${result.reservationId}-${result.dispatchId}-${result.newState}`,
                eventType: "TASK_PREEMPTION",
                payload: { taskId: resRow.missionTaskId },
              },
            ],
            {
              userId: "system-execution-reconciler",
              referenceTime: event.sourceTimestamp ? new Date(event.sourceTimestamp) : new Date(),
            }
          );
        } else if (result.newState === "COMPLETED") {
          // Clean completion: release capacity in Control Plane
          await eventControlPlaneService.ingestEvents(
            [
              {
                idempotencyKey: `exec-complete-${result.reservationId}-${result.dispatchId}`,
                eventType: "CAPACITY_RELEASE",
                payload: { groundStationId: resRow.groundStationId },
              },
            ],
            {
              userId: "system-execution-reconciler",
              referenceTime: event.sourceTimestamp ? new Date(event.sourceTimestamp) : new Date(),
            }
          );
        }
      }
    }

    return res.status(200).json(result);
  } catch (err: any) {
    logger.error({ err, msg: "Failed to process execution telemetry" });
    if (err.message.includes("not found")) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.includes("Stale dispatch")) {
      return res.status(409).json({ error: err.message });
    }
    return res.status(422).json({ error: err.message });
  }
});

/**
 * 3. POST /api/execution/watchdog
 * Evaluates watchdogs against the authoritative UTC server time
 */
router.post(
  "/watchdog",
  authenticate,
  authorize(["OPERATOR", "ADMIN"]),
  async (req: Request, res: Response) => {
    try {
      const { referenceTime, dispatchTimeoutSeconds, aosToleranceSeconds } = req.body;
      const refDate = referenceTime ? new Date(referenceTime) : new Date();

      const results = await executionService.evaluateWatchdogs(refDate, {
        dispatchTimeoutSeconds,
        aosToleranceSeconds,
      });

      // Route any failures through control-plane replanning
      for (const r of results) {
        if (r.hasSchedulingConsequence && r.newState === "FAILED") {
          const [resRow] = await db
            .select()
            .from(reservations)
            .where(eq(reservations.id, r.reservationId));

          if (resRow) {
            await eventControlPlaneService.ingestEvents(
              [
                {
                  idempotencyKey: `watchdog-rescue-${r.reservationId}-${r.dispatchId}`,
                  eventType: "TASK_PREEMPTION",
                  payload: { taskId: resRow.missionTaskId },
                },
              ],
              {
                userId: "system-watchdog-reconciler",
                referenceTime: refDate,
              }
            );
          }
        }
      }

      return res.status(200).json({
        evaluatedAt: refDate.toISOString(),
        actionCount: results.length,
        actions: results,
      });
    } catch (err: any) {
      logger.error({ err, msg: "Failed to evaluate execution watchdogs" });
      return res.status(500).json({ error: err.message });
    }
  }
);

/**
 * 4. GET /api/execution/reservations/:id
 * Returns current execution contract and recent telemetry event log for a reservation
 */
router.get("/reservations/:id", authenticate, async (req: Request, res: Response) => {
  try {
    const reservationId = req.params.id as string;
    const [resRow] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservationId));

    if (!resRow) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    const events = await db
      .select()
      .from(executionTelemetryEvents)
      .where(eq(executionTelemetryEvents.reservationId, reservationId))
      .orderBy(desc(executionTelemetryEvents.sourceTimestamp))
      .limit(50);

    return res.status(200).json({
      reservation: resRow,
      telemetryHistory: events,
    });
  } catch (err: any) {
    logger.error({ err, msg: "Failed to query reservation execution state" });
    return res.status(500).json({ error: err.message });
  }
});

export const executionRouter = router;
