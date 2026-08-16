import { Router, Request, Response } from "express";
import { ContactWindowService } from "./contact-window-service";
import { db } from "../../db/client";
import { contactWindows, satellites, groundStations } from "../../db/schema";
import { eq } from "drizzle-orm";

export const contactWindowsRouter = Router({ mergeParams: true });
const contactWindowService = new ContactWindowService();

contactWindowsRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const results = await db
      .select({
        id: contactWindows.id,
        satelliteId: contactWindows.satelliteId,
        groundStationId: contactWindows.groundStationId,
        aos: contactWindows.aos,
        los: contactWindows.los,
        durationSeconds: contactWindows.durationSeconds,
        maxElevationDeg: contactWindows.maxElevationDeg,
        satelliteName: satellites.name,
        groundStationName: groundStations.name,
      })
      .from(contactWindows)
      .leftJoin(satellites, eq(contactWindows.satelliteId, satellites.id))
      .leftJoin(groundStations, eq(contactWindows.groundStationId, groundStations.id))
      .orderBy(contactWindows.aos);
    
    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: "Internal server error" });
  }
});

contactWindowsRouter.post("/generate", async (req: Request, res: Response): Promise<void> => {
  try {
    const satelliteId = req.params.id;
    const groundStationId = req.params.stationId;
    
    if (!satelliteId || !groundStationId) {
      res.status(400).json({ error: "Missing path parameters" });
      return;
    }

    const { start, end, stepSeconds } = req.body;
    
    if (!start || !end || typeof stepSeconds !== "number") {
      res.status(400).json({ error: "Missing or invalid payload fields: start, end, stepSeconds" });
      return;
    }

    const startDate = new Date(start);
    const endDate = new Date(end);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      res.status(400).json({ error: "Invalid start or end dates" });
      return;
    }

    const result = await contactWindowService.generateContactWindows(
      satelliteId as string,
      groundStationId as string,
      startDate,
      endDate,
      stepSeconds
    );

    res.json(result);
  } catch (error: any) {
    if (
      error.message.includes("start must be before end") ||
      error.message.includes("stepSeconds must be between") ||
      error.message.includes("exceeds 24 hours")
    ) {
      res.status(400).json({ error: error.message });
      return;
    }
    
    if (error.message.includes("No orbital data") || error.message.includes("not found")) {
      res.status(404).json({ error: error.message });
      return;
    }

    console.error("Error generating contact windows:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
