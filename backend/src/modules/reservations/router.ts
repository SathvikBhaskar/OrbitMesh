import { Router } from "express";
import { db } from "../../db/client";
import { reservations, missionTasks, satellites, groundStations } from "../../db/schema";
import { eq, desc } from "drizzle-orm";

export const reservationsRouter = Router();

reservationsRouter.get("/", async (req, res) => {
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
