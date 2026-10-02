import { ContactWindowService } from "./contact-window-service";
import { db } from "../../db/client";
import { contactWindows, satelliteOrbitalData, groundStations } from "../../db/schema";
import { inArray, sql, desc, eq } from "drizzle-orm";

export class IncrementalContactWindowService {
  constructor(private contactWindowService: ContactWindowService) {}

  public async regenerateForSatellites(
    satelliteIds: string[],
    referenceTime: Date,
    horizonHours: number,
    telemetry?: any
  ): Promise<number> {
    if (satelliteIds.length === 0) {
      return 0;
    }

    const stations = await db.select().from(groundStations).where(eq(groundStations.status, "AVAILABLE"));

    if (stations.length === 0) {
      return 0;
    }

    const start = referenceTime;
    const end = new Date(start.getTime() + horizonHours * 3600 * 1000);

    let totalRegenerated = 0;

    for (const satId of satelliteIds) {
      // Find the physical snapshot we are generating for
      const latestSnapshot = await db
        .select()
        .from(satelliteOrbitalData)
        .where(eq(satelliteOrbitalData.satelliteId, satId))
        .orderBy(desc(satelliteOrbitalData.tleEpoch))
        .limit(1);

      if (latestSnapshot.length === 0) {
        continue;
      }
      const snapshot = latestSnapshot[0]!;

      for (const station of stations) {
        // use the underlying physics/refinement engine
        const result = await this.contactWindowService.generateContactWindows(
          satId,
          station.id,
          start,
          end,
          10,
          telemetry
        );

        totalRegenerated += result.windows.length;
      }
    }

    return totalRegenerated;
  }
}
