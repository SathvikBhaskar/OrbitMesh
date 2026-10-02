import { TrialSnapshot, LabReservation } from "../impact-types";
import { db } from "../../../db/client";
import {
  reservations,
  missionTasks,
  contactWindows,
  satelliteOrbitalData,
  satellites,
  groundStations,
  schedulerRuns
} from "../../../db/schema";
import { MetaScheduler } from "../../meta-scheduler/meta-scheduler";
import { CandidateService } from "../../scheduler/candidate-service";

export interface RescheduleContext {
  baselineSchedule: LabReservation[];
  invalidatedReservationIds: string[];
  affectedTaskIds: string[];
  snapshot: TrialSnapshot;
}

export class LabDbManager {
  public static async reset() {
    await db.delete(schedulerRuns);
    await db.delete(reservations);
    await db.delete(missionTasks);
    await db.delete(contactWindows);
    await db.delete(satelliteOrbitalData);
    await db.delete(satellites);
    await db.delete(groundStations);
  }

  public static async seedEnvironment(snapshot: TrialSnapshot, initialReservations: LabReservation[], pendingTaskIds: Set<string>) {
    await this.reset();

    // 1. Satellites and Stations
    const uniqueSatIds = new Set<string>();
    const uniqueStnIds = new Set<string>();
    for (const w of snapshot.w1_frozen) {
      uniqueSatIds.add(w.satelliteId);
      uniqueStnIds.add(w.ground_station_id);
    }
    for (const t of snapshot.workload) {
      uniqueSatIds.add(t.satelliteId || t.satellite_id);
    }

    if (uniqueSatIds.size > 0) {
      const satsToInsert = Array.from(uniqueSatIds).map((id, i) => ({
        id,
        noradId: 90000 + i,
        name: `Lab-Sat-${i}`,
        status: "ACTIVE" as const
      }));
      await db.insert(satellites).values(satsToInsert);

      // Orbital data required for foreign keys
      await db.insert(satelliteOrbitalData).values(satsToInsert.map(sat => ({
        satelliteId: sat.id,
        source: "CELESTRAK",
        tleLine1: "1 25544U 98067A   26001.00000000  .00000000  00000-0  00000-0 0  9999",
        tleLine2: "2 25544  51.6400   0.0000 0000000   0.0000   0.0000 15.50000000    00",
        tleEpoch: new Date("2026-01-01T00:00:00Z"),
        receivedAt: new Date()
      })));
    }

    if (uniqueStnIds.size > 0) {
      await db.insert(groundStations).values(Array.from(uniqueStnIds).map((id, i) => ({
        id,
        name: `Lab-Station-${i}`,
        code: `LAB-STN-${i}`,
        latitude: 0,
        longitude: 0,
        minimumElevationDeg: 10,
        status: "AVAILABLE" as const
      })));
    }

    // 2. Windows (W1 frozen)
    const orbitalDataRows = await db.select().from(satelliteOrbitalData);
    const orbitalMap = new Map<string, string>();
    for (const row of orbitalDataRows) {
      orbitalMap.set(row.satelliteId, row.id);
    }

    const windowsToInsert = snapshot.w1_frozen.map(w => ({
      id: w.id,
      satelliteId: w.satelliteId,
      groundStationId: w.ground_station_id,
      orbitalDataId: orbitalMap.get(w.satelliteId)!,
      aos: new Date(w.aos),
      los: new Date(w.los),
      durationSeconds: Math.floor((new Date(w.los).getTime() - new Date(w.aos).getTime()) / 1000),
      maxElevationDeg: 80
    }));

    if (windowsToInsert.length > 0) {
      await db.insert(contactWindows).values(windowsToInsert);
    }

    // 3. Tasks
    const tasksToInsert = snapshot.workload.map(t => ({
      id: t.id,
      satelliteId: t.satelliteId || t.satellite_id,
      name: `Lab-Task-${t.id}`,
      priority: t.priority,
      durationSeconds: Math.floor(t.duration_ms / 1000),
      deadline: new Date(t.deadline),
      createdAt: new Date(t.created_at || t.createdAt || new Date()),
      status: pendingTaskIds.has(t.id) ? ("PENDING" as const) : ("SCHEDULED" as const)
    }));

    if (tasksToInsert.length > 0) {
      await db.insert(missionTasks).values(tasksToInsert);
    }

    // 4. Initial Reservations (Surviving)
    if (initialReservations.length > 0) {
      await db.insert(reservations).values(initialReservations.map(r => ({
        id: r.id,
        missionTaskId: r.task_id || r.missionTaskId,
        contactWindowId: r.contactWindowId || r.contact_window_id || snapshot.w1_frozen[0]?.id || "", // mock if missing
        groundStationId: r.ground_station_id,
        allocatedStart: new Date(r.allocated_start!),
        allocatedEnd: new Date(r.allocated_end!),
        status: "CONFIRMED" as const
      })));
    }
  }
}

export class TargetedRescheduler {
  
  /**
   * Reschedules only the affected tasks. Immutably consumes the snapshot, 
   * seeds a fresh isolated database, and executes the production MetaScheduler.
   */
  public async rescheduleTargeted(context: RescheduleContext): Promise<{ pws: number, tp: number, dmr: number }> {
    const invalidSet = new Set(context.invalidatedReservationIds);
    const affectedSet = new Set(context.affectedTaskIds);

    // 1. Filter out invalidated reservations
    const survivingReservations = context.baselineSchedule.filter(r => !invalidSet.has(r.id));

    // 2. Seed database
    // All tasks in affectedSet become PENDING, others remain SCHEDULED (ignored by MetaScheduler)
    await LabDbManager.seedEnvironment(context.snapshot, survivingReservations, affectedSet);

    // 3. Execute
    const metaScheduler = new MetaScheduler(new CandidateService(), "LAB");
    const result = await metaScheduler.schedulePendingTasks();

    // 4. Retrieve final complete schedule from DB to compute PWS (Priority-Weighted Satisfaction)
    const finalReservations = await db.select().from(reservations);
    const finalTasks = await db.select().from(missionTasks);
    
    return this.computeMetrics(finalTasks, finalReservations);
  }

  /**
   * Complete full reschedule of all tasks against W1.
   * Conceptually represents Wipe-and-Regenerate recovery strategy (S0 is deleted).
   */
  public async rescheduleFull(snapshot: TrialSnapshot): Promise<{ pws: number, tp: number, dmr: number }> {
    const allTaskIds = new Set(snapshot.workload.map(t => t.id));

    // Seed database with NO reservations and ALL tasks as PENDING
    await LabDbManager.seedEnvironment(snapshot, [], allTaskIds);

    const metaScheduler = new MetaScheduler(new CandidateService(), "LAB");
    await metaScheduler.schedulePendingTasks();

    const finalReservations = await db.select().from(reservations);
    const finalTasks = await db.select().from(missionTasks);
    
    return this.computeMetrics(finalTasks, finalReservations);
  }

  /**
   * Complete full schedule of all tasks against W1, where T1 was available from the beginning.
   * Conceptually represents the mathematical Oracle reference (no S0 ever existed).
   */
  public async rescheduleOracle(snapshot: TrialSnapshot): Promise<{ pws: number, tp: number, dmr: number }> {
    const allTaskIds = new Set(snapshot.workload.map(t => t.id));

    // Seed database with NO reservations and ALL tasks as PENDING
    await LabDbManager.seedEnvironment(snapshot, [], allTaskIds);

    const metaScheduler = new MetaScheduler(new CandidateService(), "LAB");
    await metaScheduler.schedulePendingTasks();

    const finalReservations = await db.select().from(reservations);
    const finalTasks = await db.select().from(missionTasks);
    
    return this.computeMetrics(finalTasks, finalReservations);
  }

  private computeMetrics(tasks: any[], res: any[]): { pws: number, tp: number, dmr: number } {
    const scheduledTaskIds = new Set(res.map(r => r.missionTaskId));
    let pws = 0;
    const tp = scheduledTaskIds.size;
    const dmr = tasks.length > 0 ? (tasks.length - tp) / tasks.length : 0;
    
    for (const t of tasks) {
      if (scheduledTaskIds.has(t.id)) {
        pws += t.priority;
      }
    }
    return { pws, tp, dmr };
  }
}
