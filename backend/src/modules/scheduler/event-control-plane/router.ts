import { Router } from "express";
import { authorize } from "../../../middlewares/auth";
import { EventControlPlaneService } from "./event-control-plane.service";
import { db } from "../../../db/client";
import { operationalEventLedger, operationalBatches } from "../../../db/schema";
import { desc, eq, and } from "drizzle-orm";

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

// 4. Query ledger audit items (filtered by status or eventType)
controlPlaneRouter.get(
  "/ledger",
  authorize(["OPERATOR", "ADMIN", "VIEWER"]),
  async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
      const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
      const eventTypeFilter = typeof req.query.eventType === "string" ? req.query.eventType : undefined;

      const conditions = [];
      if (statusFilter) {
        conditions.push(eq(operationalEventLedger.status, statusFilter));
      }
      if (eventTypeFilter) {
        conditions.push(eq(operationalEventLedger.eventType, eventTypeFilter));
      }

      const baseQuery = db.select().from(operationalEventLedger);
      const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
      const items = await filtered.orderBy(desc(operationalEventLedger.createdAt)).limit(limit);

      res.json({ ledger: items, count: items.length });
    } catch (err: any) {
      next(err);
    }
  }
);

// 5. Query operational batches (list recent batches)
controlPlaneRouter.get(
  "/batches",
  authorize(["OPERATOR", "ADMIN", "VIEWER"]),
  async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 30, 1), 100);
      const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;

      const baseQuery = db.select().from(operationalBatches);
      const filtered = statusFilter ? baseQuery.where(eq(operationalBatches.status, statusFilter)) : baseQuery;
      const items = await filtered.orderBy(desc(operationalBatches.createdAt)).limit(limit);

      res.json({ batches: items, count: items.length });
    } catch (err: any) {
      next(err);
    }
  }
);

// 6. Inspect single operational batch with its constituent events
controlPlaneRouter.get(
  "/batches/:batchId",
  authorize(["OPERATOR", "ADMIN", "VIEWER"]),
  async (req, res, next) => {
    try {
      const batchId = String(req.params.batchId);
      if (!batchId) {
        res.status(400).json({ error: "Missing required batchId" });
        return;
      }

      const [batch] = await db
        .select()
        .from(operationalBatches)
        .where(eq(operationalBatches.id, batchId))
        .limit(1);

      if (!batch) {
        res.status(404).json({ error: `Batch ${batchId} not found` });
        return;
      }

      // Fetch constituent events from ledger
      const constituentEvents = await db
        .select()
        .from(operationalEventLedger)
        .where(eq(operationalEventLedger.batchId, batchId))
        .orderBy(desc(operationalEventLedger.createdAt));

      res.json({
        batch,
        events: constituentEvents,
      });
    } catch (err: any) {
      next(err);
    }
  }
);
