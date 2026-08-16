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
import { FcfsScheduler } from "../modules/scheduler/fcfs-scheduler";
import { eq, asc, inArray } from "drizzle-orm";
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
  console.log("=== PHASE 4.2 FCFS SYNTHETIC TESTS ===");
  await resetDb();

  const satA = (await db.insert(satellites).values({ noradId: 10001, name: "Sat A", status: "ACTIVE" }).returning())[0]!;
  const stn1 = (await db.insert(groundStations).values({ code: "STN-1", name: "Station 1", latitude: 10, longitude: 10, minimumElevationDeg: 10, status: "AVAILABLE" }).returning())[0]!;
  const orbA = (await db.insert(satelliteOrbitalData).values({ satelliteId: satA.id, source: "CELESTRAK", tleLine1: "1", tleLine2: "2", tleEpoch: new Date(), receivedAt: new Date() }).returning())[0]!;

  const candidateService = new CandidateService();
  const fcfsScheduler = new FcfsScheduler(candidateService);

  // Helper to create task
  let taskCounter = 0;
  async function createTask(durationSeconds: number, deadline: string, createdAtOffsetMs = 0) {
    taskCounter++;
    return (await db.insert(missionTasks).values({
      satelliteId: satA.id,
      name: `Task ${taskCounter}`,
      priority: 5,
      durationSeconds,
      deadline: new Date(deadline),
      status: "PENDING",
      createdAt: new Date(Date.now() + createdAtOffsetMs)
    }).returning())[0]!;
  }

  // Helper to create window
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

  // Test 1 - basic scheduling
  const w1 = await createWindow("2030-01-01T10:30:00Z", "2030-01-01T11:00:00Z");
  const t1 = await createTask(300, "2030-01-01T12:00:00Z", 0);
  
  let res = await fcfsScheduler.schedulePendingTasks();
  assert.strictEqual(res.scheduled, 1);
  assert.strictEqual(res.results[0]!.status, "SCHEDULED");
  let alloc = await db.select().from(reservations).where(eq(reservations.missionTaskId, t1.id));
  assert.strictEqual(alloc[0]!.allocatedStart.toISOString(), "2030-01-01T10:30:00.000Z");
  assert.strictEqual(alloc[0]!.allocatedEnd.toISOString(), "2030-01-01T10:35:00.000Z");
  console.log("✅ Test 1 - basic scheduling");

  await resetDb();
  await db.insert(satellites).values(satA);
  await db.insert(groundStations).values(stn1);
  await db.insert(satelliteOrbitalData).values(orbA);

  // Test 2 - insufficient window
  const w2 = await createWindow("2030-01-01T10:30:00Z", "2030-01-01T10:35:00Z"); // 300s window
  const t2 = await createTask(600, "2030-01-01T12:00:00Z", 0); // 600s task
  res = await fcfsScheduler.schedulePendingTasks();
  assert.strictEqual(res.unscheduled, 1);
  assert.strictEqual(res.results[0]!.status, "UNSCHEDULED");
  console.log("✅ Test 2 - insufficient window (rejected)");

  await resetDb();
  await db.insert(satellites).values(satA);
  await db.insert(groundStations).values(stn1);
  await db.insert(satelliteOrbitalData).values(orbA);

  // Test 3 - deadline
  const w3 = await createWindow("2030-01-01T10:00:00Z", "2030-01-01T11:00:00Z");
  const t3 = await createTask(600, "2030-01-01T10:05:00Z", 0); // deadline allows only 300s
  res = await fcfsScheduler.schedulePendingTasks();
  assert.strictEqual(res.unscheduled, 1);
  assert.strictEqual(res.results[0]!.status, "UNSCHEDULED");
  console.log("✅ Test 3 - deadline (rejected)");

  await resetDb();
  await db.insert(satellites).values(satA);
  await db.insert(groundStations).values(stn1);
  await db.insert(satelliteOrbitalData).values(orbA);

  // Test 4 - existing reservation gap
  const w4 = await createWindow("2030-01-01T10:00:00Z", "2030-01-01T11:00:00Z");
  // manually insert a reservation from 10:00 to 10:10
  // we need a dummy task for it
  const dummyTask = await createTask(600, "2030-01-01T12:00:00Z", 0);
  await db.update(missionTasks).set({ status: "SCHEDULED" }).where(eq(missionTasks.id, dummyTask.id));
  await db.insert(reservations).values({
    missionTaskId: dummyTask.id,
    contactWindowId: w4.id,
    groundStationId: stn1.id,
    satelliteId: satA.id,
    windowAos: w4.aos,
    windowLos: w4.los,
    taskDurationSeconds: 600,
    allocatedStart: new Date("2030-01-01T10:00:00Z"),
    allocatedEnd: new Date("2030-01-01T10:10:00Z"),
    status: "CONFIRMED"
  });

  const t4 = await createTask(300, "2030-01-01T12:00:00Z", 100);
  res = await fcfsScheduler.schedulePendingTasks();
  assert.strictEqual(res.scheduled, 1); // t4 should be scheduled
  alloc = await db.select().from(reservations).where(eq(reservations.missionTaskId, t4.id));
  assert.strictEqual(alloc[0]!.allocatedStart.toISOString(), "2030-01-01T10:10:00.000Z");
  assert.strictEqual(alloc[0]!.allocatedEnd.toISOString(), "2030-01-01T10:15:00.000Z");
  console.log("✅ Test 4 - existing reservation");

  await resetDb();
  await db.insert(satellites).values(satA);
  await db.insert(groundStations).values(stn1);
  await db.insert(satelliteOrbitalData).values(orbA);

  // Test 5 - FCFS ordering
  const w5 = await createWindow("2030-01-01T10:00:00Z", "2030-01-01T10:15:00Z"); // 15 mins total
  const t5A = await createTask(300, "2030-01-01T12:00:00Z", 100);
  const t5B = await createTask(300, "2030-01-01T12:00:00Z", 200); // Created slightly after
  res = await fcfsScheduler.schedulePendingTasks();
  assert.strictEqual(res.scheduled, 2);
  const resA = await db.select().from(reservations).where(eq(reservations.missionTaskId, t5A.id));
  const resB = await db.select().from(reservations).where(eq(reservations.missionTaskId, t5B.id));
  assert.strictEqual(resA[0]!.allocatedStart.toISOString(), "2030-01-01T10:00:00.000Z");
  assert.strictEqual(resA[0]!.allocatedEnd.toISOString(), "2030-01-01T10:05:00.000Z");
  assert.strictEqual(resB[0]!.allocatedStart.toISOString(), "2030-01-01T10:05:00.000Z");
  assert.strictEqual(resB[0]!.allocatedEnd.toISOString(), "2030-01-01T10:10:00.000Z");
  console.log("✅ Test 5 - FCFS ordering (Task A before B)");

  await resetDb();
  await db.insert(satellites).values(satA);
  await db.insert(groundStations).values(stn1);
  await db.insert(satelliteOrbitalData).values(orbA);

  // Test 6 - later created task cannot jump ahead
  // If Task A created at 10:00 requires 10 hours
  // Task B created at 10:01 requires 5 mins
  // Window is 1 hour. Task A will fail, Task B will succeed. BUT, does B jump A?
  // Wait, if A fails, it's marked UNSCHEDULED. B is then checked. So B will schedule.
  // The test specifically is: "Even if B has shorter duration, FCFS still considers A first."
  const w6 = await createWindow("2030-01-01T10:00:00Z", "2030-01-01T11:00:00Z");
  const t6A = await createTask(36000, "2030-01-01T12:00:00Z", 100);
  const t6B = await createTask(300, "2030-01-01T12:00:00Z", 200);
  res = await fcfsScheduler.schedulePendingTasks();
  assert.strictEqual(res.unscheduled, 1);
  assert.strictEqual(res.scheduled, 1);
  assert.strictEqual(res.results[0]!.taskId, t6A.id);
  assert.strictEqual(res.results[0]!.status, "UNSCHEDULED");
  assert.strictEqual(res.results[1]!.taskId, t6B.id);
  assert.strictEqual(res.results[1]!.status, "SCHEDULED");
  console.log("✅ Test 6 - later-created task cannot jump ahead (A processed before B)");

  await resetDb();
  await db.insert(satellites).values(satA);
  await db.insert(groundStations).values(stn1);
  await db.insert(satelliteOrbitalData).values(orbA);

  // Test 7 - gap after multiple reservations
  const w7 = await createWindow("2030-01-01T10:00:00Z", "2030-01-01T11:00:00Z");
  
  const dummyTask1 = await createTask(600, "2030-01-01T12:00:00Z", 1);
  await db.update(missionTasks).set({ status: "SCHEDULED" }).where(eq(missionTasks.id, dummyTask1.id));
  await db.insert(reservations).values({
    missionTaskId: dummyTask1.id, contactWindowId: w7.id, groundStationId: stn1.id, satelliteId: satA.id,
    windowAos: w7.aos, windowLos: w7.los, taskDurationSeconds: 600,
    allocatedStart: new Date("2030-01-01T10:00:00Z"), allocatedEnd: new Date("2030-01-01T10:10:00Z"), status: "CONFIRMED"
  });

  const dummyTask2 = await createTask(600, "2030-01-01T12:00:00Z", 2);
  await db.update(missionTasks).set({ status: "SCHEDULED" }).where(eq(missionTasks.id, dummyTask2.id));
  await db.insert(reservations).values({
    missionTaskId: dummyTask2.id, contactWindowId: w7.id, groundStationId: stn1.id, satelliteId: satA.id,
    windowAos: w7.aos, windowLos: w7.los, taskDurationSeconds: 600,
    allocatedStart: new Date("2030-01-01T10:20:00Z"), allocatedEnd: new Date("2030-01-01T10:30:00Z"), status: "CONFIRMED"
  });

  const dummyTask3 = await createTask(600, "2030-01-01T12:00:00Z", 3);
  await db.update(missionTasks).set({ status: "SCHEDULED" }).where(eq(missionTasks.id, dummyTask3.id));
  await db.insert(reservations).values({
    missionTaskId: dummyTask3.id, contactWindowId: w7.id, groundStationId: stn1.id, satelliteId: satA.id,
    windowAos: w7.aos, windowLos: w7.los, taskDurationSeconds: 600,
    allocatedStart: new Date("2030-01-01T10:40:00Z"), allocatedEnd: new Date("2030-01-01T10:50:00Z"), status: "CONFIRMED"
  });

  const t7A = await createTask(600, "2030-01-01T12:00:00Z", 100);
  const t7B = await createTask(600, "2030-01-01T12:00:00Z", 200);

  res = await fcfsScheduler.schedulePendingTasks();
  assert.strictEqual(res.scheduled, 2);

  const res7A = await db.select().from(reservations).where(eq(reservations.missionTaskId, t7A.id));
  const res7B = await db.select().from(reservations).where(eq(reservations.missionTaskId, t7B.id));
  
  assert.strictEqual(res7A[0]!.allocatedStart.toISOString(), "2030-01-01T10:10:00.000Z");
  assert.strictEqual(res7A[0]!.allocatedEnd.toISOString(), "2030-01-01T10:20:00.000Z");

  assert.strictEqual(res7B[0]!.allocatedStart.toISOString(), "2030-01-01T10:30:00.000Z");
  assert.strictEqual(res7B[0]!.allocatedEnd.toISOString(), "2030-01-01T10:40:00.000Z");

  console.log("✅ Test 7 - gap after multiple reservations");

  await pool.end();
}

runSyntheticTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
