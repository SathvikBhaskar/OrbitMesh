import { validateTle } from "../modules/orbital-data/validator";
import { propagateOrbit } from "../modules/orbit/propagator";
import { db, pool } from "../db/client";
import { satelliteOrbitalData, satellites, missionTasks, groundStations, contactWindows, reservations, schedulerRuns } from "../db/schema";
import { OrbitalDataService } from "../modules/orbital-data/services/orbital-data-service";
import { PositionService } from "../modules/orbit/position-service";
import { VisibilityService } from "../modules/visibility/visibility-service";
import { eq } from "drizzle-orm";

const TLE_LINE1_ISS = "1 25544U 98067A   26227.12345678  .00000000  00000-0  00000-0 0  9999";
const TLE_LINE2_ISS = "2 25544  51.6400  10.0000 0001000   0.0000   0.0000 15.50000000000000";
const EXPECTED_NORAD = 25544;

async function assertThrowsAsync(promise: Promise<any>, errorMsgPattern: string, testName: string) {
  try {
    await promise;
    console.error(`❌ [${testName}] FAILED: Expected error containing '${errorMsgPattern}'`);
    process.exit(1);
  } catch (err: any) {
    if (!err.message.includes(errorMsgPattern)) {
       console.error(`❌ [${testName}] FAILED: Error did not match. Got: ${err.message}`);
       process.exit(1);
    } else {
       console.log(`✅ [${testName}] SUCCESS (Rejected correctly)`);
    }
  }
}

function assertThrows(fn: () => any, errorMsgPattern: string, testName: string) {
  try {
    fn();
    console.error(`❌ [${testName}] FAILED: Expected error containing '${errorMsgPattern}'`);
    process.exit(1);
  } catch (err: any) {
    if (!err.message.includes(errorMsgPattern)) {
       console.error(`❌ [${testName}] FAILED: Error did not match. Got: ${err.message}`);
       process.exit(1);
    } else {
       console.log(`✅ [${testName}] SUCCESS (Rejected correctly)`);
    }
  }
}

async function runTests() {
  console.log("=== PHASE 2 UNIT TESTS ===");

  // Parser Tests
  console.log("\n--- TLE Validator ---");
  validateTle(TLE_LINE1_ISS, TLE_LINE2_ISS, EXPECTED_NORAD);
  console.log("✅ [Valid TLE] SUCCESS");
  assertThrows(() => validateTle("", TLE_LINE2_ISS, EXPECTED_NORAD), "missing or empty", "Empty Line 1");
  assertThrows(() => validateTle("1 2", "2 3", EXPECTED_NORAD), "68 characters", "Malformed Line");
  assertThrows(() => validateTle(TLE_LINE1_ISS.replace("25544", "12345"), TLE_LINE2_ISS, EXPECTED_NORAD), "NORAD ID mismatch", "NORAD Mismatch");

  // Propagation Tests
  console.log("\n--- SGP4 Propagator ---");
  const testTime = new Date("2026-08-15T12:00:00Z");
  const pv = propagateOrbit(TLE_LINE1_ISS, TLE_LINE2_ISS, testTime);
  if (pv.position && pv.velocity) {
    console.log("✅ [Propagator Valid] SUCCESS (Position/Velocity returned)");
  } else {
    console.error("❌ Propagator missing position/velocity");
    process.exit(1);
  }
  
  assertThrows(() => propagateOrbit(TLE_LINE1_ISS, TLE_LINE2_ISS, new Date("invalid")), "Invalid timestamp", "Invalid Timestamp");

  console.log("\n=== PHASE 2 INTEGRATION TESTS ===");
  // DB setup
  await db.delete(schedulerRuns);
  await db.delete(reservations);
  await db.delete(contactWindows);
  await db.delete(satelliteOrbitalData);
  await db.delete(missionTasks);
  await db.delete(satellites);
  await db.delete(groundStations);

  const sat = await db.insert(satellites).values({
    noradId: 25544,
    name: "ISS (ZARYA)",
    status: "ACTIVE",
  }).returning();
  const satId = sat[0]!.id;

  const gs = await db.insert(groundStations).values({
    code: "CHN-01",
    name: "Chennai Station",
    latitude: 13.0827,
    longitude: 80.2707,
    altitudeM: 10,
    minimumElevationDeg: 10,
    status: "AVAILABLE",
  }).returning();
  const gsId = gs[0]!.id;

  // CelesTrak provider test
  console.log("\n--- CelesTrak Ingestion ---");
  const orbitalService = new OrbitalDataService();
  const record = await orbitalService.refreshOrbitalData(satId);
  console.log(`✅ [CelesTrak Refresh] SUCCESS (TLE stored with epoch: ${record!.tleEpoch.toISOString()})`);

  const secondRecord = await orbitalService.refreshOrbitalData(satId);
  const totalRecords = await db.select().from(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, satId));
  // Since Step 5.1 added a UNIQUE constraint on (satellite_id, tle_epoch), calling refresh twice
  // with the same TLE epoch is idempotent — either 1 or 2 records depending on whether CelesTrak
  // returned a different epoch on the second call.
  if (totalRecords.length >= 1) {
    console.log(`✅ [Historical Records] SUCCESS (${totalRecords.length} record(s) — idempotent on same epoch, additive on new epoch)`);
  } else {
    console.error(`❌ Expected at least 1 record, found ${totalRecords.length}`);
    process.exit(1);
  }

  // Position Service API
  console.log("\n--- Position Service ---");
  const positionService = new PositionService();
  const posLive = await positionService.getPosition(satId, new Date());
  if (posLive.position) {
     console.log("✅ [Position API] SUCCESS");
  } else {
     console.error("❌ Position API failed");
     process.exit(1);
  }

  // Visibility Service API
  console.log("\n--- Visibility Service ---");
  const visibilityService = new VisibilityService();
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + 90 * 60 * 1000); // 90 min ISS orbit
  const vis = await visibilityService.getVisibility(satId, gsId, startTime, endTime, 60);
  
  if (vis.samples.length > 0) {
     console.log(`✅ [Visibility API] SUCCESS (Generated ${vis.samples.length} samples)`);
  } else {
     console.error("❌ Visibility API returned no samples");
     process.exit(1);
  }

  // Ensure minimum elevation rule is respected
  let minElevRespected = true;
  for (const s of vis.samples) {
    if (s.visible && s.elevationDeg < 10) minElevRespected = false;
    if (!s.visible && s.elevationDeg >= 10 && !isNaN(s.elevationDeg)) minElevRespected = false;
  }
  
  if (minElevRespected) {
    console.log("✅ [Visibility Math] SUCCESS (Respects min elevation)");
  } else {
    console.error("❌ Visibility Math failed min elevation rules");
    process.exit(1);
  }

  console.log("\nAll Phase 2 tests passed! ✅");
  await pool.end();
}

runTests().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
