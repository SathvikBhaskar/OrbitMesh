import { db, pool } from "./client";
import { satellites, groundStations, missionTasks } from "./schema";
import { eq } from "drizzle-orm";

async function assertRejects(promise: Promise<any>, testName: string, expectedErrorPattern?: string) {
  try {
    await promise;
    console.error(`❌ [${testName}] FAILED: Expected promise to reject but it resolved.`);
  } catch (err: any) {
    if (expectedErrorPattern && !err.message.includes(expectedErrorPattern)) {
       console.log(`⚠️ [${testName}] REJECTED AS EXPECTED, but error didn't match '${expectedErrorPattern}'. Error was: ${err.message}`);
    } else {
       console.log(`✅ [${testName}] SUCCESS (Rejected as expected: ${err.message})`);
    }
  }
}

async function assertResolves(promise: Promise<any>, testName: string) {
  try {
    await promise;
    console.log(`✅ [${testName}] SUCCESS (Resolved as expected)`);
  } catch (err: any) {
    console.error(`❌ [${testName}] FAILED: Expected promise to resolve but it rejected. Error: ${err.message}`);
  }
}

async function main() {
  console.log("Running Constraint Tests...");
  const futureDate = new Date(Date.now() + 86400000);

  // Test 1 — valid satellite
  console.log("--- Test 1 ---");
  let satId = "";
  await assertResolves((async () => {
    const res = await db.insert(satellites).values({ noradId: 99999, name: "Test Sat", status: "ACTIVE" }).returning();
    satId = res[0]!.id;
  })(), "Valid Satellite");

  // Test 2 — duplicate NORAD
  console.log("--- Test 2 ---");
  await assertRejects(
    db.insert(satellites).values({ noradId: 99999, name: "Test Sat Dup", status: "ACTIVE" }),
    "Duplicate NORAD",
    "duplicate key value"
  );

  // Test 3 — invalid NORAD
  console.log("--- Test 3 ---");
  await assertRejects(
    db.insert(satellites).values({ noradId: -1, name: "Test Sat Invalid", status: "ACTIVE" }),
    "Invalid NORAD (-1)",
    "check"
  );

  // Test 4 — valid ground station
  console.log("--- Test 4 ---");
  await assertResolves(
    db.insert(groundStations).values({
      code: "TEST-01", name: "Test GS", latitude: 13.0827, longitude: 80.2707, minimumElevationDeg: 10, status: "AVAILABLE"
    }),
    "Valid Ground Station"
  );

  // Test 5 — invalid latitude
  console.log("--- Test 5 ---");
  await assertRejects(
    db.insert(groundStations).values({
      code: "TEST-02", name: "Test GS Lat", latitude: 100, longitude: 80, minimumElevationDeg: 10, status: "AVAILABLE"
    }),
    "Invalid Latitude (100)"
  );

  // Test 6 — invalid longitude
  console.log("--- Test 6 ---");
  await assertRejects(
    db.insert(groundStations).values({
      code: "TEST-03", name: "Test GS Lon", latitude: 10, longitude: -200, minimumElevationDeg: 10, status: "AVAILABLE"
    }),
    "Invalid Longitude (-200)"
  );

  // Test 7 — invalid elevation
  console.log("--- Test 7 ---");
  await assertRejects(
    db.insert(groundStations).values({
      code: "TEST-04", name: "Test GS Elev", latitude: 10, longitude: 80, minimumElevationDeg: 100, status: "AVAILABLE"
    }),
    "Invalid Elevation (100)"
  );

  // Test 8 — valid task
  console.log("--- Test 8 ---");
  await assertResolves(
    db.insert(missionTasks).values({
      satelliteId: satId, name: "Test Task", priority: 8, durationSeconds: 300, deadline: futureDate, status: "PENDING"
    }),
    "Valid Task"
  );

  // Test 9 — invalid priority
  console.log("--- Test 9 ---");
  await assertRejects(
    db.insert(missionTasks).values({
      satelliteId: satId, name: "Test Task Pri", priority: 11, durationSeconds: 300, deadline: futureDate, status: "PENDING"
    }),
    "Invalid Priority (11)"
  );

  // Test 10 — invalid duration
  console.log("--- Test 10 ---");
  await assertRejects(
    db.insert(missionTasks).values({
      satelliteId: satId, name: "Test Task Dur1", priority: 5, durationSeconds: 0, deadline: futureDate, status: "PENDING"
    }),
    "Invalid Duration (0)"
  );
  await assertRejects(
    db.insert(missionTasks).values({
      satelliteId: satId, name: "Test Task Dur2", priority: 5, durationSeconds: -1, deadline: futureDate, status: "PENDING"
    }),
    "Invalid Duration (-1)"
  );

  // Test 11 — invalid satellite relationship
  console.log("--- Test 11 ---");
  const randomUuid = "00000000-0000-0000-0000-000000000000";
  await assertRejects(
    db.insert(missionTasks).values({
      satelliteId: randomUuid, name: "Test Task Sat", priority: 5, durationSeconds: 300, deadline: futureDate, status: "PENDING"
    }),
    "Invalid Satellite FK"
  );

  // Test 12 — satellite deletion
  console.log("--- Test 12 ---");
  await assertRejects(
    db.delete(satellites).where(eq(satellites.id, satId)),
    "Satellite Deletion with tasks"
  );

  await pool.end();
}

main().catch(console.error);
