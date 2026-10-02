import "dotenv/config";
import { db } from "../db/client";
import { satellites, groundStations, satelliteOrbitalData, contactWindows } from "../db/schema";
import { eq } from "drizzle-orm";
import { ContactWindowService } from "../modules/contact-windows/contact-window-service";
import assert from "assert";
import crypto from "crypto";

// Frozen orbital snapshots (TLEs) for deterministic validation
// NOAA-19 (LEO, Polar) - Will have multiple passes over polar stations
const NOAA_19_TLE1 = "1 33591U 09005A   26228.12345678  .00000123  00000+0  12345-4 0  9997";
const NOAA_19_TLE2 = "2 33591  99.1234 123.4567 0012345 345.6789  12.3456 14.12345678123456";

// GOES-17 (GEO, positioned over Pacific) - Will have ZERO visibility from Svalbard (Norway)
const GOES_17_TLE1 = "1 43226U 18022A   26228.12345678  .00000000  00000-0  00000-0 0  9998";
const GOES_17_TLE2 = "2 43226   0.0213 285.5451 0002134 185.0001 270.1234  1.00270000 12341";

// Mock Ground Station: KSAT Svalbard (78.2297N)
const KSAT_SVAL = {
  id: crypto.randomUUID(),
  code: "KSAT-SVAL",
  name: "KSAT Svalbard",
  latitude: 78.2297,
  longitude: 15.4077,
  altitudeM: 400,
  minimumElevationDeg: 10,
  status: "AVAILABLE" as const
};

import { resetDb } from "../db/seed";

async function setupFixtures() {
  await resetDb();

  const noaaId = crypto.randomUUID();
  const goesId = crypto.randomUUID();

  // 1. Insert Ground Station
  await db.insert(groundStations).values(KSAT_SVAL);

  // 2. Insert Satellites
  await db.insert(satellites).values([
    { id: noaaId, noradId: 33591, name: "NOAA-19", status: "ACTIVE" },
    { id: goesId, noradId: 43226, name: "GOES-17", status: "ACTIVE" }
  ]);

  // 3. Insert Orbital Data (Frozen reference time: 2026-08-16T00:00:00Z)
  const epoch = new Date("2026-08-16T00:00:00Z");
  const noaaDataId = crypto.randomUUID();
  const goesDataId = crypto.randomUUID();
  
  await db.insert(satelliteOrbitalData).values([
    {
      id: noaaDataId,
      satelliteId: noaaId,
      source: "CELESTRAK",
      tleLine1: NOAA_19_TLE1,
      tleLine2: NOAA_19_TLE2,
      tleEpoch: epoch,
      receivedAt: epoch
    },
    {
      id: goesDataId,
      satelliteId: goesId,
      source: "CELESTRAK",
      tleLine1: GOES_17_TLE1,
      tleLine2: GOES_17_TLE2,
      tleEpoch: epoch,
      receivedAt: epoch
    }
  ]);

  return { noaaId, goesId, stationId: KSAT_SVAL.id };
}

async function cleanupFixtures(ids: { noaaId: string, goesId: string, stationId: string }) {
  await db.delete(contactWindows).where(eq(contactWindows.groundStationId, ids.stationId));
  await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, ids.noaaId));
  await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, ids.goesId));
  await db.delete(satellites).where(eq(satellites.id, ids.noaaId));
  await db.delete(satellites).where(eq(satellites.id, ids.goesId));
  await db.delete(groundStations).where(eq(groundStations.id, ids.stationId));
}

async function runTests() {
  console.log("=== DETERMINISTIC REAL CONTACT-WINDOW VALIDATION ===");
  const service = new ContactWindowService();
  const fixtures = await setupFixtures();
  
  const start = new Date("2026-08-16T00:00:00Z");
  const end = new Date("2026-08-17T00:00:00Z"); // 24 hour horizon
  const stepSeconds = 60;

  try {
    console.log("Testing NOAA-19 (Valid Passes Expected)...");
    const noaaResult1 = await service.generateContactWindows(fixtures.noaaId, fixtures.stationId, start, end, stepSeconds);
    const windows1 = noaaResult1.windows;
    
    assert(windows1.length > 0, "NOAA-19 should have visible passes over Svalbard");
    console.log(`NOAA-19 generated ${windows1.length} contact windows.`);

    for (const w of windows1) {
      assert(w.aos.getTime() < w.los.getTime(), `AOS must be strictly before LOS: ${w.aos.toISOString()} >= ${w.los.toISOString()}`);
      assert(w.durationSeconds > 0, "Duration must be positive");
      assert(w.maxElevationDeg >= KSAT_SVAL.minimumElevationDeg, `Elevation ${w.maxElevationDeg} is below mask ${KSAT_SVAL.minimumElevationDeg}`);
      assert(w.aos.getTime() >= start.getTime() && w.los.getTime() <= end.getTime(), "Window falls outside the propagation horizon");
      assert.strictEqual(w.satelliteId, fixtures.noaaId, "Foreign key validation failed");
      assert.strictEqual(w.groundStationId, fixtures.stationId, "Foreign key validation failed");
      // Check timestamp validity
      assert(!isNaN(w.aos.getTime()), "AOS timestamp invalid");
      assert(!isNaN(w.los.getTime()), "LOS timestamp invalid");
    }

    console.log("Testing Idempotency (Repeated Generation)...");
    const noaaResult2 = await service.generateContactWindows(fixtures.noaaId, fixtures.stationId, start, end, stepSeconds);
    const windows2 = noaaResult2.windows;
    
    assert.strictEqual(windows1.length, windows2.length, "Repeated execution must yield identical number of windows");
    for (let i = 0; i < windows1.length; i++) {
      assert.strictEqual(windows1[i]!.aos.toISOString(), windows2[i]!.aos.toISOString(), "Idempotency failed on AOS");
      assert.strictEqual(windows1[i]!.los.toISOString(), windows2[i]!.los.toISOString(), "Idempotency failed on LOS");
      assert.strictEqual(windows1[i]!.id, windows2[i]!.id, "Idempotency failed: record duplicated instead of returned");
    }

    console.log("Testing GOES-17 (Zero-Visibility Case Expected)...");
    const goesResult = await service.generateContactWindows(fixtures.goesId, fixtures.stationId, start, end, stepSeconds);
    assert.strictEqual(goesResult.windows.length, 0, "GOES-17 should NOT be visible from Svalbard");
    console.log("✅ Zero-visibility cleanly handled (0 windows generated).");

    console.log("\n✅ ALL VALIDATION INVARIANTS PASSED.");
  } finally {
    await cleanupFixtures(fixtures);
  }
}

runTests().then(() => process.exit(0)).catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
