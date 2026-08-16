import { Router, Request, Response } from "express";
import { db } from "../../db/client";
import { satellites } from "../../db/schema";
import { eq } from "drizzle-orm";
import { OrbitalDataService } from "../orbital-data/services/orbital-data-service";
import { contactWindowsRouter } from "../contact-windows/router";
import { PositionService } from "../orbit/position-service";
import { VisibilityService } from "../visibility/visibility-service";

export const satellitesRouter = Router();
const orbitalDataService = new OrbitalDataService();
const positionService = new PositionService();
const visibilityService = new VisibilityService();

satellitesRouter.post("/", async (req, res) => {
  try {
    const { noradId, name, status } = req.body;
    const result = await db.insert(satellites).values({
      noradId,
      name,
      status: status || "ACTIVE"
    }).returning();
    res.status(201).json(result[0]);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

satellitesRouter.get("/", async (req, res) => {
  try {
    const result = await db.select().from(satellites);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

satellitesRouter.get("/:id", async (req, res) => {
  try {
    const result = await db.select().from(satellites).where(eq(satellites.id, req.params.id));
    if (result.length === 0) {
      res.status(404).json({ error: "Satellite not found" });
      return;
    }
    res.json(result[0]);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

satellitesRouter.patch("/:id", async (req, res) => {
  try {
    const { noradId, name, status } = req.body;
    const updateData: any = {};
    if (noradId !== undefined) updateData.noradId = noradId;
    if (name !== undefined) updateData.name = name;
    if (status !== undefined) updateData.status = status;
    updateData.updatedAt = new Date();

    const result = await db.update(satellites)
      .set(updateData)
      .where(eq(satellites.id, req.params.id))
      .returning();

    if (result.length === 0) {
      res.status(404).json({ error: "Satellite not found" });
      return;
    }
    res.json(result[0]);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

satellitesRouter.post("/:id/orbital-data/refresh", async (req, res) => {
  try {
    const record = await orbitalDataService.refreshOrbitalData(req.params.id);
    const noradId = (await db.select().from(satellites).where(eq(satellites.id, record!.satelliteId)))[0]!.noradId;
    res.status(200).json({
      satelliteId: record!.satelliteId,
      noradId: noradId,
      source: record!.source,
      tleEpoch: record!.tleEpoch.toISOString(),
      receivedAt: record!.receivedAt.toISOString()
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

satellitesRouter.get("/:id/position", async (req, res) => {
  try {
    const atQuery = req.query.at;
    if (!atQuery || typeof atQuery !== "string") {
      res.status(400).json({ error: "Missing or invalid 'at' timestamp query parameter" });
      return;
    }

    const timestamp = new Date(atQuery);
    if (isNaN(timestamp.getTime())) {
      res.status(400).json({ error: "Invalid timestamp format" });
      return;
    }

    const positionVelocity = await positionService.getPosition(req.params.id, timestamp);
    res.json(positionVelocity);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
satellitesRouter.get("/:id/visibility/:stationId", async (req: Request, res: Response): Promise<void> => {
  try {
    const satelliteId = req.params.id;
    const groundStationId = req.params.stationId;
    const startStr = req.query.start as string;
    const endStr = req.query.end as string;
    const stepStr = req.query.step as string;

    if (!satelliteId || !groundStationId || !startStr || !endStr || !stepStr) {
      res.status(400).json({ error: "Missing required parameters" });
      return;
    }

    const start = new Date(startStr);
    const end = new Date(endStr);
    const stepSeconds = parseInt(stepStr, 10);

    const result = await visibilityService.getVisibility(satelliteId as string, groundStationId as string, start, end, stepSeconds);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Phase 3: Contact Windows
satellitesRouter.use("/:id/ground-stations/:stationId/contact-windows", contactWindowsRouter);
