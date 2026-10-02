import seedrandom from "seedrandom";
import { OrbitalDataProvider, NewSatellite, NewGroundStation, NewSatelliteOrbitalData } from "./orbital-data-provider";
import { MissionTaskProvider, NewMissionTask } from "./mission-task-provider";

export class DemoOrbitalDataProvider implements OrbitalDataProvider {
  private rng: seedrandom.PRNG;

  constructor(seed: number) {
    this.rng = seedrandom(seed.toString());
  }

  async getSatellites(): Promise<NewSatellite[]> {
    const satConfigs = [
      { noradId: 25544, name: "ISS" },
      { noradId: 27424, name: "AQUA" },
      { noradId: 25994, name: "TERRA" },
      { noradId: 39084, name: "LANDSAT 8" },
      { noradId: 43013, name: "NOAA 20" },
      { noradId: 33591, name: "NOAA 19" },
      { noradId: 40069, name: "METOP-B" },
      { noradId: 28654, name: "NOAA 18" },
    ];
    
    return satConfigs.map(s => ({
      ...s,
      status: "ACTIVE" as const
    }));
  }

  async getGroundStations(): Promise<NewGroundStation[]> {
    const stationConfigs = [
      { code: "SVAL", name: "Svalbard Satellite Station", latitude: 78.2297, longitude: 15.4077 },
      { code: "MCM", name: "McMurdo Ground Station", latitude: -77.8463, longitude: 166.6682 },
      { code: "WAL", name: "Wallops Command and Data", latitude: 37.9401, longitude: -75.4663 },
      { code: "FBK", name: "Fairbanks Command and Data", latitude: 64.9774, longitude: -147.5104 },
    ];

    return stationConfigs.map(s => ({
      ...s,
      minimumElevationDeg: 10,
      status: "AVAILABLE" as const
    }));
  }

  async getOrbitalData(satelliteIds: string[]): Promise<NewSatelliteOrbitalData[]> {
    const data: NewSatelliteOrbitalData[] = [];
    
    // We just need deterministic TLEs. To map noradId, we would normally pass the satellites array.
    // In demo, we just assign dummy TLEs based on the iteration order which is deterministic,
    // or we can pass a dummy NORAD ID since seed.ts was generating them purely based on order.
    // But since `getOrbitalData` takes satelliteIds, we'll iterate.
    let noradIdBase = 90000;
    
    for (const satId of satelliteIds) {
      const dummyNoradId = noradIdBase++;
      data.push({
        satelliteId: satId,
        source: "CELESTRAK" as const,
        tleLine1: `1 ${String(dummyNoradId).padEnd(5, ' ')}U 98067A   26001.00000000  .00000000  00000-0  00000-0 0  9999`,
        tleLine2: `2 ${String(dummyNoradId).padEnd(5, ' ')}  51.6400 ${Math.floor(this.rng() * 360).toFixed(4).padStart(8, ' ')} 0000000   0.0000   0.0000 15.50000000    00`,
        tleEpoch: new Date("2026-01-01T00:00:00Z"),
        receivedAt: new Date()
      });
    }
    return data;
  }
}

export class DemoMissionTaskProvider implements MissionTaskProvider {
  private rng: seedrandom.PRNG;

  constructor(seed: number) {
    this.rng = seedrandom(seed.toString());
  }

  async getMissionTasks(satelliteIds: string[], referenceTime: Date): Promise<NewMissionTask[]> {
    const tasksToInsert: NewMissionTask[] = [];
    
    // Exact logic from seed.ts
    // The rng here will NOT be in the same state as seed.ts unless the sequence of calls matches.
    // In seed.ts, rng was used for TLEs, and THEN for tasks.
    // If we want PERFECT deterministic parity (the EXACT same values as before), 
    // we need to either share the PRNG, or fast-forward it.
    // Actually, in seed.ts, rng() was called 8 times for TLEs, then 50 times (x3 per loop) for tasks.
    // Let's preserve that parity strictly! 
    
    // Fast forward RNG by 8 to skip the TLE generation calls, assuming exactly 8 satellites
    // OR we just use a single shared PRNG, but since they are in different classes,
    // let's just make DemoMissionTaskProvider take the RNG, or we initialize it and fast-forward.
    
    // In seed.ts: 
    // for (const sat of sats) { ... rng() ... } -> exactly 8 calls
    for (let i = 0; i < satelliteIds.length; i++) {
      this.rng(); 
    }

    for (let i = 1; i <= 50; i++) {
      const sat = satelliteIds[Math.floor(this.rng() * satelliteIds.length)];
      if (!sat) continue;
      
      const priority = Math.floor(this.rng() * 10) + 1;
      const duration = 60 + Math.floor(this.rng() * 540);
      const deadlineOffsetMs = (2 + this.rng() * 22) * 60 * 60 * 1000;
      const deadline = new Date(referenceTime.getTime() + deadlineOffsetMs);
      
      tasksToInsert.push({
        satelliteId: sat,
        name: `Observation Task ${String(i).padStart(3, '0')}`,
        priority,
        durationSeconds: duration,
        deadline,
        status: "PENDING" as const
      });
    }

    return tasksToInsert;
  }
}
