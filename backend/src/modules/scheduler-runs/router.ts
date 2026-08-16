import { Router } from "express";
import { db } from "../../db/client";
import { schedulerRuns } from "../../db/schema";
import { eq, desc } from "drizzle-orm";

export const schedulerRunsRouter = Router();

schedulerRunsRouter.get("/", async (req, res) => {
  try {
    // Return all runs ordered by most recent first
    const results = await db
      .select()
      .from(schedulerRuns)
      .orderBy(desc(schedulerRuns.startedAt));
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

schedulerRunsRouter.get("/:id", async (req, res) => {
  try {
    const results = await db
      .select()
      .from(schedulerRuns)
      .where(eq(schedulerRuns.id, req.params.id));
      
    if (results.length === 0) {
      res.status(404).json({ error: "Scheduler run not found" });
      return;
    }
    
    res.json(results[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
