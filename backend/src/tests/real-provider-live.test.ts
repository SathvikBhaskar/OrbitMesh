import { RealOrbitalDataProvider } from "../modules/data-providers/real-provider";

async function runLiveTest() {
  console.log("=== REAL PROVIDER LIVE INTEGRATION TEST ===");
  console.log("⚠️ This test requires internet access and will explicitly contact CelesTrak.");
  console.log("To avoid excessive usage, only a small number of items will be fetched.");
  
  process.env.CELESTRAK_MAX_SATELLITES = "5";
  
  // Test JSON first
  console.log("\nTesting JSON (OMM) format...");
  process.env.CELESTRAK_FORMAT = "json";
  const providerJson = new RealOrbitalDataProvider();
  
  const sats = await providerJson.getSatellites();
  console.log(`Fetched ${sats.length} satellites.`);
  if (sats.length === 0) throw new Error("No satellites fetched.");
  console.log(`First satellite: ${sats[0]?.name} (NORAD: ${sats[0]?.noradId})`);

  const satIds = sats.map((_, i) => `uuid-${i}`);
  const orbitalData = await providerJson.getOrbitalData(satIds);
  console.log(`Normalized ${orbitalData.length} orbital data items.`);
  console.log("First Orbital Data TLE lines:");
  console.log(orbitalData[0]?.tleLine1);
  console.log(orbitalData[0]?.tleLine2);

  // Test TLE fallback
  console.log("\nTesting TLE (3LE) fallback format...");
  process.env.CELESTRAK_FORMAT = "tle";
  const providerTle = new RealOrbitalDataProvider();
  
  const satsTle = await providerTle.getSatellites();
  console.log(`Fetched ${satsTle.length} satellites.`);
  if (satsTle.length === 0) throw new Error("No satellites fetched.");
  
  const orbitalDataTle = await providerTle.getOrbitalData(satIds);
  console.log(`Normalized ${orbitalDataTle.length} orbital data items.`);
  console.log("First Orbital Data TLE lines:");
  console.log(orbitalDataTle[0]?.tleLine1);
  console.log(orbitalDataTle[0]?.tleLine2);

  console.log("\n✅ LIVE TESTS PASSED");
}

if (process.argv.includes("--run-live")) {
  runLiveTest().catch(err => {
    console.error("Live test failed:", err);
    process.exit(1);
  });
} else {
  console.log("Skipping live test. Use --run-live to explicitly execute.");
}
