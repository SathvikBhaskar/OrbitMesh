import { Router } from "express";
import { db } from "../../db/client";
import { reservations, missionTasks, satellites, groundStations, contactWindows, scheduleAuditLog, scheduleVersions } from "../../db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { validate } from "../../middlewares/validate";
import { authorize } from "../../middlewares/auth";
import { getReservationSchema, previewReservationSchema, lockReservationSchema } from "./schemas";
import { constraintValidator } from "./constraint-validator";

export const reservationsRouter = Router();

reservationsRouter.get("/", async (req, res, next) => {
  try {
    // We join to get task, satellite, and station names so the frontend timeline has labels
    const results = await db
      .select({
        id: reservations.id,
        missionTaskId: reservations.missionTaskId,
        taskName: missionTasks.name,
        taskPriority: missionTasks.priority,
        contactWindowId: reservations.contactWindowId,
        satelliteId: reservations.satelliteId,
        satelliteName: satellites.name,
        groundStationId: reservations.groundStationId,
        groundStationName: groundStations.name,
        allocatedStart: reservations.allocatedStart,
        allocatedEnd: reservations.allocatedEnd,
        taskDurationSeconds: reservations.taskDurationSeconds,
        windowAos: reservations.windowAos,
        windowLos: reservations.windowLos,
        status: reservations.status,
        createdAt: reservations.createdAt,
      })
      .from(reservations)
      .leftJoin(missionTasks, eq(reservations.missionTaskId, missionTasks.id))
      .leftJoin(satellites, eq(reservations.satelliteId, satellites.id))
      .leftJoin(groundStations, eq(reservations.groundStationId, groundStations.id))
      .orderBy(reservations.allocatedStart);
      
    res.json(results);
  } catch (err) {
    next(err);
  }
});

reservationsRouter.get("/:id", validate(getReservationSchema), async (req, res, next) => {
  try {
    const result = await db.select().from(reservations).where(eq(reservations.id, req.params.id as string));
    if (result.length === 0) {
      res.status(404).json({ error: "Reservation not found" });
      return;
    }
    res.json(result[0]);
  } catch (err) {
    next(err);
  }
});

reservationsRouter.post("/preview", authorize(["OPERATOR", "ADMIN"]), validate(previewReservationSchema), async (req, res, next) => {
  try {
    const { taskId, contactWindowId, satelliteId, groundStationId, startTime, endTime, locked } = req.body;
    
    const requestArgs = {
      taskId,
      contactWindowId,
      satelliteId,
      groundStationId,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      locked,
    };

    const validationResult = await constraintValidator.validate(requestArgs);

    if (!validationResult.valid) {
      res.json({
        valid: false,
        errors: validationResult.errors,
      });
      return;
    }

    res.json({
      valid: true,
      errors: []
    });
  } catch (err) {
    next(err);
  }
});

reservationsRouter.post("/", authorize(["OPERATOR", "ADMIN"]), validate(previewReservationSchema), async (req, res, next) => {
  try {
    const { taskId, contactWindowId, satelliteId, groundStationId, startTime, endTime } = req.body;
    
    const requestArgs = {
      taskId,
      contactWindowId,
      satelliteId,
      groundStationId,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
    };

    let newReservation;

    await db.transaction(async (tx) => {
      const validationResult = await constraintValidator.validate(requestArgs, tx);

      if (!validationResult.valid) {
        const err: any = new Error("Validation Failed");
        err.name = "ValidationError";
        err.validationResult = { valid: false, errors: validationResult.errors };
        throw err; // Auto rollbacks transaction
      }

      // Re-fetch cw and task for constraints (since they exist due to validation)
      const cw = await tx.select().from(contactWindows).where(eq(contactWindows.id, contactWindowId)).then(r => r[0]);
      const task = await tx.select().from(missionTasks).where(eq(missionTasks.id, taskId)).then(r => r[0]);

      const [inserted] = await tx.insert(reservations).values({
        missionTaskId: taskId,
        contactWindowId: contactWindowId,
        groundStationId: cw!.groundStationId,
        satelliteId: cw!.satelliteId,
        windowAos: cw!.aos,
        windowLos: cw!.los,
        taskDurationSeconds: task!.durationSeconds,
        allocatedStart: requestArgs.startTime,
        allocatedEnd: requestArgs.endTime,
        status: "PENDING",
        source: "MANUAL",
        locked: false,
      }).returning();

      newReservation = inserted;
    }, { isolationLevel: "serializable" });

    res.status(201).json(newReservation);
  } catch (err: any) {
    if (err?.name === "ValidationError") {
      res.status(422).json(err.validationResult);
      return;
    }
    // Drizzle rollback errors that we throw might get wrapped.
    // If it's a serialization failure (40001), PostgreSQL aborted it.
    // We'll let the global error handler catch 500s or we could map 40001 to 409 Conflict.
    if (err.code === '40001') {
      res.status(409).json({ error: "Concurrent modification conflict. Please try again." });
      return;
    }
    next(err);
  }
});

reservationsRouter.patch("/:id/lock", authorize(["OPERATOR", "ADMIN"]), validate(lockReservationSchema), async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const { locked, reason } = req.body as { locked: boolean; reason: string };
    const userId = (req.user as any).sub as string;

    let updatedResv: any = null;

    await db.transaction(async (tx) => {
      // 1. Read reservation and lock it for update
      const resvResult = await tx.select().from(reservations).where(eq(reservations.id, id)).for("update");
      const resv = resvResult[0];

      if (!resv) {
        const err: any = new Error("Reservation not found");
        err.name = "NotFoundError";
        throw err;
      }

      // 2. Verify reservation is MANUAL
      if (resv.source !== "MANUAL") {
        const err: any = new Error("Cannot lock automated reservations");
        err.name = "ValidationError";
        err.code = "RESERVATION_SOURCE_NOT_MANUAL";
        throw err;
      }

      // 3. Capture before state
      const beforeState = { locked: resv.locked, source: resv.source };

      // 4. Update reservation
      const [updated] = await tx.update(reservations)
        .set({ locked, updatedAt: new Date() })
        .where(eq(reservations.id, id))
        .returning();
      updatedResv = updated;

      // 5. Capture after state
      const afterState = { locked: updated!.locked, source: updated!.source };

      // 6. Write audit log
      await tx.insert(scheduleAuditLog).values([{
        userId: userId,
        entityType: "RESERVATION",
        entityId: id,
        action: locked ? "LOCK_RESERVATION" : "UNLOCK_RESERVATION",
        beforeState,
        afterState,
        reason,
      }]);

      // 7. Increment schedule version
      await tx.update(scheduleVersions)
        .set({ 
          version: sql`${scheduleVersions.version} + 1`, 
          updatedAt: new Date() 
        })
        .where(eq(scheduleVersions.id, 1));
    });

    res.json(updatedResv);
  } catch (err: any) {
    if (err.name === "NotFoundError") {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err.name === "ValidationError") {
      res.status(422).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
});
