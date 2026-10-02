import "dotenv/config";
import { RealOrbitalDataProvider } from "../modules/data-providers/real-provider";
import { ContactWindowService } from "../modules/contact-windows/contact-window-service";
import { DefaultTelemetrySink } from "../utils/telemetry";
import { resetDb } from "../db/seed";
import { db } from "../db/client";
import { satellites, groundStations, satelliteOrbitalData } from "../db/schema";
import { desc } from "drizzle-orm";

async function runBenchmarkForScale(scale: number): Promise<Record<string, any>> {
  console.log(`\n========================================`);
  console.log(`🚀 Benchmarking Scale: ${scale} Satellites`);
  console.log(`========================================`);
  
  // Configure environment for this run
  process.env.CELESTRAK_MAX_SATELLITES = scale.toString();
  process.env.CELESTRAK_MAX_SATELLITES_HARD_LIMIT = "2000";
  process.env.CELESTRAK_GROUP = "starlink";
  process.env.CELESTRAK_FORMAT = "json";

  await resetDb();

  const telemetry = new DefaultTelemetrySink();
  const provider = new RealOrbitalDataProvider();
  provider.setTelemetry(telemetry);

  const tStart = performance.now();

  // 1. Fetch Satellites
  const satsConfig = await provider.getSatellites();
  if (satsConfig.length === 0) throw new Error("No satellites retrieved");
  
  const insertedSats = await db.insert(satellites).values(satsConfig).returning();
  const satIds = insertedSats.map(s => s.id);
  
  // 2. Fetch Orbital Data
  const orbitalDataConfig = await provider.getOrbitalData(satIds);
  await db.insert(satelliteOrbitalData).values(orbitalDataConfig);
  
  // 3. Ground Stations
  const stationsConfig = await provider.getGroundStations();
  const insertedStations = await db.insert(groundStations).values(stationsConfig).returning();
  
  const metrics = telemetry.getMetrics();
  console.log(`[Satellites] Requested: ${scale}, Retrieved: ${metrics.satellites_retrieved}, Valid/Parsed: ${metrics.satellites_parsed}`);
  
  const actualSats = metrics.satellites_parsed;
  if (actualSats === 0) throw new Error("No valid satellites to process");

  // 4. Generate Windows (24h horizon)
  const cwService = new ContactWindowService();
  const start = new Date();
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  
  let zeroVisibilitySats = 0;
  
  for (const sat of insertedSats) {
    let satVisible = false;
    for (const station of insertedStations) {
      const res = await cwService.generateContactWindows(sat.id, station.id, start, end, 60, telemetry);
      if (res.windows.length > 0) satVisible = true;
    }
    if (!satVisible) zeroVisibilitySats++;
  }

  const tEnd = performance.now();
  const totalMs = tEnd - tStart;
  
  const finalMetrics = telemetry.getMetrics();
  const mem = process.memoryUsage();
  
  return {
    scale,
    actualSats,
    downloadMs: finalMetrics.download || 0,
    parsingMs: finalMetrics.parsing || 0,
    propagationMs: finalMetrics.propagation || 0,
    refinementMs: finalMetrics.refinement || 0,
    databaseMs: finalMetrics.database || 0,
    totalMs,
    peakRssMb: Math.round(mem.rss / 1024 / 1024),
    windowCount: finalMetrics.contact_windows_generated || 0,
    zeroVisibilitySats
  };
}

async function investigateLongestWindow() {
  console.log("\n=== INVESTIGATING LONGEST CONTACT WINDOW ===");
  // We look into the database for the contact window with max duration
  const { contactWindows, satellites, groundStations } = await import("../db/schema");
  const { eq, desc } = await import("drizzle-orm");
  
  const longest = await db.select({
    aos: contactWindows.aos,
    los: contactWindows.los,
    duration: contactWindows.durationSeconds,
    maxElev: contactWindows.maxElevationDeg,
    satName: satellites.name,
    noradId: satellites.noradId,
    stationName: groundStations.name,
    satId: satellites.id,
    stationId: groundStations.id
  }).from(contactWindows)
    .innerJoin(satellites, eq(satellites.id, contactWindows.satelliteId))
    .innerJoin(groundStations, eq(groundStations.id, contactWindows.groundStationId))
    .orderBy(desc(contactWindows.durationSeconds))
    .limit(1);

  if (longest.length > 0) {
    const w = longest[0]!;
    console.log(`Satellite: ${w.satName} (NORAD: ${w.noradId})`);
    console.log(`Station: ${w.stationName}`);
    console.log(`AOS: ${w.aos.toISOString()}`);
    console.log(`LOS: ${w.los.toISOString()}`);
    console.log(`Duration: ${w.duration} seconds`);
    console.log(`Max Elevation: ${w.maxElev} deg`);
    
    // Sample the visibility manually to verify
    const { VisibilityService } = await import("../modules/visibility/visibility-service");
    const visService = new VisibilityService();
    const res = await visService.getVisibility(w.satId, w.stationId, w.aos, w.los, Math.floor(w.duration / 4));
    console.log(`\nSampled physical elevations during window:`);
    res.samples.forEach(s => {
      console.log(`  [${s.timestamp}] Elev: ${s.elevationDeg.toFixed(2)} deg, Range: ${s.rangeKm.toFixed(2)} km, Visible: ${s.visible}`);
    });
  } else {
    console.log("No windows found.");
  }
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const half = Math.floor(values.length / 2);
  if (values.length % 2) return values[half];
  return (values[half - 1]! + values[half]!) / 2.0;
}

function p95(values: number[]) {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const index = Math.ceil(values.length * 0.95) - 1;
  return values[index];
}

async function run() {
  console.log("Starting Scalability Benchmark...");
  const scales = [10, 50, 100, 250, 500, 1000];
  const iterations = 3;
  
  const reports: Record<number, any> = {};

  for (const scale of scales) {
    const results = [];
    for (let i = 0; i < iterations; i++) {
      console.log(`\n--- Scale ${scale}, Iteration ${i+1}/${iterations} ---`);
      const res = await runBenchmarkForScale(scale);
      results.push(res);
    }
    
    reports[scale] = {
      actualSats: median(results.map(r => r.actualSats)),
      windowCount: median(results.map(r => r.windowCount)),
      zeroVisSats: median(results.map(r => r.zeroVisibilitySats)),
      downloadMs: { med: median(results.map(r => r.downloadMs)), p95: p95(results.map(r => r.downloadMs)) },
      parsingMs: { med: median(results.map(r => r.parsingMs)), p95: p95(results.map(r => r.parsingMs)) },
      propagationMs: { med: median(results.map(r => r.propagationMs)), p95: p95(results.map(r => r.propagationMs)) },
      refinementMs: { med: median(results.map(r => r.refinementMs)), p95: p95(results.map(r => r.refinementMs)) },
      databaseMs: { med: median(results.map(r => r.databaseMs)), p95: p95(results.map(r => r.databaseMs)) },
      totalMs: { med: median(results.map(r => r.totalMs)), p95: p95(results.map(r => r.totalMs)) },
      peakRssMb: Math.max(...results.map(r => r.peakRssMb))
    };
  }

  console.log("\n\n================================================");
  console.log("📊 SCALABILITY BENCHMARK REPORT");
  console.log("================================================");
  
  for (const scale of scales) {
    const r = reports[scale];
    console.log(`\nScale: ${scale} (Valid: ${r.actualSats} sats) | Windows: ${r.windowCount} | Zero-Vis: ${r.zeroVisSats} | Peak RSS: ${r.peakRssMb}MB`);
    console.log(`  Download:    Med ${r.downloadMs.med.toFixed(0)}ms | P95 ${r.downloadMs.p95.toFixed(0)}ms`);
    console.log(`  Parsing:     Med ${r.parsingMs.med.toFixed(0)}ms | P95 ${r.parsingMs.p95.toFixed(0)}ms`);
    console.log(`  Propagation: Med ${r.propagationMs.med.toFixed(0)}ms | P95 ${r.propagationMs.p95.toFixed(0)}ms`);
    console.log(`  Refinement:  Med ${r.refinementMs.med.toFixed(0)}ms | P95 ${r.refinementMs.p95.toFixed(0)}ms`);
    console.log(`  Database:    Med ${r.databaseMs.med.toFixed(0)}ms | P95 ${r.databaseMs.p95.toFixed(0)}ms`);
    console.log(`  TOTAL:       Med ${r.totalMs.med.toFixed(0)}ms | P95 ${r.totalMs.p95.toFixed(0)}ms`);
  }

  await investigateLongestWindow();
  
  console.log("\nBenchmark complete.");
  process.exit(0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
