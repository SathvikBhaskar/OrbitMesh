import { OrbitalSyncService } from "./orbital-sync-service";
import { logger } from "../../../config/logger";
import { tleUpdatesTotal } from "../../../config/metrics";

export class OrbitalSyncWorker {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private syncService: OrbitalSyncService,
    private intervalSeconds: number
  ) {}

  public start() {
    if (this.timer) {
      return; // already started
    }

    if (this.intervalSeconds <= 0) {
      logger.warn("OrbitalSyncWorker: Interval must be > 0. Worker not started.");
      return;
    }

    logger.info(`OrbitalSyncWorker started. Interval: ${this.intervalSeconds}s`);

    this.timer = setInterval(async () => {
      logger.info(`[OrbitalSyncWorker] Triggering periodic sync...`);
      try {
        const result = await this.syncService.sync();
        if (result.status === "SUCCESS") {
          logger.info(`[OrbitalSyncWorker] Sync SUCCESS. Updated: ${result.report?.updatedCount}`);
          if (result.report?.updatedCount) {
             tleUpdatesTotal.inc(result.report.updatedCount);
          }
        } else {
          logger.info(`[OrbitalSyncWorker] Sync returned status: ${result.status}`);
        }
      } catch (err) {
        logger.error({ err }, `[OrbitalSyncWorker] Sync failed to execute cleanly`);
      }
    }, this.intervalSeconds * 1000);
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info(`OrbitalSyncWorker stopped.`);
    }
  }
}
