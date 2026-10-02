/**
 * Step 5.3.3 — API endpoint tests
 * Tests: GET /api/orbital-sync/status, GET /api/orbital-sync/runs, GET /api/satellites
 */
import { db } from "../db/client";
import { orbitalSyncRuns, satellites, groundStations } from "../db/schema";
import { sql } from "drizzle-orm";
import http from "http";
import { app } from "../app";

function request(path: string, method = "GET", body?: object): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: "127.0.0.1",
      port: 13001,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      }
    };
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runTests() {
  console.log("=== STEP 5.3.3 API ENDPOINT TESTS ===\n");

  // Start the app
  const server = app.listen(13001);
  await new Promise(r => setTimeout(r, 300));

  let passed = 0;
  let failed = 0;

  const assert = (label: string, cond: boolean, detail?: string) => {
    if (cond) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.log(`  ✗ ${label}${detail ? ` (${detail})` : ""}`);
      failed++;
    }
  };

  // ---------------------------
  // Test 1: GET /api/orbital-sync/status — empty DB
  // ---------------------------
  console.log("Test 1: GET /api/orbital-sync/status (empty DB)");
  const t1 = await request("/api/orbital-sync/status");
  assert("HTTP 200", t1.status === 200);
  assert("lastSync is null (no runs)", t1.body.lastSync === null);
  assert("satelliteCount is 0", t1.body.satelliteCount === 0);
  assert("contactWindowCount is 0", t1.body.contactWindowCount === 0);
  console.log();

  // ---------------------------
  // Test 2: GET /api/orbital-sync/runs — empty list
  // ---------------------------
  console.log("Test 2: GET /api/orbital-sync/runs (empty)");
  const t2 = await request("/api/orbital-sync/runs");
  assert("HTTP 200", t2.status === 200);
  assert("Returns array", Array.isArray(t2.body));
  assert("Empty array", t2.body.length === 0);
  console.log();

  // ---------------------------
  // Test 3: Seed a completed sync run, then check /status
  // ---------------------------
  console.log("Test 3: /api/orbital-sync/status after a SUCCESS run is seeded");
  await db.insert(orbitalSyncRuns).values({
    startedAt: new Date("2026-08-16T10:00:00Z"),
    completedAt: new Date("2026-08-16T10:00:15Z"),
    status: "SUCCESS",
    provider: "RealOrbitalDataProvider",
    fetchedCount: 500,
    discoveredCount: 2,
    updatedCount: 12,
    ignoredCount: 486,
    rejectedCount: 0,
    regeneratedSatelliteCount: 12,
    regeneratedWindowCount: 193,
  });

  const t3 = await request("/api/orbital-sync/status");
  assert("HTTP 200", t3.status === 200);
  assert("lastSync is not null", t3.body.lastSync !== null);
  assert("lastSync.status is SUCCESS", t3.body.lastSync?.status === "SUCCESS");
  assert("lastSync.fetchedCount is 500", t3.body.lastSync?.fetchedCount === 500);
  console.log();

  // ---------------------------
  // Test 4: GET /api/orbital-sync/runs shows the seeded run
  // ---------------------------
  console.log("Test 4: GET /api/orbital-sync/runs lists the seeded run");
  const t4 = await request("/api/orbital-sync/runs");
  assert("HTTP 200", t4.status === 200);
  assert("One run returned", t4.body.length === 1);
  assert("Run status is SUCCESS", t4.body[0]?.status === "SUCCESS");
  console.log();

  // ---------------------------
  // Test 5: GET /api/satellites — empty, returns array
  // ---------------------------
  console.log("Test 5: GET /api/satellites (empty DB)");
  const t5 = await request("/api/satellites");
  assert("HTTP 200", t5.status === 200);
  assert("Returns array", Array.isArray(t5.body));
  console.log();

  // ---------------------------
  // Test 6: Seed satellite rows, check /api/satellites returns tleEpoch + source
  // ---------------------------
  console.log("Test 6: GET /api/satellites returns tleEpoch and source fields");
  await db.insert(satellites).values([
    { noradId: 99001, name: "TEST-SAT-A", status: "ACTIVE" },
    { noradId: 99002, name: "TEST-SAT-B", status: "ACTIVE" },
  ]);

  const t6 = await request("/api/satellites");
  assert("HTTP 200", t6.status === 200);
  assert("Returns 2 satellites", t6.body.length === 2);
  assert("Each row has noradId field", t6.body.every((r: any) => r.noradId != null));
  assert("Each row has source field (null if no OD)", t6.body.every((r: any) => "source" in r));
  assert("Each row has tleEpoch field (null if no OD)", t6.body.every((r: any) => "tleEpoch" in r));
  console.log();

  // ---------------------------
  // Test 7: POST /api/orbital-sync — without a real provider it will fail gracefully
  // ---------------------------
  console.log("Test 7: POST /api/orbital-sync (no CelesTrak in test env) returns 500 FAILED");
  const t7 = await request("/api/orbital-sync", "POST", {});
  // Will fail because no real satellite data in test DB, but must return structured response
  assert("Returns a structured response (not a crash)", typeof t7.body === "object");
  assert("Status field is present", "status" in t7.body);
  console.log();

  // Cleanup
  server.close();

  console.log("─".repeat(40));
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  if (failed > 0) process.exit(1);
  else process.exit(0);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
