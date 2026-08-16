import crypto from "crypto";
import { db } from "../../db/client";
import {
  reservations,
  missionTasks,
  contactWindows,
  satelliteOrbitalData,
  satellites,
  groundStations,
  schedulerRuns
} from "../../db/schema";
import { eq, asc } from "drizzle-orm";
import { WorkloadConfig, MetricResults, LabTaskOutcome } from "./types";
import { WorkloadGenerator, GeneratedWorkload } from "./workload-generator";
import { calculateMetrics } from "./metrics";
import { CandidateService } from "../scheduler/candidate-service";
import { FcfsScheduler } from "../scheduler/fcfs-scheduler";
import { PriorityScheduler } from "../scheduler/priority-scheduler";

export function generateWorkloadFingerprint(tasks: any[]): string {
  // Sort tasks deterministically by ID
  const sortedTasks = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
  const payload = JSON.stringify(sortedTasks.map(t => ({
    id: t.id,
    priority: t.priority,
    duration: t.durationSeconds,
    deadline: t.deadline.toISOString(),
    createdAt: t.createdAt.toISOString()
  })));
  return crypto.createHash("sha256").update(payload).digest("hex");
}

import { HybridScheduler } from "../scheduler/hybrid-scheduler";
import { HybridStrategy } from "../scheduler/hybrid-policy";
import { MetaScheduler } from "../meta-scheduler/meta-scheduler";

export async function resetLabDatabase() {
  // Respect dependency order for deletes
  await db.delete(schedulerRuns);
  await db.delete(reservations);
  await db.delete(missionTasks);
  await db.delete(contactWindows);
  await db.delete(satelliteOrbitalData);
  await db.delete(satellites);
  await db.delete(groundStations);
}

export async function seedLabDatabase(workload: GeneratedWorkload) {
  if (workload.satellites.length > 0) {
    await db.insert(satellites).values(workload.satellites.map(sat => ({
      ...sat,
      status: "ACTIVE" as const
    })));
  }
  if (workload.stations.length > 0) {
    await db.insert(groundStations).values(workload.stations.map((stn, index) => ({
      ...stn,
      code: `LAB-STN-${index}`,
      latitude: 0,
      longitude: 0,
      minimumElevationDeg: 10,
      status: "AVAILABLE" as const
    })));
  }
  
  // Create orbital data mock for foreign keys
  for (const sat of workload.satellites) {
    await db.insert(satelliteOrbitalData).values({
      satelliteId: sat.id,
      source: "CELESTRAK",
      tleLine1: "1 25544U 98067A   26001.00000000  .00000000  00000-0  00000-0 0  9999",
      tleLine2: "2 25544  51.6400   0.0000 0000000   0.0000   0.0000 15.50000000    00",
      tleEpoch: new Date("2026-01-01T00:00:00Z"),
      receivedAt: new Date()
    });
  }

  // Insert windows. They need orbitalDataId. We'll fetch the one we just inserted.
  const orbitalDataRows = await db.select().from(satelliteOrbitalData);
  const orbitalMap = new Map<string, string>();
  for (const row of orbitalDataRows) {
    orbitalMap.set(row.satelliteId, row.id);
  }

  const windowsToInsert = workload.windows.map(w => ({
    id: w.id,
    satelliteId: w.satelliteId,
    groundStationId: w.groundStationId,
    orbitalDataId: orbitalMap.get(w.satelliteId)!,
    aos: w.aos,
    los: w.los,
    durationSeconds: w.durationSeconds,
    maxElevationDeg: 80
  }));

  if (windowsToInsert.length > 0) {
    // SQLite/PG max parameters limit batch size, so insert in chunks if large
    const chunkSize = 1000;
    for (let i = 0; i < windowsToInsert.length; i += chunkSize) {
      await db.insert(contactWindows).values(windowsToInsert.slice(i, i + chunkSize));
    }
  }

  const tasksToInsert = workload.tasks.map(t => ({
    id: t.id,
    satelliteId: t.satelliteId,
    name: `Lab-Task-${t.id}`,
    priority: t.priority,
    durationSeconds: t.durationSeconds,
    deadline: t.deadline,
    createdAt: t.createdAt,
    status: "PENDING" as const
  }));

  if (tasksToInsert.length > 0) {
    const chunkSize = 1000;
    for (let i = 0; i < tasksToInsert.length; i += chunkSize) {
      await db.insert(missionTasks).values(tasksToInsert.slice(i, i + chunkSize));
    }
  }
}

export async function runPolicyExperiment(
  policyType: "FCFS" | "PRIORITY" | "HYBRID_SLACK" | "HYBRID_RATIO" | "META",
  configOrWorkload: WorkloadConfig | GeneratedWorkload
) {
  await resetLabDatabase();
  
  // If it has 'tasks', it's a GeneratedWorkload, else it's a WorkloadConfig
  const workload = 'tasks' in configOrWorkload 
    ? configOrWorkload 
    : new WorkloadGenerator(configOrWorkload).generate();
    
  await seedLabDatabase(workload);
  const fingerprint = generateWorkloadFingerprint(workload.tasks);

  const candidateService = new CandidateService();
  let scheduler: any;
  let metaDecision: any = null;

  if (policyType === "FCFS") {
    scheduler = new FcfsScheduler(candidateService);
  } else if (policyType === "PRIORITY") {
    scheduler = new PriorityScheduler(candidateService);
  } else if (policyType === "HYBRID_SLACK") {
    scheduler = new HybridScheduler(candidateService, "SLACK", workload.referenceTime);
  } else if (policyType === "HYBRID_RATIO") {
    scheduler = new HybridScheduler(candidateService, "URGENCY_RATIO", workload.referenceTime);
  } else if (policyType === "META") {
    const { MetaScheduler } = require("../meta-scheduler/meta-scheduler");
    scheduler = new MetaScheduler(candidateService, "LAB");
  } else {
    throw new Error(`Unknown policy: ${policyType}`);
  }

  const results = await scheduler.schedulePendingTasks ? await scheduler.schedulePendingTasks() : await scheduler.schedule();
  
  if (policyType === "META") {
    metaDecision = scheduler.getDecision();
  }

  // Collect State
  const dbTasks = await db.select().from(missionTasks).orderBy(asc(missionTasks.createdAt));
  const dbWindows = await db.select().from(contactWindows);
  const dbReservations = await db.select().from(reservations);

  const labTasks = dbTasks.map(t => ({ id: t.id, createdAt: t.createdAt, priority: t.priority }));
  const labWindows = dbWindows.map(w => ({ id: w.id, groundStationId: w.groundStationId, aos: w.aos, los: w.los, durationSeconds: w.durationSeconds }));
  const labReservations = dbReservations.map(r => ({
    missionTaskId: r.missionTaskId,
    contactWindowId: r.contactWindowId,
    groundStationId: r.groundStationId,
    allocatedStart: r.allocatedStart,
    allocatedEnd: r.allocatedEnd
  }));

  // Typecast outcomes to LabTaskOutcome
  const outcomes = results.results as LabTaskOutcome[];

  // Calculate Metrics
  const metrics = calculateMetrics(labTasks, labReservations, labWindows, outcomes);
  return { metrics, fingerprint, metaDecision };
}
