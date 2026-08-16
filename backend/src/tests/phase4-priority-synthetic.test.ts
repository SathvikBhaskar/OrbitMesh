import { db, pool } from "../db/client";
import { 
  reservations, 
  missionTasks, 
  contactWindows, 
  groundStations, 
  satellites, 
  satelliteOrbitalData 
} from "../db/schema";
import { CandidateService } from "../modules/scheduler/candidate-service";
import { PriorityScheduler } from "../modules/scheduler/priority-scheduler";
import { eq, asc } from "drizzle-orm";
import assert from "assert";

async function resetDb() {
  await db.delete(reservations);
  await db.delete(missionTasks);
  await db.delete(contactWindows);
  await db.delete(groundStations);
  await db.delete(satelliteOrbitalData);
  await db.delete(satellites);
}

async function runSyntheticTests() {
  console.log("=== PHASE 4.3 PRIORITY SYNTHETIC TESTS ===");
  await resetDb();

  const satA = (await db.insert(satellites).values({ noradId: 10001, name: "Sat A", status: "ACTIVE" }).returning())[0]!;
  const stn1 = (await db.insert(groundStations).values({ code: "STN-1", name: "Station 1", latitude: 10, longitude: 10, minimumElevationDeg: 10, status: "AVAILABLE" }).returning())[0]!;
  const orbA = (await db.insert(satelliteOrbitalData).values({ satelliteId: satA.id, source: "CELESTRAK", tleLine1: "1", tleLine2: "2", tleEpoch: new Date(), receivedAt: new Date() }).returning())[0]!;

  const candidateService = new CandidateService();
  const priorityScheduler = new PriorityScheduler(candidateService);

  let taskCounter = 0;
  async function createTask(priority: number, durationSeconds: number, deadline: string, createdAtOffsetMs = 0) {
    taskCounter++;
    return (await db.insert(missionTasks).values({
      satelliteId: satA.id,
      name: `Task ${taskCounter}`,
      priority,
      durationSeconds,
      deadline: new Date(deadline),
      status: "PENDING",
      createdAt: new Date(Date.now() + createdAtOffsetMs)
    }).returning())[0]!;
  }

  async function createWindow(aos: string, los: string) {
    const aosDate = new Date(aos);
    const losDate = new Date(los);
    return (await db.insert(contactWindows).values({
      satelliteId: satA.id,
      groundStationId: stn1.id,
      orbitalDataId: orbA.id,
      aos: aosDate,
      los: losDate,
      durationSeconds: Math.floor((losDate.getTime() - aosDate.getTime()) / 1000),
      maxElevationDeg: 80
    }).returning())[0]!;
  }

  // Test 1 - priority beats creation order
  let w1 = await createWindow("2030-01-01T10:00:00Z", "2030-01-01T10:10:00Z"); // 10 minutes total
  const t1A = await createTask(5, 300, "2030-01-01T12:00:00Z", 100);
  const t1B = await createTask(9, 300, "2030-01-01T12:00:00Z", 200);
  let res = await priorityScheduler.schedulePendingTasks();
  assert.strictEqual(res.scheduled, 2);
  let resA = await db.select().from(reservations).where(eq(reservations.missionTaskId, t1A.id));
  let resB = await db.select().from(reservations).where(eq(reservations.missionTaskId, t1B.id));
  assert.strictEqual(resB[0]!.allocatedStart.toISOString(), "2030-01-01T10:00:00.000Z"); // High priority scheduled first
  assert.strictEqual(resB[0]!.allocatedEnd.toISOString(), "2030-01-01T10:05:00.000Z");
  assert.strictEqual(resA[0]!.allocatedStart.toISOString(), "2030-01-01T10:05:00.000Z"); // Low priority gets remainder
  assert.strictEqual(resA[0]!.allocatedEnd.toISOString(), "2030-01-01T10:10:00.000Z");
  console.log("✅ Test 1 - priority beats creation order");

  await resetDb();
  await db.insert(satellites).values(satA);
  await db.insert(groundStations).values(stn1);
  await db.insert(satelliteOrbitalData).values(orbA);

  // Test 2 - equal priority preserves FCFS
  const w2 = await createWindow("2030-01-01T10:00:00Z", "2030-01-01T10:10:00Z"); 
  const t2A = await createTask(8, 300, "2030-01-01T12:00:00Z", 100);
  const t2B = await createTask(8, 300, "2030-01-01T12:00:00Z", 200);
  res = await priorityScheduler.schedulePendingTasks();
  assert.strictEqual(res.scheduled, 2);
  resA = await db.select().from(reservations).where(eq(reservations.missionTaskId, t2A.id));
  resB = await db.select().from(reservations).where(eq(reservations.missionTaskId, t2B.id));
  assert.strictEqual(resA[0]!.allocatedStart.toISOString(), "2030-01-01T10:00:00.000Z"); // FCFS Tie-break
  assert.strictEqual(resA[0]!.allocatedEnd.toISOString(), "2030-01-01T10:05:00.000Z");
  assert.strictEqual(resB[0]!.allocatedStart.toISOString(), "2030-01-01T10:05:00.000Z");
  assert.strictEqual(resB[0]!.allocatedEnd.toISOString(), "2030-01-01T10:10:00.000Z");
  console.log("✅ Test 2 - equal priority preserves FCFS");

  await resetDb();
  await db.insert(satellites).values(satA);
  await db.insert(groundStations).values(stn1);
  await db.insert(satelliteOrbitalData).values(orbA);

  // Test 3 - high priority but infeasible
  const w3 = await createWindow("2030-01-01T10:00:00Z", "2030-01-01T10:05:00Z"); // Window is 300 sec
  const t3A = await createTask(10, 600, "2030-01-01T12:00:00Z", 100); // Demands 600 sec
  const t3B = await createTask(5, 300, "2030-01-01T12:00:00Z", 200); // Demands 300 sec
  res = await priorityScheduler.schedulePendingTasks();
  assert.strictEqual(res.scheduled, 1);
  assert.strictEqual(res.unscheduled, 1);
  assert.strictEqual(res.results.find(r => r.taskId === t3A.id)!.status, "UNSCHEDULED");
  assert.strictEqual(res.results.find(r => r.taskId === t3B.id)!.status, "SCHEDULED");
  console.log("✅ Test 3 - high priority but infeasible (Low priority gets the window)");

  await resetDb();
  await db.insert(satellites).values(satA);
  await db.insert(groundStations).values(stn1);
  await db.insert(satelliteOrbitalData).values(orbA);

  // Test 4 - priority vs deadline
  // Window: 10:00 -> 10:15 (15 min)
  // Low priority task with deadline 10:05. Needs 300s.
  // High priority task with deadline 12:00. Needs 600s.
  // Priority scheduler processes High first -> books 10:00 to 10:10.
  // Then processes Low -> needs 10:00 to 10:05 but it's taken, deadline exceeded! Low fails!
  const w4 = await createWindow("2030-01-01T10:00:00Z", "2030-01-01T10:15:00Z");
  const t4Low = await createTask(5, 300, "2030-01-01T10:05:00Z", 100); 
  const t4High = await createTask(9, 600, "2030-01-01T12:00:00Z", 200);
  res = await priorityScheduler.schedulePendingTasks();
  
  assert.strictEqual(res.scheduled, 1);
  assert.strictEqual(res.unscheduled, 1);
  assert.strictEqual(res.results.find(r => r.taskId === t4High.id)!.status, "SCHEDULED");
  assert.strictEqual(res.results.find(r => r.taskId === t4Low.id)!.status, "UNSCHEDULED");
  console.log("✅ Test 4 - priority vs deadline (Priority steals interval, Low misses deadline)");

  await pool.end();
}

runSyntheticTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
