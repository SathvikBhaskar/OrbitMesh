import { db, pool } from "../db/client";
import { satellites, groundStations, satelliteOrbitalData, contactWindows } from "../db/schema";
import { OrbitalDataService } from "../modules/orbital-data/services/orbital-data-service";
import { ContactWindowService } from "../modules/contact-windows/contact-window-service";
import { VisibilityService } from "../modules/visibility/visibility-service";
import { eq } from "drizzle-orm";

async function runIntegrationTest() {
  console.log("=== PHASE 3 INTEGRATION TEST (REAL ISS) ===");

  await db.delete(contactWindows);
  
  let sats = await db.select().from(satellites).limit(1);
  if (sats.length === 0) {
    sats = await db.insert(satellites).values({ noradId: 25544, name: "ISS", status: "ACTIVE" }).returning();
  }
  const satId = sats[0]!.id;

  let stations = await db.select().from(groundStations).limit(1);
  if (stations.length === 0) {
    stations = await db.insert(groundStations).values({ code: "TEST-STN", name: "Test Station", latitude: 0, longitude: 0, minimumElevationDeg: 10, status: "AVAILABLE" }).returning();
  }
  const stationId = stations[0]!.id;

  // Refresh latest orbital data from Celestrak (ISS 25544)
  console.log("\n--- Fetching live CelesTrak data ---");
  const orbitalService = new OrbitalDataService();
  await orbitalService.refreshOrbitalData(satId);

  // Generate Contact Windows over 24 hours
  console.log("\n--- Generating Contact Windows (24h) ---");
  const cwService = new ContactWindowService();
  
  const start = new Date();
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000); // 24 hours
  const stepSeconds = 60;

  const { windows } = await cwService.generateContactWindows(satId, stationId, start, end, stepSeconds);
  
  console.log(`✅ SUCCESS: Generated ${windows.length} windows for ISS over Chennai in the next 24h.`);

  // Verify Idempotency
  console.log("\n--- Testing Idempotency ---");
  const { windows: duplicateWindows } = await cwService.generateContactWindows(satId, stationId, start, end, stepSeconds);
  const allRows = await db.select().from(contactWindows);
  if (allRows.length === windows.length && duplicateWindows.length === windows.length) {
    console.log("✅ SUCCESS: Repeated generation request did not duplicate rows.");
  } else {
    throw new Error(`Idempotency failed. Expected ${windows.length} rows, got ${allRows.length}`);
  }

  // Verify constraints
  for (const cw of allRows) {
    if (cw.aos.getTime() >= cw.los.getTime()) throw new Error("AOS >= LOS constraint violated");
    if (cw.durationSeconds <= 0) throw new Error("Duration <= 0 constraint violated");
    if (cw.maxElevationDeg < 0 || cw.maxElevationDeg > 90) throw new Error("Max elevation bounds violated");
  }
  console.log("✅ SUCCESS: DB Invariants respected for all generated windows.");

  // Verify boundary refinement (+- 10s check)
  console.log("\n--- Verifying Exact AOS/LOS Refinement Bound ---");
  if (windows.length > 0) {
    // Pick the first window that does not truncate against the observation edge
    const cw = windows.find(w => w.aos.getTime() > start.getTime() && w.los.getTime() < end.getTime());
    
    if (cw) {
      const visibilityService = new VisibilityService();
      
      const aosMinus10 = new Date(cw.aos.getTime() - 10 * 1000);
      const aosPlus10 = new Date(cw.aos.getTime() + 10 * 1000);
      
      const { samples: s1 } = await visibilityService.getVisibility(satId, stationId, aosMinus10, aosMinus10, 1);
      const { samples: s2 } = await visibilityService.getVisibility(satId, stationId, aosPlus10, aosPlus10, 1);
      
      if (s1[0]?.visible === true) throw new Error("AOS - 10s is visible! Bracket failed.");
      if (s2[0]?.visible === false) throw new Error("AOS + 10s is invisible! Bracket failed.");
      console.log(`✅ SUCCESS: AOS bracket verified accurately. (AOS: ${cw.aos.toISOString()})`);

      const losMinus10 = new Date(cw.los.getTime() - 10 * 1000);
      const losPlus10 = new Date(cw.los.getTime() + 10 * 1000);

      const { samples: s3 } = await visibilityService.getVisibility(satId, stationId, losMinus10, losMinus10, 1);
      const { samples: s4 } = await visibilityService.getVisibility(satId, stationId, losPlus10, losPlus10, 1);

      if (s3[0]?.visible === false) throw new Error("LOS - 10s is invisible! Bracket failed.");
      if (s4[0]?.visible === true) throw new Error("LOS + 10s is visible! Bracket failed.");
      console.log(`✅ SUCCESS: LOS bracket verified accurately. (LOS: ${cw.los.toISOString()})`);
    } else {
      console.log("⚠️ Skip: All windows truncated against observation edges.");
    }
  }

  console.log("\nAll Integration Tests Passed! ✅");
  await pool.end();
}

runIntegrationTest().catch(e => {
  console.error("Integration test failed:", e);
  process.exit(1);
});
