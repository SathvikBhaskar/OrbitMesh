import { Router, Request, Response, NextFunction } from "express";
import { groundAdapterService } from "./adapter.service";
import { executionService } from "../execution/execution.service";
import { db } from "../../db/client";
import { dispatchAttempts, reservations } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import { authenticate } from "../../middlewares/auth";

export const groundAdapterRouter = Router();

// 1. POST /api/adapter/dispatch/prepare
groundAdapterRouter.post("/dispatch/prepare", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reservationId, metadata } = req.body;
    if (!reservationId) {
      res.status(400).json({ error: "reservationId is required" });
      return;
    }

    const attempt = await groundAdapterService.prepareDispatchAttempt(reservationId, metadata);
    res.status(201).json(attempt);
  } catch (err: any) {
    next(err);
  }
});

// 2. POST /api/adapter/dispatch/stage
groundAdapterRouter.post("/dispatch/stage", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dispatchId, simulateNetworkTimeout, simulatePhysicalRejection, rejectionReason } = req.body;
    if (!dispatchId) {
      res.status(400).json({ error: "dispatchId is required" });
      return;
    }

    const attempt = await groundAdapterService.stageDispatchAttempt(dispatchId, {
      simulateNetworkTimeout,
      simulatePhysicalRejection,
      rejectionReason,
    });

    res.json(attempt);
  } catch (err: any) {
    next(err);
  }
});

// 3. POST /api/adapter/dispatch/arm
groundAdapterRouter.post("/dispatch/arm", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dispatchId, simulateArmRejection, rejectionReason } = req.body;
    if (!dispatchId) {
      res.status(400).json({ error: "dispatchId is required" });
      return;
    }

    const attempt = await groundAdapterService.armDispatchAttempt(dispatchId, {
      simulateArmRejection,
      rejectionReason,
    });

    res.json(attempt);
  } catch (err: any) {
    next(err);
  }
});

// 4. POST /api/adapter/telemetry
groundAdapterRouter.post("/telemetry", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      dispatchId,
      reservationId,
      sequenceNumber,
      sourceTimestamp,
      idempotencyKey,
      bytesTransferred,
      isSnapshot,
      eventType,
      metrics,
    } = req.body;

    if (!dispatchId || !reservationId || sequenceNumber === undefined || !sourceTimestamp || !idempotencyKey) {
      res.status(400).json({ error: "dispatchId, reservationId, sequenceNumber, sourceTimestamp, and idempotencyKey are required" });
      return;
    }

    const parsedSourceTime = new Date(sourceTimestamp);

    // 1. Clock Discipline: evaluate skew bounds
    const clockResult = groundAdapterService.evaluateClockSkew(parsedSourceTime);
    if (!clockResult.isAcceptable) {
      res.status(422).json({
        error: `CLOCK_SKEW_REJECTED: ${clockResult.rejectionReason}`,
        clockOffsetMs: clockResult.clockOffsetMs,
      });
      return;
    }

    // Lookup reservation to obtain physical satelliteId and groundStationId
    const resRows = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservationId));

    if (resRows.length === 0) {
      res.status(404).json({ error: `Reservation ${reservationId} not found` });
      return;
    }
    const resRow = resRows[0]!;
    const physicalGroundStationId = req.body.groundStationId || resRow.groundStationId;
    const physicalSatelliteId = req.body.satelliteId || resRow.satelliteId;

    // 2. Sequence Gap Evaluation: update transportHealth to COMMUNICATION_GAP if sequence gap detected
    const gapResult = await groundAdapterService.evaluateSequenceAndGap(dispatchId, sequenceNumber, { isSnapshot });

    // 3. Monotonic Actuals Reconciliation: snapshot vs replay protection
    if (bytesTransferred !== undefined) {
      try {
        await groundAdapterService.reconcileTelemetryActuals(reservationId, dispatchId, bytesTransferred);
      } catch (err: any) {
        if (err.message.includes("STALE_DISPATCH_REJECTED") || err.message.includes("Stale dispatch rejected")) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }
    }

    // 4. Forward to Execution Ingestion Engine
    const receipt = await executionService.ingestExecutionTelemetry({
      eventId: `evt-${idempotencyKey.slice(0, 8)}`,
      reservationId,
      dispatchId,
      sequenceNumber,
      sourceTimestamp: parsedSourceTime.toISOString(),
      idempotencyKey,
      eventType: (eventType as any) || "TELEMETRY_STATS",
      payload: {
        groundStationId: physicalGroundStationId,
        satelliteId: physicalSatelliteId,
        bytesTransferred: bytesTransferred || 0,
        details: {
          clockOffsetMs: clockResult.clockOffsetMs,
          isSnapshot: !!isSnapshot,
          hasGap: gapResult.hasGap,
          ...(metrics || {}),
        },
      },
    });

    res.json({
      ...receipt,
      clockOffsetMs: clockResult.clockOffsetMs,
      transportGap: gapResult,
    });
  } catch (err: any) {
    if (
      err.message &&
      (err.message.includes("STALE_DISPATCH_REJECTED") || err.message.includes("Stale dispatch rejected"))
    ) {
      res.status(409).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// 5. GET /api/adapter/attempts/:dispatchId
groundAdapterRouter.get("/attempts/:dispatchId", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await db
      .select()
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.dispatchId, req.params.dispatchId as string));

    if (rows.length === 0) {
      res.status(404).json({ error: "Dispatch attempt not found" });
      return;
    }

    res.json(rows[0]);
  } catch (err: any) {
    next(err);
  }
});

// 6. GET /api/adapter/reservations/:reservationId/attempts
groundAdapterRouter.get("/reservations/:reservationId/attempts", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await db
      .select()
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.reservationId, req.params.reservationId as string))
      .orderBy(desc(dispatchAttempts.attemptNumber));

    res.json(rows);
  } catch (err: any) {
    next(err);
  }
});
