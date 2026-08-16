import { db } from "../../db/client";
import { satelliteOrbitalData } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import { propagateOrbit } from "./propagator";
import { PositionVelocity } from "./types";

export class PositionService {
  async getPosition(satelliteId: string, timestamp: Date): Promise<PositionVelocity> {
    const historicalData = await db
      .select()
      .from(satelliteOrbitalData)
      .where(eq(satelliteOrbitalData.satelliteId, satelliteId))
      .orderBy(desc(satelliteOrbitalData.receivedAt))
      .limit(1);

    if (historicalData.length === 0) {
      throw new Error(`No orbital data found for satellite ${satelliteId}`);
    }

    const tle = historicalData[0]!;
    return propagateOrbit(tle.tleLine1, tle.tleLine2, timestamp);
  }
}
