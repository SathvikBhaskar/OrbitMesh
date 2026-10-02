import { DemoOrbitalDataProvider, DemoMissionTaskProvider } from "../modules/data-providers/demo-providers";
import assert from "assert";

async function runTests() {
  console.log("=== PROVIDER BOUNDARY TESTS ===");
  const SEED = 202600;

  // Test 1: Satellites
  const orbitalProvider = new DemoOrbitalDataProvider(SEED);
  const sats = await orbitalProvider.getSatellites();
  assert.strictEqual(sats.length, 8);
  assert.strictEqual(sats[0]?.noradId, 25544);
  assert.strictEqual(sats[7]?.noradId, 28654);
  console.log("✅ Satellites generated correctly");

  // Test 2: Ground Stations
  const stations = await orbitalProvider.getGroundStations();
  assert.strictEqual(stations.length, 4);
  assert.strictEqual(stations[0]?.code, "SVAL");
  assert.strictEqual(stations[3]?.code, "FBK");
  console.log("✅ Ground stations generated correctly");

  // Test 3: Dummy TLEs
  const satIds = ["sat1", "sat2", "sat3", "sat4", "sat5", "sat6", "sat7", "sat8"];
  const tles = await orbitalProvider.getOrbitalData(satIds);
  assert.strictEqual(tles.length, 8);
  assert.strictEqual(tles[0]?.satelliteId, "sat1");
  assert.ok(tles[0]?.tleLine2.includes("51.6400"));
  console.log("✅ TLEs generated correctly");

  // Test 4: Mission Tasks
  const taskProvider = new DemoMissionTaskProvider(SEED);
  const refTime = new Date("2026-01-01T00:00:00Z");
  const tasks = await taskProvider.getMissionTasks(satIds, refTime);
  assert.strictEqual(tasks.length, 50);
  assert.ok(tasks[0]!.priority >= 1 && tasks[0]!.priority <= 10);
  assert.strictEqual(tasks[49]?.name, "Observation Task 050");
  console.log("✅ Mission tasks generated correctly");
}

runTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
