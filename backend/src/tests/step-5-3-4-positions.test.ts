/**
 * Step 5.3.4 — Position API tests
 * Tests: GET /api/orbital-sync/positions
 */
import http from "http";
import { app } from "../app";
import { db } from "../db/client";
import { satellites, satelliteOrbitalData, groundStations } from "../db/schema";
import { sql } from "drizzle-orm";

function request(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port: 13002,
      path,
      method: "GET",
    };
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function runTests() {
  console.log("=== STEP 5.3.4 POSITION API TESTS ===\n");

  const server = app.listen(13002);
  await new Promise((r) => setTimeout(r, 300));

  let passed = 0;
  let failed = 0;

  const assert = (label: string, cond: boolean, detail?: string) => {
    if (cond) { console.log(`  ✓ ${label}`); passed++; }
    else { console.log(`  ✗ ${label}${detail ? ` (${detail})` : ""}`); failed++; }
  };

  // --- Test 1: Empty DB returns empty array ---
  console.log("Test 1: /api/orbital-sync/positions with empty DB");
  const t1 = await request("/api/orbital-sync/positions");
  assert("HTTP 200", t1.status === 200);
  assert("Returns array", Array.isArray(t1.body));
  assert("Empty when no satellite orbital data", t1.body.length === 0);
  console.log();

  // --- Test 2: Invalid time returns 400 ---
  console.log("Test 2: Invalid time parameter returns 400");
  const t2 = await request("/api/orbital-sync/positions?time=not-a-date");
  assert("HTTP 400", t2.status === 400);
  assert("Error field present", "error" in t2.body);
  console.log();

  // --- Test 3: Seed real TLE data, verify position is computed ---
  console.log("Test 3: Real TLE → position computed correctly");

  // Seed a real satellite + TLE (ISS TLE from Step 3 reference fixture)
  const satRows = await db.insert(satellites).values({
    noradId: 25544,
    name: "ISS (ZARYA)",
    status: "ACTIVE",
  }).returning();

  const satId = satRows[0]!.id;

  await db.insert(satelliteOrbitalData).values({
    satelliteId: satId,
    source: "CELESTRAK",
    tleLine1: "1 25544U 98067A   26226.84521785  .00003058  00000-0  63667-4 0  9997",
    tleLine2: "2 25544  51.6441 230.1408 0004381 292.0000  99.8091 15.48911520306161",
    tleEpoch: new Date("2026-08-14T20:17:07Z"),
    receivedAt: new Date(),
  });

  // Request positions at a fixed time close to the epoch
  const t3 = await request("/api/orbital-sync/positions?time=2026-08-16T17:00:00Z");
  assert("HTTP 200", t3.status === 200);
  assert("Returns array", Array.isArray(t3.body));
  assert("Contains ISS position", t3.body.length === 1);

  if (t3.body.length > 0) {
    const iss = t3.body[0];
    assert("Has satelliteId", typeof iss.satelliteId === "string");
    assert("Has noradId = 25544", iss.noradId === 25544);
    assert("Has name", iss.name === "ISS (ZARYA)");
    assert("latitude in range [-90, 90]", iss.latitude >= -90 && iss.latitude <= 90);
    assert("longitude in range [-180, 180]", iss.longitude >= -180 && iss.longitude <= 180);
    assert("altitudeKm > 0", iss.altitudeKm > 0);
    assert("altitudeKm < 500 (LEO)", iss.altitudeKm < 500);
    assert("source = CELESTRAK", iss.source === "CELESTRAK");
    assert("tleEpoch present", typeof iss.tleEpoch === "string");
    assert("referenceTime echoed", iss.referenceTime === "2026-08-16T17:00:00.000Z");
  }
  console.log();

  // --- Test 4: No time param → uses current time (returns valid array) ---
  console.log("Test 4: No time param → uses current time");
  const t4 = await request("/api/orbital-sync/positions");
  assert("HTTP 200", t4.status === 200);
  assert("Returns array with ISS", t4.body.length >= 1);
  if (t4.body.length > 0) {
    const ref = t4.body[0].referenceTime;
    const delta = Math.abs(new Date(ref).getTime() - Date.now());
    assert("referenceTime is close to now (within 5s)", delta < 5000, `delta=${delta}ms`);
  }
  console.log();

  // --- Test 5: Verify geodetic values are physically plausible for GEO sat ---
  console.log("Test 5: GEO satellite altitude > 35,000 km");
  const geoSat = await db.insert(satellites).values({
    noradId: 43226, name: "GOES 17", status: "ACTIVE",
  }).returning();

  // GOES 17 (real TLE, GEO)
  await db.insert(satelliteOrbitalData).values({
    satelliteId: geoSat[0]!.id,
    source: "CELESTRAK",
    tleLine1: "1 43226U 18022A   26228.72810185 -.00000320  00000-0  00000-0 0  9993",
    tleLine2: "2 43226   0.0151  58.6684 0000618 268.9600 118.4000  1.00272136 30386",
    tleEpoch: new Date("2026-08-16T17:28:30Z"),
    receivedAt: new Date(),
  });

  const t5 = await request("/api/orbital-sync/positions?time=2026-08-16T17:00:00Z");
  assert("HTTP 200", t5.status === 200);
  const goes = t5.body.find((s: any) => s.noradId === 43226);
  if (goes) {
    assert("GOES 17 altitudeKm > 35000 (GEO)", goes.altitudeKm > 35000, `got ${goes.altitudeKm}`);
    assert("GOES 17 latitude near equator (|lat| < 2°)", Math.abs(goes.latitude) < 2, `lat=${goes.latitude}`);
  } else {
    assert("GOES 17 present in results", false, "not found in response");
  }
  console.log();

  server.close();
  console.log("─".repeat(40));
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  if (failed > 0) process.exit(1);
  else process.exit(0);
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
