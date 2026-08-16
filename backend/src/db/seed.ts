import { db, pool } from "./client";
import { satellites, groundStations, missionTasks, contactWindows, reservations, schedulerRuns, satelliteOrbitalData } from "./schema";
import { ContactWindowService } from "../modules/contact-windows/contact-window-service";
import seedrandom from "seedrandom";

const SEED = 202600;
const rng = seedrandom(SEED.toString());

async function resetDb() {
  console.log("Clearing existing data...");
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

  // 1. 8 Satellites
  const satConfigs = [
    { noradId: 25544, name: "ISS" },
    { noradId: 27424, name: "AQUA" },
    { noradId: 25994, name: "TERRA" },
    { noradId: 39084, name: "LANDSAT 8" },
    { noradId: 43013, name: "NOAA 20" },
    { noradId: 33591, name: "NOAA 19" },
    { noradId: 40069, name: "METOP-B" },
    { noradId: 28654, name: "NOAA 18" },
  ];
  
  const satsToInsert = satConfigs.map(s => ({ ...s, status: "ACTIVE" as const }));
  const sats = await db.insert(satellites).values(satsToInsert).returning();
  console.log(`Seeded ${sats.length} satellites.`);

  // 2. 4 Ground Stations
  const stationConfigs = [
    { code: "SVAL", name: "Svalbard Satellite Station", latitude: 78.2297, longitude: 15.4077 },
    { code: "MCM", name: "McMurdo Ground Station", latitude: -77.8463, longitude: 166.6682 },
    { code: "WAL", name: "Wallops Command and Data", latitude: 37.9401, longitude: -75.4663 },
    { code: "FBK", name: "Fairbanks Command and Data", latitude: 64.9774, longitude: -147.5104 },
  ];

  const stationsToInsert = stationConfigs.map(s => ({ ...s, minimumElevationDeg: 10, status: "AVAILABLE" as const }));
  const stations = await db.insert(groundStations).values(stationsToInsert).returning();
  console.log(`Seeded ${stations.length} ground stations.`);

  // 3. Insert Dummy TLEs for deterministic contact windows
  console.log("Inserting deterministic TLEs...");
  for (const sat of sats) {
    if (!sat) continue;
    await db.insert(satelliteOrbitalData).values({
      satelliteId: sat.id,
      source: "CELESTRAK",
      tleLine1: `1 ${String(sat.noradId).padEnd(5, ' ')}U 98067A   26001.00000000  .00000000  00000-0  00000-0 0  9999`,
      tleLine2: `2 ${String(sat.noradId).padEnd(5, ' ')}  51.6400 ${Math.floor(rng() * 360).toFixed(4).padStart(8, ' ')} 0000000   0.0000   0.0000 15.50000000    00`,
      tleEpoch: new Date("2026-01-01T00:00:00Z"),
      receivedAt: new Date()
    });
  }

  // 4. Generate Contact Windows
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

  // 5. ~50 Mission Tasks
  console.log("Generating 50 mission tasks...");
  const tasksToInsert = [];
  
  for (let i = 1; i <= 50; i++) {
    const sat = sats[Math.floor(rng() * sats.length)];
    if (!sat) continue;
    
    const priority = Math.floor(rng() * 10) + 1;
    const duration = 60 + Math.floor(rng() * 540);
    const deadlineOffsetMs = (2 + rng() * 22) * 60 * 60 * 1000;
    const deadline = new Date(start.getTime() + deadlineOffsetMs);
    
    tasksToInsert.push({
      satelliteId: sat.id,
      name: `Observation Task ${String(i).padStart(3, '0')}`,
      priority,
      durationSeconds: duration,
      deadline,
      status: "PENDING" as const
    });
  }

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
