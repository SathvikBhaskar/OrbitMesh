import "dotenv/config";
import assert from "assert";
import { OrbitalDataIngestionService } from "../modules/orbital-data/services/ingestion-service";
import { OrbitalDataProvider, NewSatellite, NewSatelliteOrbitalData } from "../modules/data-providers/orbital-data-provider";
import { db } from "../db/client";
import { satellites, satelliteOrbitalData } from "../db/schema";
import { resetDb } from "../db/seed";

class MockProvider implements OrbitalDataProvider {
  public sats: NewSatellite[] = [];
  public data: NewSatelliteOrbitalData[] = [];

  async getSatellites(): Promise<NewSatellite[]> {
    return this.sats;
  }
  async getGroundStations() {
    return [];
  }
  async getOrbitalData(satelliteIds: string[]): Promise<NewSatelliteOrbitalData[]> {
    // Ensure the data corresponds to satelliteIds in order
    return this.data.map((d, i) => ({ ...d, satelliteId: satelliteIds[i]! }));
  }
}

async function runTests() {
  console.log("=== ORBITAL DATA INGESTION SERVICE TESTS ===");

  await resetDb();

  const mockProvider = new MockProvider();
  const service = new OrbitalDataIngestionService(mockProvider);

  // 1. Initial Ingestion (Discovery)
  const baseEpoch = new Date("2026-08-16T10:00:00Z");
  
  mockProvider.sats = [{ noradId: 1001, name: "TEST-SAT-1", status: "ACTIVE" }];
  mockProvider.data = [{
    satelliteId: "temp",
    source: "CELESTRAK",
    tleLine1: "LINE1",
    tleLine2: "LINE2",
    tleEpoch: baseEpoch,
    receivedAt: new Date()
  }];

  const rep1 = await service.ingest();
  console.log("rep1:", rep1);
  assert.strictEqual(rep1.fetchedCount, 1);
  assert.strictEqual(rep1.discoveredCount, 1);
  assert.strictEqual(rep1.updatedCount, 1);
  assert.strictEqual(rep1.ignoredCount, 0);
  assert.strictEqual(rep1.rejectedCount, 0);
  assert.strictEqual(rep1.updatedSatelliteIds.length, 1);
  console.log("✅ Initial ingestion (discovery) works");

  // 2. Ignore (Same Epoch)
  const rep2 = await service.ingest();
  assert.strictEqual(rep2.discoveredCount, 0);
  assert.strictEqual(rep2.updatedCount, 0);
  assert.strictEqual(rep2.ignoredCount, 1);
  assert.strictEqual(rep2.rejectedCount, 0);
  console.log("✅ Ignore exact same epoch works");

  // 3. Reject (Older Epoch)
  mockProvider.data[0]!.tleEpoch = new Date("2026-08-16T08:00:00Z");
  const rep3 = await service.ingest();
  assert.strictEqual(rep3.updatedCount, 0);
  assert.strictEqual(rep3.ignoredCount, 0);
  assert.strictEqual(rep3.rejectedCount, 1);
  console.log("✅ Reject older epoch works");

  // 4. Update (Newer Epoch)
  mockProvider.data[0]!.tleEpoch = new Date("2026-08-16T12:00:00Z");
  const rep4 = await service.ingest();
  assert.strictEqual(rep4.updatedCount, 1);
  assert.strictEqual(rep4.ignoredCount, 0);
  assert.strictEqual(rep4.rejectedCount, 0);
  console.log("✅ Update newer epoch works");

  // 5. Concurrency Test
  console.log("Running Concurrency Test...");
  // Provide a newer epoch for both concurrent runs
  mockProvider.data[0]!.tleEpoch = new Date("2026-08-16T14:00:00Z");
  
  const [repA, repB] = await Promise.all([
    service.ingest(),
    service.ingest()
  ]);

  // Because of race conditions, one will insert and the other might ignore (if the first finishes DB insert before the second queries)
  // OR both might try to insert and one hits the ON CONFLICT DO NOTHING.
  // We just need to verify exactly 1 new orbital record was inserted and total satellites in DB is still 1.
  const dbSats = await db.select().from(satellites);
  const dbOrbits = await db.select().from(satelliteOrbitalData);

  assert.strictEqual(dbSats.length, 1, "Only one satellite should exist in DB");
  assert.strictEqual(dbOrbits.length, 3, "Only three orbital records should exist (10:00, 12:00, 14:00)");
  console.log("✅ Concurrency handled gracefully");

  console.log("\nAll Ingestion Service Tests Passed!");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
