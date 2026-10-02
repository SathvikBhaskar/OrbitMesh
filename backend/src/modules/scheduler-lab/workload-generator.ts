import seedrandom from "seedrandom";
import { WorkloadConfig } from "./types";
import { calculateFeatures } from "../meta-scheduler/workload-analyzer";
import { Task, ContactWindow } from "../meta-scheduler/types";
import { LoadRegion } from "./impact-types";

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
  duration_ms: number; // for analyzer compatibility
  deadline: Date;
  windowId?: string | null;
  status?: string;
  createdAt?: Date;
}

export interface GeneratedWorkload {
  seed: string;
  referenceTime: Date;
  satellites: { id: string; noradId: number; name: string }[];
  stations: { id: string; name: string }[];
  windows: GeneratedWindow[];
  tasks: GeneratedTask[];
}

export interface BoundedRegion {
  loadPressure: [number, number];
  highPriorityFraction: [number, number];
  p10DeadlinePressure?: [number, number];
}

export interface GenerationHistory {
  seed: string;
  attempts: number;
  targetRegion: string | BoundedRegion;
  realizedLoadPressure: number;
  realizedHPF: number;
  realizedP10DeadlinePressure: number;
}

export class BoundedWorkloadGenerationError extends Error {
  history?: GenerationHistory;
  constructor(message: string, history?: GenerationHistory) {
    super(message);
    this.name = "BoundedWorkloadGenerationError";
    this.history = history;
  }
}

export class WorkloadGenerator {
  private rng: seedrandom.PRNG;

  constructor(private config: WorkloadConfig) {
    this.rng = seedrandom(config.seed);
  }

  private generateId(): string {
    const hex = "0123456789abcdef";
    let s = "";
    for (let i = 0; i < 32; i++) {
      s += hex[Math.floor(this.rng() * 16)];
    }
    return `${s.substring(0,8)}-${s.substring(8,12)}-4${s.substring(13,16)}-a${s.substring(17,20)}-${s.substring(20,32)}`;
  }

  private randInt(min: number, max: number): number {
    return Math.floor(this.rng() * (max - min + 1)) + min;
  }

  private isFractionFeasible(band: [number, number], total: number): boolean {
    for (let i = 0; i <= total; i++) {
      const frac = i / total;
      if (frac >= band[0] && frac <= band[1]) return true;
    }
    return false;
  }

  /**
   * Generates a workload that is guaranteed to land in the target boundary region.
   * Throws BoundedWorkloadGenerationError if impossible.
   */
  public generateBoundedWorkload(region: BoundedRegion, providedWindows?: GeneratedWindow[]): { workload: GeneratedWorkload, history: GenerationHistory } {
    // 1. Deterministic feasibility check for HPF
    if (!this.isFractionFeasible(region.highPriorityFraction, this.config.taskCount)) {
      throw new BoundedWorkloadGenerationError(`Impossible HPF band [${region.highPriorityFraction[0]}, ${region.highPriorityFraction[1]}] for N=${this.config.taskCount}`);
    }

    const MAX_ATTEMPTS = 500;
    
    let base = this.generateTopology();
    if (providedWindows && providedWindows.length > 0) {
      // The provided windows belong to the physically updated satellite.
      const updatedSatId = providedWindows[0].satelliteId;
      
      // Ensure the updated satellite is in the topology
      if (!base.satellites.find(s => s.id === updatedSatId)) {
        // Replace the first background satellite with the updated one
        base.satellites[0].id = updatedSatId;
        base.satellites[0].name = `Real-Updated-Sat`;
      }

      // Remove any synthetic windows for this specific satellite, and inject the provided ones
      base.windows = base.windows.filter(w => w.satelliteId !== updatedSatId);
      base.windows.push(...providedWindows);
      base.windows.sort((a, b) => a.aos.getTime() - b.aos.getTime());
    }

    const cw: ContactWindow[] = base.windows.map((w: any) => ({
      id: w.id,
      ground_station_id: w.groundStationId,
      aos: w.aos,
      los: w.los,
      satelliteId: w.satelliteId
    }));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Use attempt as salt for the task PRNG to explore space deterministically
      this.rng = seedrandom(`${this.config.seed}_attempt_${attempt}`);
      
      const tasks = this.generateTasks(base.satellites);
      const metaTasks: Task[] = tasks.map(t => ({
        id: t.id,
        duration_ms: t.duration_ms,
        priority: t.priority,
        deadline: t.deadline,
        satelliteId: t.satelliteId
      }));

      // Analyze against empty reservations
      const features = calculateFeatures(metaTasks, cw, [], this.config.referenceTime || new Date());

      // Measure
      const hpfOk = features.highPriorityFraction >= region.highPriorityFraction[0] && features.highPriorityFraction <= region.highPriorityFraction[1];
      const lpOk = features.loadPressure >= region.loadPressure[0] && features.loadPressure <= region.loadPressure[1];
      let p10Ok = true;
      if (region.p10DeadlinePressure) {
        p10Ok = features.p10DeadlinePressure >= region.p10DeadlinePressure[0] && features.p10DeadlinePressure <= region.p10DeadlinePressure[1];
      }

      if (hpfOk && lpOk && p10Ok) {
        // We found a valid workload. 
        // We ensure the exact seed used for this successful attempt is returned
        return {
          workload: {
            seed: `${this.config.seed}_attempt_${attempt}`,
            referenceTime: this.config.referenceTime || new Date(),
            satellites: base.satellites,
            stations: base.stations,
            windows: base.windows,
            tasks
          },
          history: {
            seed: `${this.config.seed}_attempt_${attempt}`,
            attempts: attempt,
            targetRegion: region,
            realizedLoadPressure: features.loadPressure,
            realizedHPF: features.highPriorityFraction,
            realizedP10DeadlinePressure: features.p10DeadlinePressure
          }
        };
      }

      // Repair heuristics (we can bias the distribution ranges in config for the next attempt based on the distance)
      if (!lpOk) {
        if (features.loadPressure < region.loadPressure[0]) {
          // Increase load (make tasks longer)
          if (this.config.durationDistribution === 'SHORT') this.config.durationDistribution = 'MIXED';
          else if (this.config.durationDistribution === 'MIXED') this.config.durationDistribution = 'LONG';
        } else {
          // Decrease load
          if (this.config.durationDistribution === 'LONG') this.config.durationDistribution = 'MIXED';
          else if (this.config.durationDistribution === 'MIXED') this.config.durationDistribution = 'SHORT';
        }
      }

      if (!hpfOk) {
        if (features.highPriorityFraction < region.highPriorityFraction[0]) {
          this.config.priorityDistribution = 'HIGH_HEAVY';
        } else {
          this.config.priorityDistribution = 'LOW_HEAVY';
        }
      }
    }

    throw new BoundedWorkloadGenerationError(`Failed to generate bounded workload within ${MAX_ATTEMPTS} attempts.`);
  }

  private generateTopology() {
    // We isolate topology generation PRNG
    this.rng = seedrandom(`${this.config.seed}_topology`);
    const satellites: GeneratedSatellite[] = [];
    const stations: GeneratedStation[] = [];
    const windows: GeneratedWindow[] = [];

    for (let i = 0; i < this.config.satelliteCount; i++) {
      satellites.push({ id: this.generateId(), noradId: 90000 + i, name: `Lab-Sat-${i}` });
    }
    for (let i = 0; i < this.config.stationCount; i++) {
      stations.push({ id: this.generateId(), name: `Lab-Station-${i}` });
    }

    const baseDate = (this.config.referenceTime || new Date("2026-08-16T00:00:00Z")).getTime();
    for (const sat of satellites) {
      for (const stn of stations) {
        const offsetMinutes = this.randInt(0, 45); 
        for (let orbit = 0; orbit < 16; orbit++) {
          if (this.rng() < 0.3) continue;
          const startOffsetMs = (orbit * 90 * 60 * 1000) + (offsetMinutes * 60 * 1000);
          const durationSeconds = this.randInt(400, 800);
          const jitterMs = this.randInt(-120, 120) * 1000;
          const aos = new Date(baseDate + startOffsetMs + jitterMs);
          const los = new Date(aos.getTime() + durationSeconds * 1000);
          windows.push({ id: this.generateId(), satelliteId: sat.id, groundStationId: stn.id, aos, los, durationSeconds });
        }
      }
    }
    windows.sort((a, b) => a.aos.getTime() - b.aos.getTime());
    return { satellites, stations, windows };
  }

  private generateTasks(satellites: GeneratedSatellite[]): GeneratedTask[] {
    const tasks: GeneratedTask[] = [];
    const baseDate = (this.config.referenceTime || new Date("2026-08-16T00:00:00Z")).getTime();

    for (let i = 0; i < this.config.taskCount; i++) {
      const sat = satellites[this.randInt(0, satellites.length - 1)]!;
      let durationSeconds = 60;
      if (this.config.durationDistribution === 'SHORT') durationSeconds = this.randInt(30, 120);
      else if (this.config.durationDistribution === 'MIXED') durationSeconds = this.randInt(60, 600);
      else if (this.config.durationDistribution === 'LONG') durationSeconds = this.randInt(300, 1200);

      let priority = 1;
      const prioRoll = this.rng();
      if (this.config.priorityDistribution === 'BALANCED') priority = this.randInt(1, 10);
      else if (this.config.priorityDistribution === 'HIGH_HEAVY') priority = prioRoll < 0.6 ? this.randInt(8, 10) : this.randInt(1, 7);
      else if (this.config.priorityDistribution === 'LOW_HEAVY') priority = prioRoll < 0.6 ? this.randInt(1, 3) : this.randInt(4, 10);
      
      const arrivalOffsetMs = this.randInt(0, this.config.arrivalSpreadSeconds || 3600) * 1000;
      const createdAt = new Date(baseDate + arrivalOffsetMs);

      let deadlineMinOffsetSeconds = 3600;
      let deadlineMaxOffsetSeconds = 14400;
      if (this.config.deadlineRegime === 'TIGHT') { deadlineMaxOffsetSeconds = 14400; }
      else if (this.config.deadlineRegime === 'MEDIUM') { deadlineMinOffsetSeconds = 14400; deadlineMaxOffsetSeconds = 43200; }
      else if (this.config.deadlineRegime === 'LOOSE') { deadlineMinOffsetSeconds = 43200; deadlineMaxOffsetSeconds = 86400; }

      const deadlineOffsetSeconds = this.randInt(deadlineMinOffsetSeconds, deadlineMaxOffsetSeconds);
      const deadline = new Date(createdAt.getTime() + deadlineOffsetSeconds * 1000);

      tasks.push({
        id: this.generateId(),
        satelliteId: sat.id,
        priority,
        durationSeconds,
        duration_ms: durationSeconds * 1000,
        deadline,
        createdAt
      });
    }

    tasks.sort((a, b) => (a.createdAt?.getTime() || 0) - (b.createdAt?.getTime() || 0));
    return tasks;
  }
}
