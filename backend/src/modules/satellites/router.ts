import { Router, Request, Response } from "express";
import { db } from "../../db/client";
import { satellites, satelliteOrbitalData } from "../../db/schema";
import { eq, sql } from "drizzle-orm";
import { OrbitalDataService } from "../orbital-data/services/orbital-data-service";
import { contactWindowsRouter } from "../contact-windows/router";
import { PositionService } from "../orbit/position-service";
import { VisibilityService } from "../visibility/visibility-service";
import { authorize } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import {
  createSatelliteSchema,
  updateSatelliteSchema,
  getSatelliteSchema,
  getSatellitePositionSchema,
  getSatelliteVisibilitySchema
} from "./schemas";

export const satellitesRouter = Router();
const orbitalDataService = new OrbitalDataService();
const positionService = new PositionService();
const visibilityService = new VisibilityService();

const ADMIN_ONLY = ["ADMIN"];

satellitesRouter.post("/", authorize(ADMIN_ONLY), validate(createSatelliteSchema), async (req, res, next) => {
  try {
    const { noradId, name, status } = req.body;
    const result = await db.insert(satellites).values({
      noradId,
      name,
      status: status || "ACTIVE"
    }).returning();
    res.status(201).json(result[0]);
  } catch (err) {
    next(err);
  }
});

satellitesRouter.get("/", async (req, res, next) => {
  try {
    const result = await db.execute(sql`
      SELECT 
        s.id, s.norad_id as "noradId", s.name, s.status,
        d.tle_epoch as "tleEpoch", d.source
      FROM satellites s
      LEFT JOIN (
        SELECT DISTINCT ON (satellite_id) satellite_id, tle_epoch, source 
        FROM satellite_orbital_data 
        ORDER BY satellite_id, tle_epoch DESC
      ) d ON s.id = d.satellite_id
      ORDER BY s.norad_id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

satellitesRouter.get("/:id", validate(getSatelliteSchema), async (req, res, next) => {
  try {
    const result = await db.select().from(satellites).where(eq(satellites.id, req.params.id as string));
    if (result.length === 0) {
      res.status(404).json({ error: "Satellite not found" });
      return;
    }
    res.json(result[0]);
  } catch (err) {
    next(err);
  }
});

satellitesRouter.patch("/:id", authorize(ADMIN_ONLY), validate(updateSatelliteSchema), async (req, res, next) => {
  try {
    const { noradId, name, status } = req.body;
    const updateData: any = {};
    if (noradId !== undefined) updateData.noradId = noradId;
    if (name !== undefined) updateData.name = name;
    if (status !== undefined) updateData.status = status;
    updateData.updatedAt = new Date();

    const result = await db.update(satellites)
      .set(updateData)
      .where(eq(satellites.id, req.params.id as string))
      .returning();

    if (result.length === 0) {
      res.status(404).json({ error: "Satellite not found" });
      return;
    }
    res.json(result[0]);
  } catch (err) {
    next(err);
  }
});

satellitesRouter.post("/:id/orbital-data/refresh", authorize(ADMIN_ONLY), validate(getSatelliteSchema), async (req, res, next) => {
  try {
    const record = await orbitalDataService.refreshOrbitalData(req.params.id as string);
    const noradId = (await db.select().from(satellites).where(eq(satellites.id, record!.satelliteId)))[0]!.noradId;
    res.status(200).json({
      satelliteId: record!.satelliteId,
      noradId: noradId,
      source: record!.source,
      tleEpoch: record!.tleEpoch.toISOString(),
      receivedAt: record!.receivedAt.toISOString()
    });
  } catch (err) {
    next(err);
  }
});

satellitesRouter.get("/:id/position", validate(getSatellitePositionSchema), async (req, res, next) => {
  try {
    const atQuery = req.query.at;
    if (!atQuery || typeof atQuery !== "string") {
      res.status(400).json({ error: "Missing or invalid 'at' timestamp query parameter" });
      return;
    }

    const timestamp = new Date(req.query.at as string);

    const positionVelocity = await positionService.getPosition(req.params.id as string, timestamp);
    res.json(positionVelocity);
  } catch (err) {
    next(err);
  }
});
satellitesRouter.get("/:id/visibility/:stationId", validate(getSatelliteVisibilitySchema), async (req: Request, res: Response, next): Promise<void> => {
  try {
    const satelliteId = req.params.id as string;
    const groundStationId = req.params.stationId as string;
    const startStr = req.query.start as string;
    const endStr = req.query.end as string;
    const stepStr = req.query.step as string;

    const start = new Date(startStr);
    const end = new Date(endStr);
    const stepSeconds = parseInt(stepStr, 10);

    const result = await visibilityService.getVisibility(satelliteId, groundStationId, start, end, stepSeconds);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Phase 3: Contact Windows
satellitesRouter.use("/:id/ground-stations/:stationId/contact-windows", contactWindowsRouter);
