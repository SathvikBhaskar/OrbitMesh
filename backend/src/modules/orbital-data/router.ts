import { Router } from "express";
import { syncService } from "./index";
import { db } from "../../db/client";
import { orbitalSyncRuns, satellites, groundStations, contactWindows, satelliteOrbitalData } from "../../db/schema";
import { desc, sql, eq } from "drizzle-orm";
import { twoline2satrec, propagate, eciToGeodetic, gstime, degreesLat, degreesLong } from "satellite.js";
import { validate } from "../../middlewares/validate";
import { getPositionsSchema } from "./schemas";

import { authorize } from "../../middlewares/auth";

export const orbitalSyncRouter = Router();

orbitalSyncRouter.post("/", authorize(["OPERATOR", "ADMIN"]), async (req, res, next) => {
  try {
    const result = await syncService.sync();
    
    if (result.status === "SKIPPED_ALREADY_RUNNING") {
      res.json({
        status: "SKIPPED",
        reason: "SYNC_ALREADY_RUNNING"
      });
      return;
    }

    if (result.status === "FAILED") {
      res.status(500).json({
        status: "FAILED",
        reason: result.error
      });
      return;
    }

    res.json({
      status: "SUCCESS",
      fetchedCount: result.report?.fetchedCount,
      discoveredCount: result.report?.discoveredCount,
      updatedCount: result.report?.updatedCount,
      ignoredCount: result.report?.ignoredCount,
      rejectedCount: result.report?.rejectedCount,
      regeneratedSatelliteCount: result.report?.updatedSatelliteIds.length,
      regeneratedWindowCount: result.report?.regeneratedWindowCount
    });

  } catch (error) {
    next(error);
  }
});

orbitalSyncRouter.get("/runs", async (req, res, next) => {
  try {
    const runs = await db
      .select()
      .from(orbitalSyncRuns)
      .orderBy(desc(orbitalSyncRuns.startedAt))
      .limit(20);
    res.json(runs);
  } catch (err) {
    next(err);
  }
});

orbitalSyncRouter.get("/status", async (req, res, next) => {
  try {
    const lastRun = await db
      .select()
      .from(orbitalSyncRuns)
      .orderBy(desc(orbitalSyncRuns.startedAt))
      .limit(1);

    const counts = await Promise.all([
      db.select({ count: sql`COUNT(*)` }).from(satellites),
      db.select({ count: sql`COUNT(*)` }).from(groundStations),
      db.select({ count: sql`COUNT(*)` }).from(contactWindows)
    ]);

    res.json({
      lastSync: lastRun.length > 0 ? lastRun[0] : null,
      satelliteCount: Number((counts[0] as any)[0].count),
      groundStationCount: Number((counts[1] as any)[0].count),
      contactWindowCount: Number((counts[2] as any)[0].count)
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/orbital-sync/positions?time=<ISO>
// Returns geodetic lat/lon/alt for each satellite at the given time, computed via SGP4.
// Falls back to current time if no ?time provided.
orbitalSyncRouter.get("/positions", validate(getPositionsSchema), async (req, res, next) => {
  try {
    const timeParam = req.query.time as string | undefined;
    const referenceTime = timeParam ? new Date(timeParam) : new Date();

    // Fetch satellites joined to their latest orbital snapshot
    const rows = await db.execute(sql`
      SELECT
        s.id, s.norad_id as "noradId", s.name, s.status,
        d.tle_line1 as "tleLine1", d.tle_line2 as "tleLine2",
        d.tle_epoch as "tleEpoch", d.source
      FROM satellites s
      INNER JOIN (
        SELECT DISTINCT ON (satellite_id) satellite_id, tle_line1, tle_line2, tle_epoch, source
        FROM satellite_orbital_data
        ORDER BY satellite_id, tle_epoch DESC
      ) d ON s.id = d.satellite_id
    `);

    const gmst = gstime(referenceTime);
    const results: any[] = [];

    for (const row of rows.rows as any[]) {
      try {
        const satrec = twoline2satrec(row.tleLine1, row.tleLine2);
        const pv = propagate(satrec, referenceTime);

        if (!pv || !pv.position || typeof pv.position === "boolean") continue;

        const posEci = pv.position as { x: number; y: number; z: number };
        const geo = eciToGeodetic(posEci, gmst);

        const latDeg = degreesLat(geo.latitude);
        const lonDeg = degreesLong(geo.longitude);
        const altKm = geo.height; // km above WGS-84 ellipsoid

        if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || !Number.isFinite(altKm)) continue;

        results.push({
          satelliteId: row.id,
          noradId: row.noradId,
          name: row.name,
          status: row.status,
          latitude: Math.round(latDeg * 1e5) / 1e5,
          longitude: Math.round(lonDeg * 1e5) / 1e5,
          altitudeKm: Math.round(altKm * 10) / 10,
          tleEpoch: row.tleEpoch,
          source: row.source,
          referenceTime: referenceTime.toISOString(),
          tleLine1: row.tleLine1,
          tleLine2: row.tleLine2
        });
      } catch {
        // Skip satellites whose TLE fails to propagate at this time (e.g. decayed)
        continue;
      }
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
});

