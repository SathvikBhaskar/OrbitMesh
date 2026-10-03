import { Router } from "express";
import { db } from "../../db/client";
import { missionTasks } from "../../db/schema";
import { eq } from "drizzle-orm";
import { validate } from "../../middlewares/validate";
import { authenticate, authorize } from "../../middlewares/auth";
import {
  createMissionTaskSchema,
  updateMissionTaskSchema,
  getMissionTaskSchema
} from "./schemas";

export const missionTasksRouter = Router();

missionTasksRouter.post("/", authenticate, authorize(["OPERATOR", "ADMIN"]), validate(createMissionTaskSchema), async (req, res, next) => {
  try {
    const { satelliteId, name, description, priority, durationSeconds, deadline, targetBytes, requiredFrequencyBand, minDataRateMbps } = req.body;
    const result = await db.insert(missionTasks).values({
      satelliteId,
      name,
      description,
      priority,
      durationSeconds,
      deadline: new Date(deadline),
      targetBytes: targetBytes ? String(targetBytes) : null,
      requiredFrequencyBand,
      minDataRateMbps,
      status: "PENDING"
    }).returning();
    res.status(201).json(result[0]);
  } catch (err) {
    next(err);
  }
});

missionTasksRouter.get("/", authenticate, async (req, res, next) => {
  try {
    const result = await db.select().from(missionTasks).orderBy(missionTasks.createdAt);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

missionTasksRouter.get("/:id", authenticate, validate(getMissionTaskSchema), async (req, res, next) => {
  try {
    const result = await db.select().from(missionTasks).where(eq(missionTasks.id, req.params.id as string));
    if (result.length === 0) {
      res.status(404).json({ error: "Mission task not found" });
      return;
    }
    res.json(result[0]);
  } catch (err) {
    next(err);
  }
});

missionTasksRouter.patch("/:id", authenticate, authorize(["OPERATOR", "ADMIN"]), validate(updateMissionTaskSchema), async (req, res, next) => {
  try {
    const existing = await db.select().from(missionTasks).where(eq(missionTasks.id, req.params.id as string));
    if (existing.length === 0 || !existing[0]) {
      res.status(404).json({ error: "Mission task not found" });
      return;
    }

    const currentStatus = existing[0].status;
    if (currentStatus === "COMPLETED" || currentStatus === "CANCELLED" || currentStatus === "FAILED") {
      res.status(409).json({ error: `TASK_NOT_EDITABLE: Cannot edit a ${currentStatus} task` });
      return;
    }
    
    if (currentStatus === "SCHEDULED") {
      res.status(409).json({ error: `TASK_NOT_EDITABLE: Cannot edit a SCHEDULED task` });
      return;
    }

    const { name, description, priority, durationSeconds, deadline, status, targetBytes } = req.body;
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (priority !== undefined) updateData.priority = priority;
    if (durationSeconds !== undefined) updateData.durationSeconds = durationSeconds;
    if (deadline !== undefined) updateData.deadline = new Date(deadline);
    if (status !== undefined) updateData.status = status; // Only CANCELLED is allowed by schema
    if (targetBytes !== undefined) {
      updateData.targetBytes = targetBytes;
      const fulfilled = existing[0]?.fulfilledBytes ? Number(existing[0].fulfilledBytes) : 0;
      updateData.remainingBytes = Math.max(0, targetBytes - fulfilled);
    }
    updateData.updatedAt = new Date();

    const result = await db.update(missionTasks)
      .set(updateData)
      .where(eq(missionTasks.id, req.params.id as string))
      .returning();

    res.json(result[0]);
  } catch (err) {
    next(err);
  }
});

import { contactWindows } from "../../db/schema";

missionTasksRouter.get("/:id/contact-windows", authenticate, async (req, res, next) => {
  try {
    const taskId = req.params.id as string;
    
    // Get task
    const taskResult = await db.select().from(missionTasks).where(eq(missionTasks.id, taskId));
    if (taskResult.length === 0) {
      res.status(404).json({ error: "Mission task not found" });
      return;
    }
    const task = taskResult[0];

    // Get contact windows for that satellite
    const windows = await db.select().from(contactWindows).where(eq(contactWindows.satelliteId, task!.satelliteId));
    
    res.json(windows);
  } catch (err) {
    next(err);
  }
});
