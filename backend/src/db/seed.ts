import { db, pool } from "./client";
import { 
  satellites, 
  groundStations, 
  missionTasks, 
  contactWindows, 
  reservations, 
  schedulerRuns, 
  satelliteOrbitalData,
  outboundDispatchMessages,
  dispatchAttempts,
  executionTelemetryEvents,
  operationalEventLedger,
  operationalBatches,
  scheduleProposals,
  orbitalSyncRuns
} from "./schema";
import { ContactWindowService } from "../modules/contact-windows/contact-window-service";
import { DemoOrbitalDataProvider, DemoMissionTaskProvider } from "../modules/data-providers/demo-providers";
import { RealOrbitalDataProvider } from "../modules/data-providers/real-provider";
import seedrandom from "seedrandom";

const SEED = 202600;
const rng = seedrandom(SEED.toString());

export async function resetDb() {
  console.log("Clearing existing data...");
  await db.delete(outboundDispatchMessages);
  await db.delete(dispatchAttempts);
  await db.delete(executionTelemetryEvents);
  await db.delete(operationalEventLedger);
  await db.delete(operationalBatches);
  await db.delete(scheduleProposals);
  await db.delete(schedulerRuns);
  await db.delete(reservations);
  await db.delete(contactWindows);
  await db.delete(satelliteOrbitalData);
  await db.delete(missionTasks);
  await db.delete(satellites);
  await db.delete(groundStations);
}

export async function runSeed() {
  console.log(`Seeding Database with deterministic seed = ${SEED}...`);
  await resetDb();

  // 1. Acquire and Insert Satellites
  const dataMode = process.env.DATA_PROVIDER || "demo";
  console.log(`DATA_PROVIDER is set to '${dataMode}'`);
  
  const orbitalProvider = dataMode === "real" 
    ? new RealOrbitalDataProvider() 
    : new DemoOrbitalDataProvider(SEED);
  const taskProvider = new DemoMissionTaskProvider(SEED);

  const satConfigs = await orbitalProvider.getSatellites();
  const sats = await db.insert(satellites).values(satConfigs).returning();
  console.log(`Seeded ${sats.length} satellites.`);

  // 2. Acquire and Insert Ground Stations
  const stationConfigs = await orbitalProvider.getGroundStations();
  const stations = await db.insert(groundStations).values(stationConfigs).returning();
  console.log(`Seeded ${stations.length} ground stations.`);

  // 3. Acquire and Insert TLEs
  console.log("Inserting deterministic TLEs...");
  const satIds = sats.map(s => s.id);
  const orbitalData = await orbitalProvider.getOrbitalData(satIds);
  await db.insert(satelliteOrbitalData).values(orbitalData);

  // 4. Generate Contact Windows using unchanged Engine
  console.log("Pre-calculating contact windows for the next 24 hours...");
  const cwService = new ContactWindowService();
  const start = new Date("2026-01-01T00:00:00Z");
  const end = new Date("2026-01-02T00:00:00Z");
  
  let totalWindows = 0;
  for (const sat of sats) {
    if (!sat) continue;
    for (const station of stations) {
      try {
        const res = await cwService.generateContactWindows(sat.id, station.id, start, end, 60);
        totalWindows += res.windows.length;
      } catch (err) {
        // TLE might fail for some old satellites, ignore and continue
      }
    }
  }
  console.log(`Generated ${totalWindows} contact windows.`);

  // 5. Acquire and Insert Mission Tasks
  console.log("Generating 50 mission tasks...");
  const tasksToInsert = await taskProvider.getMissionTasks(satIds, start);

  const generatedTasks = await db.insert(missionTasks).values(tasksToInsert).returning();
  console.log(`Seeded ${generatedTasks.length} mission tasks.`);

  return {
    success: true,
    tasks: generatedTasks.length,
    pending: generatedTasks.length,
    reservations: 0,
    contactWindows: totalWindows
  };
}

if (require.main === module) {
  runSeed().then(() => {
    pool.end();
  }).catch((e) => {
    console.error("Seeding failed", e);
    process.exit(1);
  });
}
