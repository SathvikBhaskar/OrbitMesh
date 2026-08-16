import { db } from "../db/client";
import { schedulerRuns, reservations, contactWindows, missionTasks, satelliteOrbitalData, groundStations, satellites } from "../db/schema";
import { sql } from "drizzle-orm";

async function truncateAll() {
  await db.delete(schedulerRuns);
  await db.delete(reservations);
  await db.delete(contactWindows);
  await db.delete(missionTasks);
  await db.delete(satelliteOrbitalData);
  await db.delete(groundStations);
  await db.delete(satellites);
  process.exit(0);
}

truncateAll().catch(e => { console.error(e); process.exit(1); });
