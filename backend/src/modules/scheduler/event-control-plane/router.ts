import { Router } from "express";
import { authorize } from "../../../middlewares/auth";
import { EventControlPlaneService } from "./event-control-plane.service";
import { db } from "../../../db/client";
import { operationalEventLedger, operationalBatches } from "../../../db/schema";
import { desc } from "drizzle-orm";

export const controlPlaneRouter = Router();
const controlPlaneService = new EventControlPlaneService();

// 1. Ingest single event
controlPlaneRouter.post(
  "/ingest",
  authorize(["OPERATOR", "ADMIN"]),
  async (req, res, next) => {
    try {
      const { event, options } = req.body;
      if (!event || !event.idempotencyKey || !event.eventType) {
        res.status(400).json({ error: "Missing required event, idempotencyKey, or eventType" });
        return;
      }

      const userId = (req.user as any)?.sub as string || "system";
      const receipt = await controlPlaneService.ingestEvents([event], {
        ...options,
        userId,
        referenceTime: options?.referenceTime ? new Date(options.referenceTime) : undefined,
      });

      res.json(receipt);
    } catch (err: any) {
      next(err);
    }
  }
);

// 2. Ingest batch of events (simultaneous / burst)
controlPlaneRouter.post(
  "/batch",
  authorize(["OPERATOR", "ADMIN"]),
  async (req, res, next) => {
    try {
      const { events, options } = req.body;
      if (!Array.isArray(events) || events.length === 0) {
        res.status(400).json({ error: "events must be a non-empty array" });
        return;
      }

      const userId = (req.user as any)?.sub as string || "system";
      const receipt = await controlPlaneService.ingestEvents(events, {
        ...options,
        userId,
        referenceTime: options?.referenceTime ? new Date(options.referenceTime) : undefined,
      });

      res.json(receipt);
    } catch (err: any) {
      next(err);
    }
  }
);

// 3. Retry an interrupted or failed batch
controlPlaneRouter.post(
  "/retry",
  authorize(["OPERATOR", "ADMIN"]),
  async (req, res, next) => {
    try {
      const { batchId, options } = req.body;
      if (!batchId) {
        res.status(400).json({ error: "Missing required batchId" });
        return;
      }

      const userId = (req.user as any)?.sub as string || "system";
      const receipt = await controlPlaneService.retryBatch(batchId, {
        ...options,
        userId,
        referenceTime: options?.referenceTime ? new Date(options.referenceTime) : undefined,
      });

      res.json(receipt);
    } catch (err: any) {
      next(err);
    }
  }
);

// 4. Query ledger audit items
controlPlaneRouter.get(
  "/ledger",
  authorize(["OPERATOR", "ADMIN", "VIEWER"]),
  async (req, res, next) => {
    try {
      const items = await db
        .select()
        .from(operationalEventLedger)
        .orderBy(desc(operationalEventLedger.createdAt))
        .limit(50);

      res.json({ ledger: items });
    } catch (err: any) {
      next(err);
    }
  }
);
