import { satellites, groundStations, satelliteOrbitalData } from "../../db/schema";
import type { InferInsertModel } from "drizzle-orm";

export type NewSatellite = InferInsertModel<typeof satellites>;
export type NewGroundStation = InferInsertModel<typeof groundStations>;
export type NewSatelliteOrbitalData = InferInsertModel<typeof satelliteOrbitalData>;

export interface OrbitalDataProvider {
  getSatellites(): Promise<NewSatellite[]>;
  getGroundStations(): Promise<NewGroundStation[]>;
  getOrbitalData(satelliteIds: string[]): Promise<NewSatelliteOrbitalData[]>;
}
