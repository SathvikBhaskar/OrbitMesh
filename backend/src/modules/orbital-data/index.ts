import { RealOrbitalDataProvider } from "../data-providers/real-provider";
import { OrbitalDataIngestionService } from "./services/ingestion-service";
import { IncrementalContactWindowService } from "../contact-windows/incremental-contact-window-service";
import { ContactWindowService } from "../contact-windows/contact-window-service";
import { OrbitalSyncService } from "./services/orbital-sync-service";
import { OrbitalSyncWorker } from "./services/orbital-sync-worker";
import { env } from "../../config/env";

export const realProvider = new RealOrbitalDataProvider();
export const ingestionService = new OrbitalDataIngestionService(realProvider);
export const incrementalContactWindowService = new IncrementalContactWindowService(new ContactWindowService());

export const syncService = new OrbitalSyncService(
  realProvider,
  ingestionService,
  incrementalContactWindowService
);

export const syncWorker = new OrbitalSyncWorker(
  syncService,
  env.orbitalSyncIntervalSeconds
);
