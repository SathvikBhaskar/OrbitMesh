import { Router } from "express";
import { CandidateService } from "./candidate-service";
import { FcfsScheduler } from "./fcfs-scheduler";
import { PriorityScheduler } from "./priority-scheduler";
import { MetaScheduler } from "../meta-scheduler/meta-scheduler";

import { db } from "../../db/client";
import { missionTasks } from "../../db/schema";
import { eq } from "drizzle-orm";
import { runSeed } from "../../db/seed";

export const schedulerRouter = Router();

const candidateService = new CandidateService();
const fcfsScheduler = new FcfsScheduler(candidateService);
const priorityScheduler = new PriorityScheduler(candidateService);

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

schedulerRouter.post("/meta/run", async (req, res, next) => {
  try {
    // Check if there are any pending tasks before attempting to run
    const pendingCount = await db
      .select({ id: missionTasks.id })
      .from(missionTasks)
      .where(eq(missionTasks.status, "PENDING"));

    if (pendingCount.length === 0) {
      res.status(400).json({ error: "No pending tasks available to schedule." });
      return;
    }

    const result = await metaScheduler.schedulePendingTasks();
    
    // In MetaScheduler, the run output is saved to the db and returned.
    // The result object already includes the execution status.
    res.json({
      ...result,
      decision: metaScheduler.getDecision()
    });
  } catch (err) {
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

