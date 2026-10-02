import { Router } from "express";
import { authorize } from "../../../middlewares/auth";
import { ScheduleInvalidationService } from "./schedule-invalidation.service";
import { DynamicReplanningService } from "./dynamic-replanning.service";

export const replanningRouter = Router();

const invalidationService = new ScheduleInvalidationService();
const replanningService = new DynamicReplanningService();

// 1. Dry-run impact analysis
replanningRouter.post(
  "/analyze-impact",
  authorize(["OPERATOR", "ADMIN"]),
  async (req, res, next) => {
    try {
      const { satelliteIds, referenceTime } = req.body;
      if (!Array.isArray(satelliteIds)) {
        res.status(400).json({ error: "satelliteIds must be an array of UUIDs" });
        return;
      }
      const refTime = referenceTime ? new Date(referenceTime) : new Date();
      const impact = await invalidationService.analyzeImpact(satelliteIds, refTime);
      res.json(impact);
    } catch (err) {
      next(err);
    }
  }
);

// 2. Execute replanning
replanningRouter.post(
  "/replan",
  authorize(["OPERATOR", "ADMIN"]),
  async (req, res, next) => {
    try {
      const { scheduleVersion, satelliteIds, strategy, policy, referenceTime } = req.body;
      if (typeof scheduleVersion !== "number" || !Array.isArray(satelliteIds)) {
        res.status(400).json({ error: "Invalid scheduleVersion or satelliteIds" });
        return;
      }

      const userId = (req.user as any)?.sub as string;
      const result = await replanningService.replan({
        scheduleVersion,
        satelliteIds,
        strategy: strategy === "FULL" ? "FULL" : "TARGETED",
        policy: policy || "HYBRID",
        userId,
        referenceTime: referenceTime ? new Date(referenceTime) : undefined,
      });

      res.json(result);
    } catch (err: any) {
      if (err.code === "SCHEDULE_VERSION_CONFLICT") {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);
