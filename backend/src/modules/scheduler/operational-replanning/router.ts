import { Router } from "express";
import { authorize } from "../../../middlewares/auth";
import { OperationalReplanningService } from "./operational-replanning.service";
import { db } from "../../../db/client";
import { scheduleVersions } from "../../../db/schema";

export const operationalRouter = Router();
const operationalService = new OperationalReplanningService();

// Execute operational event replanning
operationalRouter.post(
  "/event",
  authorize(["OPERATOR", "ADMIN"]),
  async (req, res, next) => {
    try {
      const { event, options, scheduleVersion } = req.body;
      if (!event || !event.type) {
        res.status(400).json({ error: "Missing required event or event.type" });
        return;
      }

      // Concurrency check if scheduleVersion was provided
      if (typeof scheduleVersion === "number") {
        const verRes = await db.select().from(scheduleVersions).limit(1);
        const currentVersion = verRes[0]?.version || 0;
        if (currentVersion !== scheduleVersion) {
          res.status(409).json({ error: "Schedule version conflict during operational replanning" });
          return;
        }
      }

      const userId = (req.user as any)?.sub as string || "system";
      const result = await operationalService.handleOperationalEvent(event, {
        ...options,
        userId,
        referenceTime: options?.referenceTime ? new Date(options.referenceTime) : undefined,
      });

      res.json(result);
    } catch (err: any) {
      next(err);
    }
  }
);
