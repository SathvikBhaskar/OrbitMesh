import { Router } from "express";
import { authorize } from "../../middlewares/auth";
import { CandidateService } from "./candidate-service";
import { FcfsScheduler } from "./fcfs-scheduler";
import { PriorityScheduler } from "./priority-scheduler";
import { UrgencyScheduler } from "./urgency-scheduler";
import { HybridScoringScheduler } from "./hybrid-scoring-scheduler";
import { MetaScheduler } from "../meta-scheduler/meta-scheduler";

import { db } from "../../db/client";
import { missionTasks, scheduleVersions } from "../../db/schema";
import { eq } from "drizzle-orm";
import { runSeed } from "../../db/seed";
import { replanningRouter } from "./dynamic-replanning/router";

export const schedulerRouter = Router();

schedulerRouter.use("/replanning", replanningRouter);

const candidateService = new CandidateService();
const fcfsScheduler = new FcfsScheduler(candidateService);
const priorityScheduler = new PriorityScheduler(candidateService);
const urgencyScheduler = new UrgencyScheduler(candidateService);
const hybridScheduler = new HybridScoringScheduler(candidateService);

// We instantiate MetaScheduler with the PRODUCTION runType
const metaScheduler = new MetaScheduler(candidateService, "PRODUCTION");

schedulerRouter.post("/fcfs/run", async (req, res, next) => {
  try {
    const result = await fcfsScheduler.schedulePendingTasks();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

schedulerRouter.post("/priority/run", async (req, res, next) => {
  try {
    const result = await priorityScheduler.schedulePendingTasks();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

schedulerRouter.post("/urgency/run", authorize(["OPERATOR", "ADMIN"]), async (req, res, next) => {
  try {
    const result = await urgencyScheduler.schedulePendingTasks();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

schedulerRouter.post("/hybrid/run", authorize(["OPERATOR", "ADMIN"]), async (req, res, next) => {
  try {
    const result = await hybridScheduler.schedulePendingTasks();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

schedulerRouter.post("/meta/run", authorize(["OPERATOR", "ADMIN"]), async (req, res, next) => {
  try {
    const result = await metaScheduler.schedulePendingTasks();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

import { SchedulerWrapperService } from "./scheduler-wrapper.service";

const wrapperService = new SchedulerWrapperService();

schedulerRouter.post("/preview", authorize(["OPERATOR", "ADMIN"]), async (req, res, next) => {
  try {
    const { scheduleVersion, policy } = req.body;
    if (typeof scheduleVersion !== "number") {
      res.status(400).json({ error: "Invalid scheduleVersion" });
      return;
    }
    const result = await wrapperService.preview(scheduleVersion, policy);
    res.json(result);
  } catch (err: any) {
    if (err.code === "SCHEDULE_VERSION_CONFLICT") {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("Preview endpoint error:", err);
    next(err);
  }
});
schedulerRouter.get("/version", async (req, res, next) => {
  try {
    const versionResult = await db.select().from(scheduleVersions).limit(1);
    const currentVersion = versionResult[0]?.version || 0;
    res.json({ scheduleVersion: currentVersion });
  } catch (err) {
    next(err);
  }
});

schedulerRouter.post("/commit", authorize(["OPERATOR", "ADMIN"]), async (req, res, next) => {
  try {
    const { scheduleVersion, proposedReservations, policy } = req.body;
    if (typeof scheduleVersion !== "number" || !Array.isArray(proposedReservations)) {
      res.status(400).json({ error: "Invalid scheduleVersion or proposedReservations" });
      return;
    }
    const userId = (req.user as any).sub as string;
    const result = await wrapperService.commit(proposedReservations, scheduleVersion, userId, policy || "HYBRID");
    res.json(result);
  } catch (err: any) {
    if (err.code === "SCHEDULE_VERSION_CONFLICT") {
      res.status(409).json({ error: err.message });
      return;
    }
    next(err);
  }
});

schedulerRouter.post("/meta/reset", async (req, res, next) => {
  try {
    // SECURITY: Only allow reset in development or demo mode
    if (process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "true") {
      res.status(403).json({ error: "Reset Demo is only available in development/demo environment." });
      return;
    }

    const result = await runSeed();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

