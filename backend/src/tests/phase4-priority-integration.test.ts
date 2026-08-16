import { db, pool } from "../db/client";
import { 
  reservations, 
  missionTasks, 
  contactWindows, 
  groundStations, 
  satellites, 
  satelliteOrbitalData 
} from "../db/schema";
import { CandidateService } from "../modules/scheduler/candidate-service";
import { PriorityScheduler } from "../modules/scheduler/priority-scheduler";
import { eq } from "drizzle-orm";
import assert from "assert";

async function resetDb() {
  await db.delete(reservations);
  await db.delete(missionTasks);
  await db.delete(contactWindows);
  await db.delete(groundStations);
  await db.delete(satelliteOrbitalData);
  await db.delete(satellites);
}

async function runIntegrationTest() {
  console.log("=== PHASE 4.3 PRIORITY INTEGRATION ===");
  await resetDb();

  const iss = (await db.insert(satellites).values({ noradId: 25544, name: "ISS", status: "ACTIVE" }).returning())[0]!;
  const chennai = (await db.insert(groundStations).values({ code: "CHN", name: "Chennai", latitude: 13, longitude: 80, minimumElevationDeg: 10, status: "AVAILABLE" }).returning())[0]!;
  const orb = (await db.insert(satelliteOrbitalData).values({ satelliteId: iss.id, source: "CELESTRAK", tleLine1: "1", tleLine2: "2", tleEpoch: new Date(), receivedAt: new Date() }).returning())[0]!;

  const w1 = (await db.insert(contactWindows).values({
    satelliteId: iss.id,
    groundStationId: chennai.id,
    orbitalDataId: orb.id,
    aos: new Date("2026-08-16T10:00:00Z"),
    los: new Date("2026-08-16T10:30:00Z"),
    durationSeconds: 1800,
    maxElevationDeg: 65
  }).returning())[0]!;

  const t1 = (await db.insert(missionTasks).values({
    satelliteId: iss.id,
    name: "ISS Download Low",
    priority: 5,
    durationSeconds: 300,
    deadline: new Date("2026-08-17T00:00:00Z"),
    status: "PENDING",
    createdAt: new Date(Date.now() - 1000)
  }).returning())[0]!;

  const t2 = (await db.insert(missionTasks).values({
    satelliteId: iss.id,
    name: "ISS Download High",
    priority: 10,
    durationSeconds: 300,
    deadline: new Date("2026-08-17T00:00:00Z"),
    status: "PENDING",
    createdAt: new Date() // created later!
  }).returning())[0]!;

  const candidateService = new CandidateService();
  const priorityScheduler = new PriorityScheduler(candidateService);

  const res = await priorityScheduler.schedulePendingTasks();

  const alloc1 = await db.select().from(reservations).where(eq(reservations.missionTaskId, t1.id));
  const alloc2 = await db.select().from(reservations).where(eq(reservations.missionTaskId, t2.id));
  
  assert.strictEqual(alloc2[0]!.allocatedStart.toISOString(), "2026-08-16T10:00:00.000Z"); // High gets first slot
  assert.strictEqual(alloc1[0]!.allocatedStart.toISOString(), "2026-08-16T10:05:00.000Z"); // Low gets second slot

  console.log("✅ Priority Integration Test passed correctly.");

  await pool.end();
}

runIntegrationTest().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
