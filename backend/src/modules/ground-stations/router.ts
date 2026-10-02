import { Router } from "express";
import { db } from "../../db/client";
import { groundStations } from "../../db/schema";
import { eq } from "drizzle-orm";
import { authorize } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import {
  createGroundStationSchema,
  updateGroundStationSchema,
  getGroundStationSchema
} from "./schemas";

export const groundStationsRouter = Router();

const ADMIN_ONLY = ["ADMIN"];

groundStationsRouter.post("/", authorize(ADMIN_ONLY), validate(createGroundStationSchema), async (req, res, next) => {
  try {
    const { code, name, latitude, longitude, minimumElevationDeg, status } = req.body;
    const result = await db.insert(groundStations).values({
      code,
      name,
      latitude,
      longitude,
      minimumElevationDeg,
      status: status || "AVAILABLE"
    }).returning();
    res.status(201).json(result[0]);
  } catch (err) {
    next(err);
  }
});

groundStationsRouter.get("/", async (req, res, next) => {
  try {
    const result = await db.select().from(groundStations);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

groundStationsRouter.get("/:id", validate(getGroundStationSchema), async (req, res, next) => {
  try {
    const result = await db.select().from(groundStations).where(eq(groundStations.id, req.params.id as string));
    if (result.length === 0) {
      res.status(404).json({ error: "Ground station not found" });
      return;
    }
    res.json(result[0]);
  } catch (err) {
    next(err);
  }
});

groundStationsRouter.patch("/:id", authorize(ADMIN_ONLY), validate(updateGroundStationSchema), async (req, res, next) => {
  try {
    const { code, name, latitude, longitude, minimumElevationDeg, status } = req.body;
    const updateData: any = {};
    if (code !== undefined) updateData.code = code;
    if (name !== undefined) updateData.name = name;
    if (latitude !== undefined) updateData.latitude = latitude;
    if (longitude !== undefined) updateData.longitude = longitude;
    if (minimumElevationDeg !== undefined) updateData.minimumElevationDeg = minimumElevationDeg;
    if (status !== undefined) updateData.status = status;
    updateData.updatedAt = new Date();

    const result = await db.update(groundStations)
      .set(updateData)
      .where(eq(groundStations.id, req.params.id as string))
      .returning();

    if (result.length === 0) {
      res.status(404).json({ error: "Ground station not found" });
      return;
    }
    res.json(result[0]);
  } catch (err) {
    next(err);
  }
});
