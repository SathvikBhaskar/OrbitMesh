import { OrbitalDataProvider } from "../../data-providers/orbital-data-provider";
import { db } from "../../../db/client";
import { satellites, satelliteOrbitalData } from "../../../db/schema";
import { inArray, sql } from "drizzle-orm";

export interface IngestionReport {
  fetchedCount: number;
  discoveredCount: number;
  updatedCount: number;
  ignoredCount: number;
  rejectedCount: number;
  updatedSatelliteIds: string[];
  errors: string[];
}

export class OrbitalDataIngestionService {
  constructor(private provider: OrbitalDataProvider) {}

  public async ingest(): Promise<IngestionReport> {
    const report: IngestionReport = {
      fetchedCount: 0,
      discoveredCount: 0,
      updatedCount: 0,
      ignoredCount: 0,
      rejectedCount: 0,
      updatedSatelliteIds: [],
      errors: []
    };

    try {
      // 1. Fetch from provider
      const satsConfig = await this.provider.getSatellites();
      report.fetchedCount = satsConfig.length;

      if (satsConfig.length === 0) {
        return report;
      }

      const noradIds = satsConfig.map(s => s.noradId);

      // 2. Determine discoveries
      const existingSats = await db
        .select({ noradId: satellites.noradId })
        .from(satellites)
        .where(inArray(satellites.noradId, noradIds));
      
      const existingNorads = new Set(existingSats.map(s => s.noradId));
      report.discoveredCount = satsConfig.filter(s => !existingNorads.has(s.noradId)).length;

      // 3. Upsert satellites (handles concurrency natively via PostgreSQL ON CONFLICT)
      await db.insert(satellites)
        .values(satsConfig)
        .onConflictDoUpdate({
          target: satellites.noradId,
          set: { name: sql`EXCLUDED.name`, updatedAt: sql`NOW()` }
        });

      // 4. Retrieve their DB generated IDs
      const dbSats = await db
        .select({ id: satellites.id, noradId: satellites.noradId })
        .from(satellites)
        .where(inArray(satellites.noradId, noradIds));

      const noradToDbId = new Map(dbSats.map(s => [s.noradId, s.id]));
      
      // Preserve the order required by the provider
      const orderedSatIds = satsConfig.map(s => noradToDbId.get(s.noradId)!);

      // 5. Fetch orbital snapshots
      const newOrbitalData = await this.provider.getOrbitalData(orderedSatIds);

      // 6. Get latest epochs for comparison
      const latestEpochsQuery = await db
        .select({
          satelliteId: satelliteOrbitalData.satelliteId,
          latestEpoch: sql<Date>`MAX(${satelliteOrbitalData.tleEpoch})`
        })
        .from(satelliteOrbitalData)
        .where(inArray(satelliteOrbitalData.satelliteId, orderedSatIds))
        .groupBy(satelliteOrbitalData.satelliteId);

      const latestEpochMap = new Map<string, number>();
      for (const row of latestEpochsQuery) {
        latestEpochMap.set(row.satelliteId, new Date(row.latestEpoch).getTime());
      }

      // 7. Strict Epoch Comparison
      const toInsert = [];

      for (const newData of newOrbitalData) {
        const satId = newData.satelliteId;
        const newEpochTime = newData.tleEpoch.getTime();
        const existingEpochTime = latestEpochMap.get(satId);

        if (existingEpochTime === undefined) {
          // First time tracking this satellite
          toInsert.push(newData);
          report.updatedCount++;
          report.updatedSatelliteIds.push(satId);
        } else {
          if (newEpochTime > existingEpochTime) {
            toInsert.push(newData);
            report.updatedCount++;
            report.updatedSatelliteIds.push(satId);
          } else if (newEpochTime === existingEpochTime) {
            report.ignoredCount++;
          } else {
            report.rejectedCount++;
          }
        }
      }

      // 8. Batch Insert
      if (toInsert.length > 0) {
        // Chunk inserts to avoid exceeding PostgreSQL parameter limits
        const chunkSize = 1000;
        for (let i = 0; i < toInsert.length; i += chunkSize) {
          const chunk = toInsert.slice(i, i + chunkSize);
          await db.insert(satelliteOrbitalData)
            .values(chunk)
            .onConflictDoNothing({
              target: [satelliteOrbitalData.satelliteId, satelliteOrbitalData.tleEpoch]
            });
        }
      }

    } catch (err: any) {
      report.errors.push(err.message);
    }

    return report;
  }
}
