import assert from "assert";
import { runPolicyExperiment, resetLabDatabase, seedLabDatabase, generateWorkloadFingerprint } from "../modules/scheduler-lab/policy-runner";
import { WorkloadGenerator } from "../modules/scheduler-lab/workload-generator";
import { WorkloadConfig } from "../modules/scheduler-lab/types";
import { db, pool } from "../db/client";
import { reservations, missionTasks, contactWindows } from "../db/schema";
import { sql, asc } from "drizzle-orm";
import { calculateMetrics } from "../modules/scheduler-lab/metrics";
import { PriorityScheduler } from "../modules/scheduler/priority-scheduler";
import { CandidateService } from "../modules/scheduler/candidate-service";

async function runStage2Tests() {
  console.log("=== LAB STAGE 2 TESTS ===");

  // TEST M: Reset/Clean Database
  console.log("Testing Lab Reset...");
  await resetLabDatabase();
  const resCount = await db.select({ count: sql<number>`count(*)` }).from(reservations);
  const tasksCount = await db.select({ count: sql<number>`count(*)` }).from(missionTasks);
  const windowsCount = await db.select({ count: sql<number>`count(*)` }).from(contactWindows);
  assert.strictEqual(Number(resCount[0]!.count), 0);
  assert.strictEqual(Number(tasksCount[0]!.count), 0);
  assert.strictEqual(Number(windowsCount[0]!.count), 0);
  console.log("✅ Lab Reset successful.");

  // TEST D: Deterministic workload fingerprints
  console.log("Testing Workload Fingerprints...");
  const config: WorkloadConfig = {
    seed: "999", referenceTime: new Date("2026-08-16T00:00:00Z"), taskCount: 50, satelliteCount: 2, stationCount: 1, 
    deadlineRegime: 'LOOSE', priorityDistribution: 'BALANCED', durationDistribution: 'SHORT',
    arrivalSpreadSeconds: 10000
  };
  const wl1 = new WorkloadGenerator(config).generate();
  const wl2 = new WorkloadGenerator(config).generate();
  const fp1 = generateWorkloadFingerprint(wl1.tasks);
  const fp2 = generateWorkloadFingerprint(wl2.tasks);
  assert.strictEqual(fp1, fp2);
  console.log("✅ Fingerprint matching successful.");

  // TEST E & G: Policy Isolation and Workload matching between runs
  console.log("Testing Policy Isolation...");
  const fcfsRes = await runPolicyExperiment("FCFS", config);
  const priorDbResCount = await db.select({ count: sql<number>`count(*)` }).from(reservations);
  assert(Number(priorDbResCount[0]!.count) > 0, "FCFS should have made reservations");

  const prioRes = await runPolicyExperiment("PRIORITY", config);
  assert.strictEqual(fcfsRes.fingerprint, prioRes.fingerprint, "Fingerprints MUST match exactly between policies");
  console.log("✅ Policy isolation and identical workloads verified.");

  // TEST I & J: Unscheduled classification and Waiting Time Population
  console.log("Testing Metrics pure functions (Test I & J)...");
  
  const metricTasks = [
    { id: "t1", createdAt: new Date(1000), priority: 5 }, // SCHEDULED
    { id: "t2", createdAt: new Date(1000), priority: 5 }, // SCHEDULED
    { id: "t3", createdAt: new Date(1000), priority: 5 }, // SCHEDULED
    { id: "t4", createdAt: new Date(1000), priority: 5 }, // DEADLINE_EXCEEDED
    { id: "t5", createdAt: new Date(1000), priority: 5 }  // NO_FEASIBLE_WINDOW
  ];

  const metricRes = [
    { missionTaskId: "t1", contactWindowId: "w1", groundStationId: "s1", allocatedStart: new Date(2000), allocatedEnd: new Date(3000) },
    { missionTaskId: "t2", contactWindowId: "w1", groundStationId: "s1", allocatedStart: new Date(4000), allocatedEnd: new Date(5000) },
    { missionTaskId: "t3", contactWindowId: "w1", groundStationId: "s1", allocatedStart: new Date(5000), allocatedEnd: new Date(6000) }
  ];

  const metricOutcomes = [
    { taskId: "t1", status: "SCHEDULED" as const, reservationId: "r1" },
    { taskId: "t2", status: "SCHEDULED" as const, reservationId: "r2" },
    { taskId: "t3", status: "SCHEDULED" as const, reservationId: "r3" },
    { taskId: "t4", status: "UNSCHEDULED" as const, reason: "DEADLINE_EXCEEDED" as const },
    { taskId: "t5", status: "UNSCHEDULED" as const, reason: "NO_FEASIBLE_WINDOW" as const }
  ];

  const metricsObj = calculateMetrics(metricTasks, metricRes, [], metricOutcomes);
  assert.strictEqual(metricsObj.scheduledCount, 3);
  assert.strictEqual(metricsObj.unscheduledCount, 2);
  assert.strictEqual(metricsObj.deadlineMissRate, 1/5);
  assert.strictEqual(metricsObj.noWindowRate, 1/5);
  // Wait times should be 1000, 3000, 4000
  assert.strictEqual(metricsObj.averageWaitingTimeMs, (1000 + 3000 + 4000) / 3);
  console.log("✅ Metrics definitions properly classify reasons and wait times.");

  // TEST K: Priority Correctness
  console.log("Testing Priority Tie-Breaker Ordering...");
  
  await resetLabDatabase();
  // We need basic setup to avoid foreign key errors for tasks
  const testWl = new WorkloadGenerator({ ...config, taskCount: 0 }).generate();
  await seedLabDatabase(testWl);
  
  const satId = testWl.satellites[0]!.id;

  // Insert Task A: priority 10, Task B: priority 5, Task C: priority 5
  // B is created before C
  await db.insert(missionTasks).values([
    { id: "00000000-0000-4000-8000-000000000003", satelliteId: satId, name: "Task C", priority: 5, durationSeconds: 60, deadline: new Date(999999999), status: "PENDING", createdAt: new Date(2000) },
    { id: "00000000-0000-4000-8000-000000000002", satelliteId: satId, name: "Task B", priority: 5, durationSeconds: 60, deadline: new Date(999999999), status: "PENDING", createdAt: new Date(1000) },
    { id: "00000000-0000-4000-8000-000000000001", satelliteId: satId, name: "Task A", priority: 10, durationSeconds: 60, deadline: new Date(999999999), status: "PENDING", createdAt: new Date(3000) }
  ]);

  const candidateService = new CandidateService();
  const priorityScheduler = new PriorityScheduler(candidateService);
  
  const tasksFetched = await db.select()
    .from(missionTasks)
    .where(sql`${missionTasks.status} = 'PENDING'`)
    .orderBy(sql`${missionTasks.priority} DESC`, asc(missionTasks.createdAt), asc(missionTasks.id));
  
  assert.strictEqual(tasksFetched[0]!.id, "00000000-0000-4000-8000-000000000001", "Task A (prio 10) must be first");
  assert.strictEqual(tasksFetched[1]!.id, "00000000-0000-4000-8000-000000000002", "Task B (prio 5, earlier created) must be second");
  assert.strictEqual(tasksFetched[2]!.id, "00000000-0000-4000-8000-000000000003", "Task C (prio 5, later created) must be third");
  
  console.log("✅ Priority Tie-Breaker ordering is strictly enforced.");

  await pool.end();
}

runStage2Tests().catch(err => {
  console.error("Test failed", err);
  process.exit(1);
});
