import seedrandom from "seedrandom";
import { WorkloadConfig } from "./types";

export interface GeneratedSatellite {
  id: string;
  noradId: number;
  name: string;
}

export interface GeneratedStation {
  id: string;
  name: string;
}

export interface GeneratedWindow {
  id: string;
  satelliteId: string;
  groundStationId: string;
  aos: Date;
  los: Date;
  durationSeconds: number;
}

export interface GeneratedTask {
  id: string;
  satelliteId: string;
  priority: number;
  durationSeconds: number;
  deadline: Date;
  windowId?: string | null;
  status?: string;
  createdAt?: Date;
}

export interface GeneratedWorkload {
  seed?: string;
  referenceTime?: Date;
  satellites: { id: string; noradId: number; name: string }[];
  stations: { id: string; name: string }[];
  windows: any;
  tasks: GeneratedTask[];
}

export class WorkloadGenerator {
  private rng: seedrandom.PRNG;

  constructor(private config: WorkloadConfig) {
    this.rng = seedrandom(config.seed);
  }

  // Deterministic UUID based on PRNG
  private generateId(): string {
    const hex = "0123456789abcdef";
    let s = "";
    for (let i = 0; i < 32; i++) {
      s += hex[Math.floor(this.rng() * 16)];
    }
    return `${s.substring(0,8)}-${s.substring(8,12)}-4${s.substring(13,16)}-a${s.substring(17,20)}-${s.substring(20,32)}`;
  }

  // Integer between min and max (inclusive)
  private randInt(min: number, max: number): number {
    return Math.floor(this.rng() * (max - min + 1)) + min;
  }

  public generate(): GeneratedWorkload {
    const satellites: GeneratedSatellite[] = [];
    const stations: GeneratedStation[] = [];
    const windows: GeneratedWindow[] = [];
    const tasks: GeneratedTask[] = [];

    // 1. Generate Satellites
    for (let i = 0; i < this.config.satelliteCount; i++) {
      satellites.push({
        id: this.generateId(),
        noradId: 90000 + i,
        name: `Lab-Sat-${i}`
      });
    }

    // 2. Generate Stations
    for (let i = 0; i < this.config.stationCount; i++) {
      stations.push({
        id: this.generateId(),
        name: `Lab-Station-${i}`
      });
    }

    // 3. Generate Windows (Realistic Fixture Pattern)
    // We simulate an orbit with ~90 minute period. Visible for ~10 mins per pass.
    // For 24 hours, that's about 15 orbits. We randomly drop some to simulate non-overhead passes.
    const baseDate = new Date("2026-08-16T00:00:00Z").getTime();
    
    for (const sat of satellites) {
      for (const stn of stations) {
        // Offset each sat/stn pair so they don't all align perfectly
        const offsetMinutes = this.randInt(0, 45); 
        
        for (let orbit = 0; orbit < 16; orbit++) {
          // 30% chance this orbit doesn't pass over this station
          if (this.rng() < 0.3) continue;

          const startOffsetMs = (orbit * 90 * 60 * 1000) + (offsetMinutes * 60 * 1000);
          const durationSeconds = this.randInt(400, 800); // 6-13 minutes
          
          // Introduce a bit of jitter
          const jitterMs = this.randInt(-120, 120) * 1000;
          
          const aos = new Date(baseDate + startOffsetMs + jitterMs);
          const los = new Date(aos.getTime() + durationSeconds * 1000);

          windows.push({
            id: this.generateId(),
            satelliteId: sat.id,
            groundStationId: stn.id,
            aos,
            los,
            durationSeconds
          });
        }
      }
    }

    // Sort windows by AOS for consistency
    windows.sort((a, b) => a.aos.getTime() - b.aos.getTime());

    // 4. Generate Tasks
    for (let i = 0; i < this.config.taskCount; i++) {
      const sat = satellites[this.randInt(0, satellites.length - 1)]!;
      
      let durationSeconds = 60;
      if (this.config.durationDistribution === 'SHORT') {
        durationSeconds = this.randInt(30, 120);
      } else if (this.config.durationDistribution === 'MIXED') {
        durationSeconds = this.randInt(60, 600);
      } else if (this.config.durationDistribution === 'LONG') {
        durationSeconds = this.randInt(300, 1200);
      }

      let priority = 1;
      const prioRoll = this.rng();
      if (this.config.priorityDistribution === 'BALANCED') {
        priority = this.randInt(1, 10);
      } else if (this.config.priorityDistribution === 'HIGH_HEAVY') {
        priority = prioRoll < 0.6 ? this.randInt(8, 10) : this.randInt(1, 7);
      } else if (this.config.priorityDistribution === 'LOW_HEAVY') {
        priority = prioRoll < 0.6 ? this.randInt(1, 3) : this.randInt(4, 10);
      }
      
      // createdAt varies uniformly from baseDate to baseDate + arrivalSpreadSeconds
      const arrivalOffsetMs = this.randInt(0, this.config.arrivalSpreadSeconds) * 1000;
      const createdAt = new Date(baseDate + arrivalOffsetMs);

      // deadline is offset from createdAt
      let deadlineMinOffsetSeconds = 3600;
      let deadlineMaxOffsetSeconds = 14400;
      
      if (this.config.deadlineRegime === 'TIGHT') {
        deadlineMinOffsetSeconds = 3600;
        deadlineMaxOffsetSeconds = 14400; // 1-4 hours
      } else if (this.config.deadlineRegime === 'MEDIUM') {
        deadlineMinOffsetSeconds = 14400;
        deadlineMaxOffsetSeconds = 43200; // 4-12 hours
      } else if (this.config.deadlineRegime === 'LOOSE') {
        deadlineMinOffsetSeconds = 43200;
        deadlineMaxOffsetSeconds = 86400; // 12-24 hours
      }

      const deadlineOffsetSeconds = this.randInt(deadlineMinOffsetSeconds, deadlineMaxOffsetSeconds);
      const deadline = new Date(createdAt.getTime() + deadlineOffsetSeconds * 1000);

      tasks.push({
        id: this.generateId(),
        satelliteId: sat.id,
        priority,
        durationSeconds,
        deadline,
        createdAt
      });
    }

    // Sort tasks by created_at to simulate chronological arrival
    tasks.sort((a, b) => (a.createdAt?.getTime() || 0) - (b.createdAt?.getTime() || 0));

    return { seed: this.config.seed, referenceTime: this.config.referenceTime, satellites, stations, windows, tasks };
  }
}
