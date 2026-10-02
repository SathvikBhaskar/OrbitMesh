import "dotenv/config";
import { IncrementalContactWindowService } from "../modules/contact-windows/incremental-contact-window-service";
import { ContactWindowService } from "../modules/contact-windows/contact-window-service";
import { RealOrbitalDataProvider } from "../modules/data-providers/real-provider";
import { db } from "../db/client";
import { satellites, groundStations, satelliteOrbitalData } from "../db/schema";
import { sql } from "drizzle-orm";

import { randomUUID } from "crypto";

async function runBenchmark() {
  console.log("=== REGENERATION BENCHMARK ===");
  
  // NOTE: This assumes the database is already populated with 1000 satellites and 4 ground stations 
  // from the Step 4 benchmark. If not, we will just use whatever is in DB.
  let dbSats = await db.select({ id: satellites.id }).from(satellites);
  const dbStations = await db.select().from(groundStations);

  if (dbSats.length < 1000) {
    console.log("Seeding 1000 satellites for benchmark...");
    
    // Create 4 ground stations if none exist
    if (dbStations.length === 0) {
      const stations = [];
      for (let i = 0; i < 4; i++) {
        stations.push({
          id: randomUUID(),
          code: `GS-${i}`,
          name: `Ground Station ${i}`,
          latitude: 0,
          longitude: i * 10,
          minimumElevationDeg: 10,
          status: "AVAILABLE" as const,
        });
      }
      await db.insert(groundStations).values(stations);
    }

    // Create 1000 sats and orbital data in batches
    const tle1 = "1 25544U 98067A   21274.84521785  .00003058  00000-0  63667-4 0  9997";
    const tle2 = "2 25544  51.6444 329.1352 0004381 184.2854 286.0759 15.48833446305141";
    
    const batchSize = 100;
    for (let i = 0; i < 1000; i += batchSize) {
      const sats = [];
      const obs = [];
      for (let j = 0; j < batchSize; j++) {
        const satId = randomUUID();
        sats.push({
          id: satId,
          noradId: 10000 + i + j,
          name: `SAT-${10000 + i + j}`,
          status: "ACTIVE" as const,
        });
        obs.push({
          id: randomUUID(),
          satelliteId: satId,
          source: "CELESTRAK" as const,
          tleLine1: tle1,
          tleLine2: tle2,
          tleEpoch: new Date("2026-08-16T10:00:00Z"),
          receivedAt: new Date(),
        });
      }
      await db.insert(satellites).values(sats);
      await db.insert(satelliteOrbitalData).values(obs);
    }
    
    // Refresh lists
    dbSats = await db.select({ id: satellites.id }).from(satellites);
  }

  if (dbStations.length === 0) {
    throw new Error("No ground stations found in DB!");
  }

  const allSatIds = dbSats.map(s => s.id);
  // Pick exactly 20 satellites for the incremental run
  const subsetSatIds = allSatIds.slice(0, 20);
  
  const cws = new ContactWindowService();
  const incService = new IncrementalContactWindowService(cws);
  const refTime = new Date("2026-08-16T10:00:00Z");

  // To measure clean DB insert performance in full vs incremental, we could clear windows.
  // The user wants to see the actual runtime difference.
  
  console.log(`\nStarting Full Regeneration (${allSatIds.length} satellites)...`);
  await db.execute(sql`DELETE FROM contact_windows`);
  const tFullStart = performance.now();
  await incService.regenerateForSatellites(allSatIds, refTime, 24);
  const tFullEnd = performance.now();
  const fullMs = tFullEnd - tFullStart;
  console.log(`Full Regeneration took: ${(fullMs / 1000).toFixed(2)} s`);

  console.log(`\nStarting Incremental Regeneration (${subsetSatIds.length} satellites)...`);
  await db.execute(sql`DELETE FROM contact_windows`);
  const tIncStart = performance.now();
  await incService.regenerateForSatellites(subsetSatIds, refTime, 24);
  const tIncEnd = performance.now();
  const incMs = tIncEnd - tIncStart;
  console.log(`Incremental Regeneration took: ${(incMs / 1000).toFixed(2)} s`);

  const speedup = fullMs / incMs;

  console.log("\n=== SUMMARY ===");
  console.log(`Full:        ${(fullMs / 1000).toFixed(2)} s`);
  console.log(`Incremental: ${(incMs / 1000).toFixed(2)} s`);
  console.log(`Speedup:     ${speedup.toFixed(2)}x`);
}

runBenchmark().catch(err => {
  console.error(err);
  process.exit(1);
});
