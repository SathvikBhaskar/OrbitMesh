import { db, pool } from "./client";
import { 
  reservations, 
  missionTasks, 
  contactWindows, 
  groundStations, 
  satellites, 
  satelliteOrbitalData 
} from "./schema";
import { eq } from "drizzle-orm";

async function assertRejects(promise: Promise<any>, testName: string) {
  try {
    await promise;
    console.error(`❌ [${testName}] FAILED: Expected promise to reject but it resolved.`);
  } catch (error: any) {
    console.log(`✅ [${testName}] REJECTED AS EXPECTED`);
  }
}

async function runTests() {
  console.log("=== RESERVATION INTEGRITY TESTS ===");

  await db.delete(reservations);
  await db.delete(missionTasks);
  await db.delete(contactWindows);

  // Setup data
  const satARes = await db.insert(satellites).values({ noradId: 99991, name: "Sat A", status: "ACTIVE" }).onConflictDoUpdate({ target: satellites.noradId, set: { name: "Sat A" } }).returning();
  const satBRes = await db.insert(satellites).values({ noradId: 99992, name: "Sat B", status: "ACTIVE" }).onConflictDoUpdate({ target: satellites.noradId, set: { name: "Sat B" } }).returning();
  const satA = satARes[0]!;
  const satB = satBRes[0]!;

  const stnChennaiRes = await db.insert(groundStations).values({ code: "CHN-TEST", name: "Chennai", latitude: 13, longitude: 80, minimumElevationDeg: 10, status: "AVAILABLE" }).onConflictDoUpdate({ target: groundStations.code, set: { name: "Chennai" } }).returning();
  const stnBlrRes = await db.insert(groundStations).values({ code: "BLR-TEST", name: "Bangalore", latitude: 12, longitude: 77, minimumElevationDeg: 10, status: "AVAILABLE" }).onConflictDoUpdate({ target: groundStations.code, set: { name: "Bangalore" } }).returning();
  const stnChennai = stnChennaiRes[0]!;
  const stnBlr = stnBlrRes[0]!;

  const orbA = await db.insert(satelliteOrbitalData).values({ satelliteId: satA.id, source: "CELESTRAK", tleLine1: "1", tleLine2: "2", tleEpoch: new Date(), receivedAt: new Date() }).onConflictDoUpdate({ target: [satelliteOrbitalData.id, satelliteOrbitalData.satelliteId], set: { source: "CELESTRAK" } }).returning();
  const orbB = await db.insert(satelliteOrbitalData).values({ satelliteId: satB.id, source: "CELESTRAK", tleLine1: "1", tleLine2: "2", tleEpoch: new Date(), receivedAt: new Date() }).onConflictDoUpdate({ target: [satelliteOrbitalData.id, satelliteOrbitalData.satelliteId], set: { source: "CELESTRAK" } }).returning();

  const taskA_30m = await db.insert(missionTasks).values({ satelliteId: satA.id, name: "Task A 30m", priority: 5, durationSeconds: 1800, deadline: new Date("2030-01-01"), status: "PENDING" }).returning();
  const taskB_30m = await db.insert(missionTasks).values({ satelliteId: satB.id, name: "Task B 30m", priority: 5, durationSeconds: 1800, deadline: new Date("2030-01-01"), status: "PENDING" }).returning();
  const taskA_10m = await db.insert(missionTasks).values({ satelliteId: satA.id, name: "Task A 10m", priority: 5, durationSeconds: 600, deadline: new Date("2030-01-01"), status: "PENDING" }).returning();
  const taskA2_10m = await db.insert(missionTasks).values({ satelliteId: satA.id, name: "Task A2 10m", priority: 5, durationSeconds: 600, deadline: new Date("2030-01-01"), status: "PENDING" }).returning();
  const taskA3_5m = await db.insert(missionTasks).values({ satelliteId: satA.id, name: "Task A3 5m", priority: 5, durationSeconds: 300, deadline: new Date("2030-01-01"), status: "PENDING" }).returning();


  const windowA_Chennai = await db.insert(contactWindows).values({
    satelliteId: satA.id,
    groundStationId: stnChennai.id,
    orbitalDataId: orbA[0]!.id,
    aos: new Date("2026-08-20T10:00:00Z"),
    los: new Date("2026-08-20T10:30:00Z"),
    durationSeconds: 1800,
    maxElevationDeg: 80
  }).returning();

  const windowB_Chennai = await db.insert(contactWindows).values({
    satelliteId: satB.id,
    groundStationId: stnChennai.id,
    orbitalDataId: orbB[0]!.id,
    aos: new Date("2026-08-20T10:00:00Z"),
    los: new Date("2026-08-20T10:30:00Z"),
    durationSeconds: 1800,
    maxElevationDeg: 80
  }).returning();

  // Test A - station mismatch
  await assertRejects(
    db.insert(reservations).values({
      missionTaskId: taskA_30m[0]!.id,
      contactWindowId: windowA_Chennai[0]!.id,
      groundStationId: stnBlr.id, // Mismatch
      satelliteId: satA.id,
      windowAos: windowA_Chennai[0]!.aos,
      windowLos: windowA_Chennai[0]!.los,
      taskDurationSeconds: 1800,
      allocatedStart: new Date("2026-08-20T10:00:00Z"),
      allocatedEnd: new Date("2026-08-20T10:30:00Z"),
      status: "PENDING"
    }),
    "Test A - station mismatch"
  );

  // Test B - satellite mismatch
  await assertRejects(
    db.insert(reservations).values({
      missionTaskId: taskA_30m[0]!.id, // Sat A
      contactWindowId: windowB_Chennai[0]!.id, // Sat B
      groundStationId: stnChennai.id,
      satelliteId: satA.id,
      windowAos: windowB_Chennai[0]!.aos,
      windowLos: windowB_Chennai[0]!.los,
      taskDurationSeconds: 1800,
      allocatedStart: new Date("2026-08-20T10:00:00Z"),
      allocatedEnd: new Date("2026-08-20T10:30:00Z"),
      status: "PENDING"
    }),
    "Test B - satellite mismatch"
  );

  // Test C - starts before window
  await assertRejects(
    db.insert(reservations).values({
      missionTaskId: taskA_30m[0]!.id,
      contactWindowId: windowA_Chennai[0]!.id,
      groundStationId: stnChennai.id,
      satelliteId: satA.id,
      windowAos: windowA_Chennai[0]!.aos,
      windowLos: windowA_Chennai[0]!.los,
      taskDurationSeconds: 1800,
      allocatedStart: new Date("2026-08-20T09:59:00Z"),
      allocatedEnd: new Date("2026-08-20T10:29:00Z"),
      status: "PENDING"
    }),
    "Test C - starts before window"
  );

  // Test D - ends after window
  await assertRejects(
    db.insert(reservations).values({
      missionTaskId: taskA_30m[0]!.id,
      contactWindowId: windowA_Chennai[0]!.id,
      groundStationId: stnChennai.id,
      satelliteId: satA.id,
      windowAos: windowA_Chennai[0]!.aos,
      windowLos: windowA_Chennai[0]!.los,
      taskDurationSeconds: 1800,
      allocatedStart: new Date("2026-08-20T10:01:00Z"),
      allocatedEnd: new Date("2026-08-20T10:31:00Z"),
      status: "PENDING"
    }),
    "Test D - ends after window"
  );

  // Test E - wrong duration
  await assertRejects(
    db.insert(reservations).values({
      missionTaskId: taskA_30m[0]!.id,
      contactWindowId: windowA_Chennai[0]!.id,
      groundStationId: stnChennai.id,
      satelliteId: satA.id,
      windowAos: windowA_Chennai[0]!.aos,
      windowLos: windowA_Chennai[0]!.los,
      taskDurationSeconds: 1800,
      allocatedStart: new Date("2026-08-20T10:00:00Z"),
      allocatedEnd: new Date("2026-08-20T10:04:00Z"),
      status: "PENDING"
    }),
    "Test E - wrong duration"
  );

  // Test F - completed reservation doesn't block
  await db.insert(reservations).values({
    missionTaskId: taskA_10m[0]!.id,
    contactWindowId: windowA_Chennai[0]!.id,
    groundStationId: stnChennai.id,
    satelliteId: satA.id,
    windowAos: windowA_Chennai[0]!.aos,
    windowLos: windowA_Chennai[0]!.los,
    taskDurationSeconds: 600,
    allocatedStart: new Date("2026-08-20T10:00:00Z"),
    allocatedEnd: new Date("2026-08-20T10:10:00Z"),
    status: "COMPLETED"
  });
  
  await db.insert(reservations).values({
    missionTaskId: taskA_10m[0]!.id,
    contactWindowId: windowA_Chennai[0]!.id,
    groundStationId: stnChennai.id,
    satelliteId: satA.id,
    windowAos: windowA_Chennai[0]!.aos,
    windowLos: windowA_Chennai[0]!.los,
    taskDurationSeconds: 600,
    allocatedStart: new Date("2026-08-20T10:00:00Z"),
    allocatedEnd: new Date("2026-08-20T10:10:00Z"),
    status: "PENDING"
  });
  console.log("✅ Test F - completed reservation doesn't block");

  await db.delete(reservations).where(eq(reservations.status, "PENDING"));

  // Test G - cancelled reservation doesn't block
  await db.insert(reservations).values({
    missionTaskId: taskA_10m[0]!.id,
    contactWindowId: windowA_Chennai[0]!.id,
    groundStationId: stnChennai.id,
    satelliteId: satA.id,
    windowAos: windowA_Chennai[0]!.aos,
    windowLos: windowA_Chennai[0]!.los,
    taskDurationSeconds: 600,
    allocatedStart: new Date("2026-08-20T10:10:00Z"),
    allocatedEnd: new Date("2026-08-20T10:20:00Z"),
    status: "CANCELLED"
  });

  await db.insert(reservations).values({
    missionTaskId: taskA_10m[0]!.id, // We can reuse because previous is CANCELLED! (Test J allows this)
    contactWindowId: windowA_Chennai[0]!.id,
    groundStationId: stnChennai.id,
    satelliteId: satA.id,
    windowAos: windowA_Chennai[0]!.aos,
    windowLos: windowA_Chennai[0]!.los,
    taskDurationSeconds: 600,
    allocatedStart: new Date("2026-08-20T10:10:00Z"),
    allocatedEnd: new Date("2026-08-20T10:20:00Z"),
    status: "PENDING"
  });
  console.log("✅ Test G - cancelled reservation doesn't block");

  // Test H - pending reservation blocks overlapping
  await assertRejects(
    db.insert(reservations).values({
      missionTaskId: taskA2_10m[0]!.id, // Use task2 so we don't trip one-active-res constraint
      contactWindowId: windowA_Chennai[0]!.id,
      groundStationId: stnChennai.id,
      satelliteId: satA.id,
      windowAos: windowA_Chennai[0]!.aos,
      windowLos: windowA_Chennai[0]!.los,
      taskDurationSeconds: 600,
      allocatedStart: new Date("2026-08-20T10:15:00Z"),
      allocatedEnd: new Date("2026-08-20T10:25:00Z"),
      status: "CONFIRMED"
    }),
    "Test H - pending reservation blocks overlapping"
  );

  // Test I - adjacent active reservations
  await db.insert(reservations).values({
    missionTaskId: taskA2_10m[0]!.id, // Important: must use different task!
    contactWindowId: windowA_Chennai[0]!.id,
    groundStationId: stnChennai.id,
    satelliteId: satA.id,
    windowAos: windowA_Chennai[0]!.aos,
    windowLos: windowA_Chennai[0]!.los,
    taskDurationSeconds: 600,
    allocatedStart: new Date("2026-08-20T10:20:00Z"), // Adjacent to existing PENDING [10:10, 10:20)
    allocatedEnd: new Date("2026-08-20T10:30:00Z"),
    status: "CONFIRMED"
  });
  console.log("✅ Test I - adjacent active reservations accepted");

  // Test J - one active reservation per task
  // We insert a PENDING reservation for taskA3_5m
  await db.insert(reservations).values({
    missionTaskId: taskA3_5m[0]!.id,
    contactWindowId: windowA_Chennai[0]!.id,
    groundStationId: stnChennai.id,
    satelliteId: satA.id,
    windowAos: windowA_Chennai[0]!.aos,
    windowLos: windowA_Chennai[0]!.los,
    taskDurationSeconds: 300,
    allocatedStart: new Date("2026-08-20T10:00:00Z"),
    allocatedEnd: new Date("2026-08-20T10:05:00Z"),
    status: "PENDING"
  });

  // Attempt second PENDING reservation for taskA3_5m (different time, so no physical overlap)
  await assertRejects(
    db.insert(reservations).values({
      missionTaskId: taskA3_5m[0]!.id,
      contactWindowId: windowA_Chennai[0]!.id,
      groundStationId: stnChennai.id,
      satelliteId: satA.id,
      windowAos: windowA_Chennai[0]!.aos,
      windowLos: windowA_Chennai[0]!.los,
      taskDurationSeconds: 300,
      allocatedStart: new Date("2026-08-20T10:05:00Z"),
      allocatedEnd: new Date("2026-08-20T10:10:00Z"),
      status: "PENDING"
    }),
    "Test J - one active reservation per task"
  );
  
  // Set first to COMPLETED
  await db.update(reservations)
    .set({ status: "COMPLETED" })
    .where(eq(reservations.missionTaskId, taskA3_5m[0]!.id));

  // Attempt second again
  await db.insert(reservations).values({
    missionTaskId: taskA3_5m[0]!.id,
    contactWindowId: windowA_Chennai[0]!.id,
    groundStationId: stnChennai.id,
    satelliteId: satA.id,
    windowAos: windowA_Chennai[0]!.aos,
    windowLos: windowA_Chennai[0]!.los,
    taskDurationSeconds: 300,
    allocatedStart: new Date("2026-08-20T10:05:00Z"),
    allocatedEnd: new Date("2026-08-20T10:10:00Z"),
    status: "PENDING"
  });
  console.log("✅ Test J - historical reservations don't block second active reservation");

  // End
  await pool.end();
}

runTests().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
