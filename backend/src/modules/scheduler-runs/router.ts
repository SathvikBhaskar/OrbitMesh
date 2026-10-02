import { Router } from "express";
import { db } from "../../db/client";
import { schedulerRuns } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import { validate } from "../../middlewares/validate";
import { getSchedulerRunSchema } from "./schemas";

export const schedulerRunsRouter = Router();

schedulerRunsRouter.get("/", async (req, res, next) => {
  try {
    // Return all runs ordered by most recent first
    const results = await db
      .select()
      .from(schedulerRuns)
      .orderBy(desc(schedulerRuns.startedAt));
    res.json(results);
  } catch (err) {
    next(err);
  }
});

schedulerRunsRouter.get("/:id", validate(getSchedulerRunSchema), async (req, res, next) => {
  try {
    const results = await db
      .select()
      .from(schedulerRuns)
      .where(eq(schedulerRuns.id, req.params.id as string));
      
    if (results.length === 0) {
      res.status(404).json({ error: "Scheduler run not found" });
      return;
    }
    
    res.json(results[0]);
  } catch (err) {
    next(err);
  }
});
