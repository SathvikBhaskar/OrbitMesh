import "dotenv/config";
import { db } from "../db/client";
import { resetDb, runSeed } from "../db/seed";
import { ContactWindowService } from "../modules/contact-windows/contact-window-service";
import { satellites, groundStations } from "../db/schema";
import { eq } from "drizzle-orm";

async function runLiveContactWindowTest() {
  console.log("=== STEP 3: REAL CONTACT WINDOW INSPECTION REPORT ===");
  console.log("⚠️ This test requires internet access to CelesTrak.");
  
  // Set environment to real mode
  process.env.DATA_PROVIDER = "real";
  process.env.CELESTRAK_MAX_SATELLITES = "10";
  process.env.CELESTRAK_GROUP = "weather";
  process.env.CELESTRAK_FORMAT = "json";

  // 1. Ingest real orbital data
  console.log("\n[1] Ingesting real satellite data and KSAT ground stations...");
  await runSeed();

  // 2. Fetch ingested data
  const sats = await db.select().from(satellites);
  const stations = await db.select().from(groundStations);

  console.log(`\n[2] Execution Parameters:`);
  console.log(`    Satellites Processed: ${sats.length}`);
  console.log(`    Stations Processed: ${stations.length}`);
  
  const start = new Date();
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000); // 24h horizon
  console.log(`    Propagation Horizon: 24 hours (${start.toISOString()} to ${end.toISOString()})`);
  
  // 3. Generate Contact Windows
  const service = new ContactWindowService();
  let totalWindows = 0;
  let minDuration = Infinity;
  let maxDuration = 0;
  let zeroVisibilitySats = 0;
  
  const windowsPerStation: Record<string, number> = {};
  stations.forEach(s => windowsPerStation[s.name] = 0);

  console.log("\n[3] Generating Contact Windows (SGP4/SDP4 Propagation)...");
  
  for (const sat of sats) {
    let satVisible = false;
    for (const station of stations) {
      const result = await service.generateContactWindows(sat.id, station.id, start, end, 60);
      const windowCount = result.windows.length;
      totalWindows += windowCount;
      windowsPerStation[station.name] += windowCount;
      
      if (windowCount > 0) satVisible = true;

      for (const w of result.windows) {
        if (w.durationSeconds < minDuration) minDuration = w.durationSeconds;
        if (w.durationSeconds > maxDuration) maxDuration = w.durationSeconds;
      }
    }
    if (!satVisible) zeroVisibilitySats++;
  }

  // 4. Report
  console.log("\n[4] Inspection Report:");
  console.log(`    Total Contact Windows Generated: ${totalWindows}`);
  console.log(`    Minimum Window Duration: ${minDuration === Infinity ? 0 : minDuration} seconds`);
  console.log(`    Maximum Window Duration: ${maxDuration} seconds`);
  console.log(`    Satellites with Zero Visibility (24h): ${zeroVisibilitySats}`);
  
  console.log("\n    Windows per Station:");
  Object.entries(windowsPerStation).forEach(([name, count]) => {
    console.log(`      - ${name}: ${count}`);
  });

  console.log("\n✅ LIVE INTEGRATION COMPLETE");
}

if (process.argv.includes("--run-live")) {
  runLiveContactWindowTest().catch(err => {
    console.error("Live test failed:", err);
    process.exit(1);
  });
} else {
  console.log("Skipping live contact window test. Use --run-live to explicitly execute.");
}
