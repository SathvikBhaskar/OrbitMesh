import { db } from "../../db/client";
import { contactWindows, satelliteOrbitalData } from "../../db/schema";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { VisibilityService } from "../visibility/visibility-service";
import { WindowDetector } from "./window-detector";
import { Refinement } from "./refinement";
import { CoarseWindow } from "./types";

import { TelemetrySink } from "../../utils/telemetry";

export class ContactWindowService {
  private visibilityService = new VisibilityService();
  private windowDetector = new WindowDetector();
  private refinement = new Refinement();

  public async generateContactWindows(
    satelliteId: string,
    groundStationId: string,
    start: Date,
    end: Date,
    stepSeconds: number,
    telemetry?: TelemetrySink
  ) {
    if (start >= end) throw new Error("start must be before end");
    if (stepSeconds < 1 || stepSeconds > 300) throw new Error("stepSeconds must be between 1 and 300");
    if (end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) throw new Error("observation range exceeds 24 hours");

    // Retrieve orbital data id that will be used
    const latestOrbital = await db
      .select()
      .from(satelliteOrbitalData)
      .where(eq(satelliteOrbitalData.satelliteId, satelliteId))
      .orderBy(desc(satelliteOrbitalData.tleEpoch))
      .limit(1);

    if (latestOrbital.length === 0) {
      throw new Error("No orbital data available for satellite");
    }

    // Get coarse visibility samples
    const { samples } = await this.visibilityService.getVisibility(
      satelliteId,
      groundStationId,
      start,
      end,
      stepSeconds,
      telemetry
    );

    // Detect coarse windows
    const coarseWindows = this.windowDetector.detectCoarseWindows(samples);

    // The function used by Refinement to determine pure visibility mathematically using the visibility service logic.
    // It calls the service for a single timestamp.
    const visibilityMathFn = async (t: Date): Promise<boolean> => {
      const { samples } = await this.visibilityService.getVisibility(
        satelliteId,
        groundStationId,
        t,
        t,
        stepSeconds, // doesn't matter for 0-duration range
        telemetry
      );
      return samples[0] ? samples[0].visible : false;
    };

    const results = [];
    const orbitalDataId = latestOrbital[0]!.id;

    for (const coarse of coarseWindows) {
      let aos = coarse.observationStart;
      let los = coarse.observationEnd;

      const tRefineStart = performance.now();
      if (coarse.aosBracket) {
        aos = await this.refinement.refineTransition(
          coarse.aosBracket.before,
          coarse.aosBracket.after,
          visibilityMathFn,
          "AOS",
          1 // 1-second tolerance
        );
      }
      
      if (coarse.losBracket) {
        los = await this.refinement.refineTransition(
          coarse.losBracket.before,
          coarse.losBracket.after,
          visibilityMathFn,
          "LOS",
          1 // 1-second tolerance
        );
      }
      if (telemetry) telemetry.recordTime("refinement", performance.now() - tRefineStart);

      // Truncate milliseconds to ensure exact integer match with duration_seconds in Postgres
      aos.setMilliseconds(0);
      los.setMilliseconds(0);

      // Final constraint checks internally
      const durationSeconds = Math.round((los.getTime() - aos.getTime()) / 1000);
      if (durationSeconds <= 0) continue; // safety fallback for weird bracket collapse

      const tDbStart = performance.now();
      // Check idempotency (exact same window generation config)
      const existing = await db
        .select()
        .from(contactWindows)
        .where(
          and(
            eq(contactWindows.satelliteId, satelliteId),
            eq(contactWindows.groundStationId, groundStationId),
            eq(contactWindows.orbitalDataId, orbitalDataId),
            eq(contactWindows.aos, aos),
            eq(contactWindows.los, los)
          )
        )
        .limit(1);

      let recordId: string;
      if (existing.length === 0) {
        const result = await db.insert(contactWindows).values({
          satelliteId,
          groundStationId,
          orbitalDataId,
          aos,
          los,
          durationSeconds,
          maxElevationDeg: coarse.maxElevationDeg
        }).returning({ id: contactWindows.id });
        recordId = result[0]!.id;
      } else {
        recordId = existing[0]!.id;
      }
      if (telemetry) telemetry.recordTime("database", performance.now() - tDbStart);

      results.push({
        id: recordId,
        satelliteId,
        groundStationId,
        orbitalDataId,
        aos,
        los,
        durationSeconds,
        maxElevationDeg: coarse.maxElevationDeg,
      });
    }

    if (telemetry) telemetry.increment("contact_windows_generated", results.length);
    return { windows: results };
  }
}
