import { db } from "../../../db/client";
import { orbitalSyncRuns } from "../../../db/schema";
import { OrbitalDataProvider } from "../../data-providers/orbital-data-provider";
import { OrbitalDataIngestionService } from "./ingestion-service";
import { IncrementalContactWindowService } from "../../contact-windows/incremental-contact-window-service";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";

export class OrbitalSyncService {
  private isRunning = false;

  constructor(
    private dataProvider: OrbitalDataProvider,
    private ingestionService: OrbitalDataIngestionService,
    private incrementalContactWindowService: IncrementalContactWindowService
  ) {}

  public async sync(referenceTime?: Date, horizonHours: number = 24) {
    if (this.isRunning) {
      return { status: "SKIPPED_ALREADY_RUNNING" };
    }

    this.isRunning = true;
    const runId = randomUUID();
    const startTime = new Date();
    
    try {
      await db.insert(orbitalSyncRuns).values({
        id: runId,
        startedAt: startTime,
        status: "RUNNING",
        provider: "RealOrbitalDataProvider"
      });

      // 1. Fetch & Ingest
      const ingestionReport = await this.ingestionService.ingest();

      if (ingestionReport.errors && ingestionReport.errors.length > 0) {
        throw new Error(ingestionReport.errors.join("; "));
      }

      let regeneratedWindows = 0;
      
      // 2. Incremental Regeneration
      if (ingestionReport.updatedSatelliteIds.length > 0) {
        const refTime = referenceTime || new Date();
        regeneratedWindows = await this.incrementalContactWindowService.regenerateForSatellites(
          ingestionReport.updatedSatelliteIds,
          refTime,
          horizonHours
        );
      }

      // 3. Complete successful run
      const completedAt = new Date();
      await db.update(orbitalSyncRuns).set({
        completedAt,
        status: "SUCCESS",
        requestedSatelliteCount: ingestionReport.fetchedCount,
        fetchedCount: ingestionReport.fetchedCount,
        discoveredCount: ingestionReport.discoveredCount,
        updatedCount: ingestionReport.updatedCount,
        ignoredCount: ingestionReport.ignoredCount,
        rejectedCount: ingestionReport.rejectedCount,
        regeneratedSatelliteCount: ingestionReport.updatedSatelliteIds.length,
        regeneratedWindowCount: regeneratedWindows
      }).where(eq(orbitalSyncRuns.id, runId));

      this.isRunning = false;

      return {
        status: "SUCCESS",
        report: {
          ...ingestionReport,
          regeneratedWindowCount: regeneratedWindows
        }
      };

    } catch (err: any) {
      const completedAt = new Date();
      await db.update(orbitalSyncRuns).set({
        completedAt,
        status: "FAILED",
        errorMessage: err.message || "Unknown error"
      }).where(eq(orbitalSyncRuns.id, runId));
      
      this.isRunning = false;

      return {
        status: "FAILED",
        error: err.message
      };
    }
  }
}
