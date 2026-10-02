import "dotenv/config";
import assert from "assert";
import { IncrementalContactWindowService } from "../modules/contact-windows/incremental-contact-window-service";
import { ContactWindowService } from "../modules/contact-windows/contact-window-service";
import { db } from "../db/client";
import { satellites, groundStations, satelliteOrbitalData, contactWindows } from "../db/schema";
import { resetDb } from "../db/seed";
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";

async function runTests() {
  console.log("=== INCREMENTAL REGENERATION TESTS ===");

  await resetDb();

  const cws = new ContactWindowService();
  const incService = new IncrementalContactWindowService(cws);
  const refTime = new Date("2026-08-16T10:00:00Z");

  // Setup DB
  const stationId = randomUUID();
  await db.insert(groundStations).values({
    id: stationId,
    code: "TEST-GS",
    name: "Test GS",
    latitude: 0,
    longitude: 0,
    minimumElevationDeg: 10,
    status: "AVAILABLE",
  });

  const satA = randomUUID();
  const satB = randomUUID();
  const satC = randomUUID();

  await db.insert(satellites).values([
    { id: satA, noradId: 1001, name: "SAT-A", status: "ACTIVE" },
    { id: satB, noradId: 1002, name: "SAT-B", status: "ACTIVE" },
    { id: satC, noradId: 1003, name: "SAT-C", status: "ACTIVE" },
  ]);

  // Provide initial orbital data for them
  // We need realistic TLEs so physics engine can actually generate windows, otherwise it might fail or return 0 windows.
  // We'll use ISS TLE for all just for testing mechanics
  const tle1 = "1 25544U 98067A   21274.84521785  .00003058  00000-0  63667-4 0  9997";
  const tle2 = "2 25544  51.6444 329.1352 0004381 184.2854 286.0759 15.48833446305141";
  
  await db.insert(satelliteOrbitalData).values([
    { id: randomUUID(), satelliteId: satA, source: "CELESTRAK", tleLine1: tle1, tleLine2: tle2, tleEpoch: refTime, receivedAt: new Date() },
    { id: randomUUID(), satelliteId: satB, source: "CELESTRAK", tleLine1: tle1, tleLine2: tle2, tleEpoch: refTime, receivedAt: new Date() },
    { id: randomUUID(), satelliteId: satC, source: "CELESTRAK", tleLine1: tle1, tleLine2: tle2, tleEpoch: refTime, receivedAt: new Date() },
  ]);

  // Helper to count windows per satellite
  const getWindowCounts = async () => {
    const res = await db.execute(sql`SELECT satellite_id, count(*) as c FROM contact_windows GROUP BY satellite_id`);
    const counts = new Map<string, number>();
    for (const r of res.rows) counts.set(r.satellite_id as string, parseInt(r.c as string, 10));
    return counts;
  };

  // Test 1: No changes
  const t1Count = await incService.regenerateForSatellites([], refTime, 24);
  assert.strictEqual(t1Count, 0, "Test 1 Failed: Should be 0");
  console.log("✅ Test 1 — No changes (0 regenerated)");

  // Test 2: One satellite changed
  const t2Count = await incService.regenerateForSatellites([satA], refTime, 24);
  assert.ok(t2Count > 0, "Test 2 Failed: Should generate windows for SAT-A");
  const counts2 = await getWindowCounts();
  assert.strictEqual(counts2.get(satA), t2Count, "SAT-A should have windows");
  assert.strictEqual(counts2.get(satB) || 0, 0, "SAT-B should have 0 windows");
  assert.strictEqual(counts2.get(satC) || 0, 0, "SAT-C should have 0 windows");
  console.log(`✅ Test 2 — One satellite changed (SAT-A: ${t2Count} windows)`);

  // Test 3: Multiple satellites changed
  const t3Count = await incService.regenerateForSatellites([satA, satC], refTime, 24);
  // Note: SAT-A will be skipped essentially since ContactWindowService prevents duplicate DB inserts, 
  // but it might still return the count of windows. Let's see:
  // generateContactWindows returns the generated array, so t3Count is total *attempted* generations.
  // Actually, wait, it returns `results` which has length of windows. So t3Count should be > 0.
  assert.ok(t3Count > 0, "Test 3 Failed: Should generate windows");
  const counts3 = await getWindowCounts();
  assert.strictEqual(counts3.get(satC), t2Count, "SAT-C should have same number of windows as SAT-A");
  assert.strictEqual(counts3.get(satA), t2Count, "SAT-A windows should not duplicate");
  assert.strictEqual(counts3.get(satB) || 0, 0, "SAT-B should still have 0");
  console.log(`✅ Test 3 — Multiple satellites changed (SAT-A/SAT-C generated)`);

  // Test 4: Idempotency
  await incService.regenerateForSatellites([satA], refTime, 24);
  const counts4 = await getWindowCounts();
  assert.strictEqual(counts4.get(satA), t2Count, "Test 4 Failed: Windows duplicated!");
  console.log("✅ Test 4 — Idempotency (no duplicate windows)");

  // Test 5: Concurrency
  // First clear contact windows to strictly test concurrent generation/insertion
  await db.execute(sql`DELETE FROM contact_windows WHERE satellite_id = ${satB}`);
  await Promise.all([
    incService.regenerateForSatellites([satB], refTime, 24),
    incService.regenerateForSatellites([satB], refTime, 24)
  ]);
  const counts5 = await getWindowCounts();
  assert.strictEqual(counts5.get(satB), t2Count, "Test 5 Failed: Concurrent generation caused duplicates!");
  console.log("✅ Test 5 — Concurrency (Promise.all safe)");

  console.log("\nAll Incremental Regeneration Tests Passed!");
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
