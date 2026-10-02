import { OrbitalSyncService } from "../modules/orbital-data/services/orbital-sync-service";
import { OrbitalDataIngestionService } from "../modules/orbital-data/services/ingestion-service";
import { IncrementalContactWindowService } from "../modules/contact-windows/incremental-contact-window-service";
import { ContactWindowService } from "../modules/contact-windows/contact-window-service";
import { OrbitalDataProvider, NewSatellite, NewGroundStation, NewSatelliteOrbitalData } from "../modules/data-providers/orbital-data-provider";
import { db } from "../db/client";
import { satellites, satelliteOrbitalData, groundStations, contactWindows, orbitalSyncRuns } from "../db/schema";
import { randomUUID } from "crypto";

class MockProvider implements OrbitalDataProvider {
  public sats: NewSatellite[] = [];
  public data: NewSatelliteOrbitalData[] = [];
  public shouldFail = false;
  
  async getSatellites(): Promise<NewSatellite[]> {
    if (this.shouldFail) throw new Error("CelesTrak timeout");
    return this.sats;
  }
  
  async getGroundStations(): Promise<NewGroundStation[]> {
    return [];
  }
  
  async getOrbitalData(satelliteIds: string[]): Promise<NewSatelliteOrbitalData[]> {
    if (this.shouldFail) throw new Error("CelesTrak timeout");
    // map correctly 
    return this.data.map((d, i) => ({...d, satelliteId: satelliteIds[i]}));
  }
}

async function runTests() {
  console.log("=== ORBITAL SYNC SERVICE TESTS ===\n");
  
  // Cleanup
  await db.execute('TRUNCATE contact_windows CASCADE;');
  await db.execute('TRUNCATE satellite_orbital_data CASCADE;');
  await db.execute('TRUNCATE satellites CASCADE;');
  await db.execute('TRUNCATE ground_stations CASCADE;');
  await db.execute('TRUNCATE orbital_sync_runs CASCADE;');

  // Setup GS
  const gsId = randomUUID();
  await db.insert(groundStations).values({
    id: gsId,
    code: "TEST-GS",
    name: "Test GS",
    latitude: 0,
    longitude: 0,
    minimumElevationDeg: 10,
    status: "AVAILABLE"
  });

  const mockProvider = new MockProvider();
  const ingestionService = new OrbitalDataIngestionService(mockProvider);
  const incrementalService = new IncrementalContactWindowService(new ContactWindowService());
  const syncService = new OrbitalSyncService(mockProvider, ingestionService, incrementalService);
  
  const refTime = new Date("2026-08-16T00:00:00Z");

  // Initial load
  const epoch1 = new Date("2026-08-16T00:00:00Z");
  for (let i = 0; i < 100; i++) {
    mockProvider.sats.push({ noradId: 1000 + i, name: `SAT-${i}`, status: "ACTIVE" });
    mockProvider.data.push({
      satelliteId: "temp",
      source: "CELESTRAK",
      tleLine1: "1 25544U 98067A   21274.84521785  .00003058  00000-0  63667-4 0  9997",
      tleLine2: "2 25544  51.6441 230.1408 0004381 292.0000  99.8091 15.48911520306161",
      tleEpoch: epoch1,
      receivedAt: new Date()
    });
  }
  
  await syncService.sync(refTime, 24);
  
  // --- Test 1: No changes ---
  console.log("Test 1: No changes (CelesTrak -> same epochs)");
  const res1 = await syncService.sync(refTime, 24);
  console.log(`Status: ${res1.status}`);
  console.log(`Updated: ${res1.report?.updatedCount} (Expected 0)`);
  console.log(`Regenerated: ${res1.report?.regeneratedWindowCount} (Expected 0)`);
  console.log("Result: " + (res1.report?.updatedCount === 0 ? "PASS" : "FAIL") + "\n");

  // --- Test 2: Changed satellites ---
  console.log("Test 2: Changed satellites (100 sats, 10 new epochs)");
  const epoch2 = new Date("2026-08-16T12:00:00Z");
  for (let i = 0; i < 10; i++) {
    mockProvider.data[i].tleEpoch = epoch2;
  }
  const res2 = await syncService.sync(refTime, 24);
  console.log(`Status: ${res2.status}`);
  console.log(`Updated: ${res2.report?.updatedCount} (Expected 10)`);
  // Regeneration count should be > 0 (each of the 10 sats might have 1 or more windows over 1 hour)
  console.log(`Regenerated: ${res2.report?.regeneratedWindowCount} (Expected > 0)`);
  console.log("Result: " + (res2.report?.updatedCount === 10 ? "PASS" : "FAIL") + "\n");

  // --- Test 3: CelesTrak failure ---
  console.log("Test 3: CelesTrak failure (sync = FAILED, existing data preserved)");
  mockProvider.shouldFail = true;
  const beforeCountData = await db.select().from(satelliteOrbitalData);
  const beforeCountWindows = await db.select().from(contactWindows);
  
  const res3 = await syncService.sync(refTime, 24);
  
  const afterCountData = await db.select().from(satelliteOrbitalData);
  const afterCountWindows = await db.select().from(contactWindows);
  
  console.log(`Status: ${res3.status} (Expected FAILED)`);
  console.log(`Data count before/after: ${beforeCountData.length} / ${afterCountData.length}`);
  console.log(`Windows count before/after: ${beforeCountWindows.length} / ${afterCountWindows.length}`);
  console.log("Result: " + (res3.status === "FAILED" && beforeCountData.length === afterCountData.length ? "PASS" : "FAIL") + "\n");

  // --- Test 4: Concurrent sync ---
  console.log("Test 4: Concurrent sync (one executes, one SKIPPED)");
  mockProvider.shouldFail = false;
  // Make fetch slightly slow so they overlap
  const oldGet = mockProvider.getSatellites.bind(mockProvider);
  mockProvider.getSatellites = async () => {
    await new Promise(r => setTimeout(r, 200));
    return oldGet();
  };

  const p1 = syncService.sync(refTime, 24);
  const p2 = syncService.sync(refTime, 24);
  
  const [res4a, res4b] = await Promise.all([p1, p2]);
  const statuses = [res4a.status, res4b.status];
  console.log(`Statuses: ${statuses.join(", ")}`);
  const hasSkipped = statuses.includes("SKIPPED_ALREADY_RUNNING");
  console.log("Result: " + (hasSkipped ? "PASS" : "FAIL") + "\n");

  // --- Test 5: Recovery ---
  console.log("Test 5: Recovery (failure then success)");
  
  // reset mock
  mockProvider.getSatellites = oldGet;
  
  mockProvider.shouldFail = true;
  const res5Fail = await syncService.sync(refTime, 24);
  
  mockProvider.shouldFail = false;
  const epoch3 = new Date("2026-08-16T18:00:00Z");
  mockProvider.data[0].tleEpoch = epoch3;
  const res5Success = await syncService.sync(refTime, 24);
  
  console.log(`Fail sync status: ${res5Fail.status} (Expected FAILED)`);
  console.log(`Success sync status: ${res5Success.status} (Expected SUCCESS)`);
  console.log(`Success updated: ${res5Success.report?.updatedCount} (Expected 1)`);
  console.log("Result: " + (res5Success.status === "SUCCESS" && res5Success.report?.updatedCount === 1 ? "PASS" : "FAIL") + "\n");

  process.exit(0);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
