import { Router } from "express";
import { db } from "../../db/client";
import { missionTasks } from "../../db/schema";
import { eq } from "drizzle-orm";

export const missionTasksRouter = Router();

missionTasksRouter.post("/", async (req, res) => {
  try {
    // Note: 'status' is omitted so client cannot set it (always PENDING via schema default or forced here).
    // Actually, our schema requires 'status', but we should always set it to PENDING on creation.
    const { satelliteId, name, description, priority, durationSeconds, deadline } = req.body;
    const result = await db.insert(missionTasks).values({
      satelliteId,
      name,
      description,
      priority,
      durationSeconds,
      deadline: new Date(deadline),
      status: "PENDING"
    }).returning();
    res.status(201).json(result[0]);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

missionTasksRouter.get("/", async (req, res) => {
  try {
    const result = await db.select().from(missionTasks);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

missionTasksRouter.get("/:id", async (req, res) => {
  try {
    const result = await db.select().from(missionTasks).where(eq(missionTasks.id, req.params.id));
    if (result.length === 0) {
      res.status(404).json({ error: "Mission task not found" });
      return;
    }
    res.json(result[0]);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

missionTasksRouter.patch("/:id", async (req, res) => {
  try {
    // Client should ideally not update status directly, but for now we only prevent it on creation,
    // or we can allow it for scheduler mock. 
    // "For mission tasks, don't initially let the client arbitrarily set status on creation."
    const { name, description, priority, durationSeconds, deadline } = req.body;
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (priority !== undefined) updateData.priority = priority;
    if (durationSeconds !== undefined) updateData.durationSeconds = durationSeconds;
    if (deadline !== undefined) updateData.deadline = new Date(deadline);
    updateData.updatedAt = new Date();

    const result = await db.update(missionTasks)
      .set(updateData)
      .where(eq(missionTasks.id, req.params.id))
      .returning();

    if (result.length === 0) {
      res.status(404).json({ error: "Mission task not found" });
      return;
    }
    res.json(result[0]);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
