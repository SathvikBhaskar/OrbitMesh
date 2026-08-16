import assert from "assert";
import { WorkloadGenerator } from "../modules/scheduler-lab/workload-generator";
import { WorkloadConfig, LabTaskOutcome } from "../modules/scheduler-lab/types";
import { calculateMetrics, LabReservation, LabContactWindow, LabTask } from "../modules/scheduler-lab/metrics";

function testWorkloadGenerator() {
  console.log("=== LAB STAGE 1: WORKLOAD GENERATOR ===");
  
  const configA: WorkloadConfig = {
    seed: "12345",
    referenceTime: new Date("2026-08-16T00:00:00Z"),
    taskCount: 100,
    satelliteCount: 2,
    stationCount: 2,
    deadlineRegime: 'LOOSE',
    priorityDistribution: 'BALANCED',
    durationDistribution: 'SHORT',
    arrivalSpreadSeconds: 86400
  };

  const configB: WorkloadConfig = { ...configA, seed: "54321" };

  const genA1 = new WorkloadGenerator(configA).generate();
  const genA2 = new WorkloadGenerator(configA).generate();
  const genB = new WorkloadGenerator(configB).generate();

  // 1. Same seed -> Identical workload
  assert.deepStrictEqual(genA1.tasks, genA2.tasks);
  assert.deepStrictEqual(genA1.windows, genA2.windows);
  assert.deepStrictEqual(genA1.satellites, genA2.satellites);
  
  // 2. Different seed -> Different workload
  assert.notDeepStrictEqual(genA1.tasks, genB.tasks);
  
  // Basic sanity checks
  assert.strictEqual(genA1.tasks.length, 100);
  assert.strictEqual(genA1.satellites.length, 2);
  
  // Priority boundaries
  assert(genA1.tasks.every(t => t.priority >= 1 && t.priority <= 10));

  console.log("✅ Reproducibility tests passed!");
}

function testMetrics() {
  console.log("=== LAB STAGE 1: METRICS ===");
  
  const tasks: LabTask[] = [
    { id: "t1", createdAt: new Date("2026-08-16T10:00:00Z"), priority: 1 },
    { id: "t2", createdAt: new Date("2026-08-16T10:05:00Z"), priority: 10 },
    { id: "t3", createdAt: new Date("2026-08-16T10:10:00Z"), priority: 5 },
    { id: "t4", createdAt: new Date("2026-08-16T10:15:00Z"), priority: 10 },
  ];

  const windows: LabContactWindow[] = [
    // Two overlapping windows on the same station
    { id: "w1", groundStationId: "stn1", aos: new Date("2026-08-16T12:00:00Z"), los: new Date("2026-08-16T12:30:00Z"), durationSeconds: 1800 },
    { id: "w2", groundStationId: "stn1", aos: new Date("2026-08-16T12:10:00Z"), los: new Date("2026-08-16T12:40:00Z"), durationSeconds: 1800 },
    // A separate window on stn2
    { id: "w3", groundStationId: "stn2", aos: new Date("2026-08-16T14:00:00Z"), los: new Date("2026-08-16T14:10:00Z"), durationSeconds: 600 },
  ];

  const outcomes: LabTaskOutcome[] = [
    { taskId: "t1", status: "SCHEDULED" },
    { taskId: "t2", status: "SCHEDULED" },
    { taskId: "t3", status: "UNSCHEDULED", reason: "DEADLINE_EXCEEDED" },
    { taskId: "t4", status: "UNSCHEDULED", reason: "NO_FEASIBLE_WINDOW" }
  ];

  const reservations: LabReservation[] = [
    // t1 scheduled 12:00 to 12:10. created at 10:00. Wait = 2 hours = 7200 sec
    { missionTaskId: "t1", contactWindowId: "w1", groundStationId: "stn1", allocatedStart: new Date("2026-08-16T12:00:00Z"), allocatedEnd: new Date("2026-08-16T12:10:00Z") },
    // t2 scheduled 12:10 to 12:20. created at 10:05. Wait = 2 hours 5 mins = 7500 sec
    { missionTaskId: "t2", contactWindowId: "w2", groundStationId: "stn1", allocatedStart: new Date("2026-08-16T12:10:00Z"), allocatedEnd: new Date("2026-08-16T12:20:00Z") }
  ];

  const metrics = calculateMetrics(tasks, reservations, windows, outcomes);
  
  // 1. Success rate
  // 4 tasks, 2 scheduled => 50%
  assert.strictEqual(metrics.schedulingSuccessRate, 0.5);

  // 2. Reason rates
  // 1 deadline exceeded => 25%
  assert.strictEqual(metrics.deadlineMissRate, 0.25);
  // 1 no window => 25%
  assert.strictEqual(metrics.noWindowRate, 0.25);
  // 0 resource conflict => 0%
  assert.strictEqual(metrics.resourceConflictRate, 0);

  // 3. Waiting times
  // wait t1 = 7200000 ms, t2 = 7500000 ms. Avg = 7350000 ms.
  assert.strictEqual(metrics.averageWaitingTimeMs, 7350000);
  
  // p95 of [7200000, 7500000]. length=2. floor(2 * 0.95) = floor(1.9) = 1. index 1 is 7500000.
  assert.strictEqual(metrics.p95WaitingTimeMs, 7500000);

  // 4. Contact-window utilization
  // reserved = 10m + 10m = 1200s. Window sum = 1800 + 1800 + 600 = 4200s. 1200 / 4200 = 28.57%
  assert.strictEqual(metrics.contactWindowUtilization, 1200 / 4200);

  // 5. Ground-station utilization
  // stn1 UNION: [12:00 -> 12:40] = 40 min = 2400s
  // stn2 UNION: [14:00 -> 14:10] = 10 min = 600s
  // Total UNION = 3000s
  // reserved = 1200s. 1200 / 3000 = 40%
  assert.strictEqual(metrics.groundStationUtilization, 1200 / 3000);

  // 6. Success by Priority
  // Prio 1: 1 task (t1), scheduled => 1.0
  // Prio 5: 1 task (t3), unscheduled => 0.0
  // Prio 10: 2 tasks (t2, t4), 1 scheduled => 0.5
  assert.strictEqual(metrics.successByPriority[1], 1.0);
  assert.strictEqual(metrics.successByPriority[5], 0.0);
  assert.strictEqual(metrics.successByPriority[10], 0.5);

  console.log("✅ Metrics calculated correctly!");
}

try {
  testWorkloadGenerator();
  testMetrics();
} catch (err) {
  console.error("Test failed!", err);
  process.exit(1);
}
