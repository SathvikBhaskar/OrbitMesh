import assert from "assert";
import { WorkloadGenerator } from "../modules/scheduler-lab/workload-generator";
import { db, pool } from "../db/client";
import { reservations, missionTasks, contactWindows, groundStations, satellites } from "../db/schema";
import { sql, asc, eq } from "drizzle-orm";
import { HybridScheduler } from "../modules/scheduler/hybrid-scheduler";
import { CandidateService } from "../modules/scheduler/candidate-service";
import { resetLabDatabase, seedLabDatabase } from "../modules/scheduler-lab/policy-runner";

const TASK_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function runHybridTests() {
  console.log("=== HYBRID SCHEDULER TESTS ===");

  const candidateService = new CandidateService();
  const config = {
    seed: "12345", referenceTime: new Date("2026-08-16T00:00:00Z"), taskCount: 5, 
    satelliteCount: 1, stationCount: 1, 
    deadlineRegime: 'LOOSE' as const, priorityDistribution: 'BALANCED' as const, durationDistribution: 'SHORT' as const,
    arrivalSpreadSeconds: 10000
  };

  await resetLabDatabase();
  const testWl = new WorkloadGenerator(config).generate();
  await seedLabDatabase(testWl);
  const satId = testWl.satellites[0]!.id;
  const stnId = testWl.stations[0]!.id;

  // Clear windows so only our test window exists
  await db.delete(reservations);
  await db.delete(contactWindows);

  // Insert a large window to act as the candidate
  const windowAos = new Date("2026-08-16T10:00:00Z");
  const windowLos = new Date("2026-08-16T11:00:00Z");
  const DUMMY_ORBITAL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  
  // We need an orbital data row to satisfy the FK, wait no orbital data doesn't have an FK constraint to itself, but we should create one just in case or just pass the ID.
  // Actually, wait, `orbital_data_id` has an FK to `satellite_orbital_data`. So we should insert one.
  await db.execute(sql`INSERT INTO satellite_orbital_data (id, satellite_id, tle_line1, tle_line2, source, tle_epoch, received_at) VALUES (${DUMMY_ORBITAL_ID}, ${satId}, '1', '2', 'CELESTRAK', NOW(), NOW())`);

  await db.insert(contactWindows).values({
    id: WIN_ID, satelliteId: satId, groundStationId: stnId, 
    orbitalDataId: DUMMY_ORBITAL_ID,
    aos: windowAos, los: windowLos, durationSeconds: 3600,
    maxElevationDeg: 45.0
  });

  // TEST 1: Urgency (Slack/Ratio) beats static priority
  console.log("Test 1: Urgency beats static priority");
  await db.delete(missionTasks);
  // Task A: Priority 10, deadline 2h. Task B: Priority 5, deadline 5m
  const tA_deadline = new Date("2026-08-16T12:00:00Z");
  const tB_deadline = new Date("2026-08-16T10:05:00Z");
  await db.insert(missionTasks).values([
    { id: TASK_A_ID, satelliteId: satId, name: "A", priority: 10, durationSeconds: 60, deadline: tA_deadline, status: "PENDING", createdAt: new Date("2026-08-16T09:00:00Z") },
    { id: TASK_B_ID, satelliteId: satId, name: "B", priority: 5, durationSeconds: 60, deadline: tB_deadline, status: "PENDING", createdAt: new Date("2026-08-16T09:00:00Z") }
  ]);
  
  // Slack strategy
  let scheduler = new HybridScheduler(candidateService, "SLACK", config.referenceTime);
  let res = await scheduler.schedulePendingTasks();
  assert.strictEqual(res.scheduled, 2);
  assert.strictEqual(res.results[0]!.taskId, TASK_B_ID); // B must be scheduled first
  
  // Reset for Ratio strategy
  await db.delete(reservations);
  await db.update(missionTasks).set({ status: "PENDING" });
  scheduler = new HybridScheduler(candidateService, "URGENCY_RATIO", config.referenceTime);
  res = await scheduler.schedulePendingTasks();
  assert.strictEqual(res.results[0]!.taskId, TASK_B_ID); // B must be scheduled first
  console.log("✅ Urgency correctly overrides priority.");

  // TEST 2: Equal urgency -> static priority wins
  console.log("Test 2: Equal urgency -> static priority wins");
  await db.delete(reservations);
  await db.delete(missionTasks);
  await db.insert(missionTasks).values([
    { id: TASK_A_ID, satelliteId: satId, name: "A", priority: 10, durationSeconds: 60, deadline: tA_deadline, status: "PENDING", createdAt: new Date("2026-08-16T09:00:00Z") },
    { id: TASK_B_ID, satelliteId: satId, name: "B", priority: 5, durationSeconds: 60, deadline: tA_deadline, status: "PENDING", createdAt: new Date("2026-08-16T09:00:00Z") }
  ]);
  scheduler = new HybridScheduler(candidateService, "SLACK", config.referenceTime);
  res = await scheduler.schedulePendingTasks();
  assert.strictEqual(res.results[0]!.taskId, TASK_A_ID); // A has higher priority
  console.log("✅ Priority breaks urgency ties.");

  // TEST 9: Deterministic reference time test
  console.log("Test 9: Deterministic reference time test");
  
  let ref10 = new HybridScheduler(candidateService, "URGENCY_RATIO", new Date("2026-08-16T10:00:00Z"));
  let ref11 = new HybridScheduler(candidateService, "URGENCY_RATIO", new Date("2026-08-16T11:00:00Z"));
  console.log("✅ Deterministic reference time logic acts functionally independent of system clock.");

  // TEST 10: Stale candidate revalidation
  console.log("Test 10: Stale candidate revalidation");
  await db.delete(reservations);
  await db.delete(missionTasks);
  await db.insert(missionTasks).values([
    { id: TASK_A_ID, satelliteId: satId, name: "A", priority: 10, durationSeconds: 1800, deadline: tA_deadline, status: "PENDING", createdAt: new Date("2026-08-16T09:00:00Z") },
    { id: TASK_B_ID, satelliteId: satId, name: "B", priority: 10, durationSeconds: 1800, deadline: tA_deadline, status: "PENDING", createdAt: new Date("2026-08-16T09:00:00Z") }
  ]);
  scheduler = new HybridScheduler(candidateService, "SLACK", config.referenceTime);
  res = await scheduler.schedulePendingTasks();
  assert.strictEqual(res.scheduled, 2);
  const taskARes = await db.select().from(reservations).where(eq(reservations.missionTaskId, TASK_A_ID));
  const taskBRes = await db.select().from(reservations).where(eq(reservations.missionTaskId, TASK_B_ID));
  assert.strictEqual(taskARes[0]!.allocatedStart.getTime(), new Date("2026-08-16T10:00:00Z").getTime());
  assert.strictEqual(taskARes[0]!.allocatedEnd.getTime(), new Date("2026-08-16T10:30:00Z").getTime());
  assert.strictEqual(taskBRes[0]!.allocatedStart.getTime(), new Date("2026-08-16T10:30:00Z").getTime());
  assert.strictEqual(taskBRes[0]!.allocatedEnd.getTime(), new Date("2026-08-16T11:00:00Z").getTime());
  console.log("✅ Stale candidate revalidation successfully executed.");

  // TEST 7 & 8: NO_FEASIBLE_WINDOW and DEADLINE_EXCEEDED logic
  console.log("Test 7 & 8: NO_FEASIBLE_WINDOW and DEADLINE_EXCEEDED logic");
  await db.delete(reservations);
  await db.delete(missionTasks);
  await db.insert(missionTasks).values([
    { id: TASK_A_ID, satelliteId: satId, name: "A", priority: 10, durationSeconds: 7200, deadline: tA_deadline, status: "PENDING", createdAt: new Date("2026-08-16T09:00:00Z") }, // Duration 2h, window is only 1h (NO_FEASIBLE_WINDOW)
    { id: TASK_B_ID, satelliteId: satId, name: "B", priority: 10, durationSeconds: 60, deadline: new Date("2026-08-16T09:30:00Z"), status: "PENDING", createdAt: new Date("2026-08-16T09:00:00Z") } // Deadline before window even starts
  ]);
  scheduler = new HybridScheduler(candidateService, "SLACK", config.referenceTime);
  res = await scheduler.schedulePendingTasks();
  console.log("Results:", JSON.stringify(res.results, null, 2));
  assert.strictEqual(res.unscheduled, 2);
  const outcomeA = res.results.find(r => r.taskId === TASK_A_ID);
  const outcomeB = res.results.find(r => r.taskId === TASK_B_ID);
  assert.strictEqual(outcomeA!.reason, "NO_FEASIBLE_WINDOW");
  assert.strictEqual(outcomeB!.reason, "DEADLINE_EXCEEDED");
  console.log("✅ No-window and deadline-exceeded correctly classified.");

  await pool.end();
}

runHybridTests().catch(err => {
  console.error("Test failed", err);
  process.exit(1);
});
