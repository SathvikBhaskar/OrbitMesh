import { Router, Request, Response } from "express";
import { ContactWindowService } from "./contact-window-service";
import { db } from "../../db/client";
import { contactWindows, satellites, groundStations } from "../../db/schema";
import { eq } from "drizzle-orm";
import { validate } from "../../middlewares/validate";
import { generateContactWindowsSchema } from "./schemas";
import { authorize } from "../../middlewares/auth";

export const contactWindowsRouter = Router({ mergeParams: true });
const contactWindowService = new ContactWindowService();

contactWindowsRouter.get("/", async (req: Request, res: Response, next): Promise<void> => {
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
  } catch (error) {
    next(error);
  }
});

const ADMIN_ONLY = ["ADMIN"];

contactWindowsRouter.post("/generate", authorize(ADMIN_ONLY), validate(generateContactWindowsSchema), async (req: Request, res: Response, next): Promise<void> => {
  try {
    const result = await contactWindowService.generateContactWindows(
      req.params.id as string,
      req.params.stationId as string,
      new Date(req.body.start),
      new Date(req.body.end),
      req.body.stepSeconds
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});
