import { db } from "../../../db/client";
import { satellites, satelliteOrbitalData } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { CelestrakProvider } from "../providers/celestrak-provider";
import { validateTle } from "../validator";
import { OrbitalDataProvider } from "../types";

export class OrbitalDataService {
  private provider: OrbitalDataProvider;

  constructor() {
    this.provider = new CelestrakProvider();
  }

  async refreshOrbitalData(satelliteId: string) {
    // Lookup satellite to get NORAD ID
    const satList = await db.select().from(satellites).where(eq(satellites.id, satelliteId));
    if (satList.length === 0) {
      throw new Error(`Satellite with ID ${satelliteId} not found`);
    }
    const sat = satList[0]!;

    // Fetch from provider (if provider fails, it throws application error, preserving old records)
    const orbitalData = await this.provider.getByNoradId(sat.noradId);

    // Validate the received TLE data against the expected NORAD ID
    validateTle(orbitalData.tleLine1, orbitalData.tleLine2, sat.noradId);

    // Persist as a new historical record, do not overwrite old ones
    const result = await db.insert(satelliteOrbitalData).values({
      satelliteId: sat.id,
      source: orbitalData.source,
      tleLine1: orbitalData.tleLine1,
      tleLine2: orbitalData.tleLine2,
      tleEpoch: orbitalData.tleEpoch,
      receivedAt: new Date()
    }).returning();

    return result[0];
  }
}
