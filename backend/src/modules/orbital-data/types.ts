export interface OrbitalData {
  noradId: number;
  satelliteName: string;
  tleLine1: string;
  tleLine2: string;
  tleEpoch: Date;
  source: "CELESTRAK";
}

export interface OrbitalDataProvider {
  getByNoradId(noradId: number): Promise<OrbitalData>;
}
