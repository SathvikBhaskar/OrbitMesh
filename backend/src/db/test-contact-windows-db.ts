import { db, pool } from "./client";
import { contactWindows, satellites, groundStations, satelliteOrbitalData } from "./schema";
import { eq } from "drizzle-orm";

async function assertRejects(promise: Promise<any>, testName: string, expectedErrorPattern?: string) {
  try {
    await promise;
    console.error(`❌ [${testName}] FAILED: Expected promise to reject but it resolved.`);
    process.exit(1);
  } catch (err: any) {
    if (expectedErrorPattern && !err.message.includes(expectedErrorPattern)) {
       console.log(`⚠️ [${testName}] REJECTED AS EXPECTED, but error didn't match '${expectedErrorPattern}'. Error was: ${err.message}`);
    } else {
       console.log(`✅ [${testName}] SUCCESS (Rejected as expected: ${err.message})`);
    }
  }
}

async function main() {
  console.log("Testing contact_windows Constraints...");
  
  const sats = await db.select().from(satellites).limit(2);
  if (sats.length < 2) {
      // Seed a second satellite for testing mismatched FKs
      await db.insert(satellites).values({
        noradId: 99999,
        name: "Test Sat B",
        status: "ACTIVE"
      });
  }
  const satsUpdated = await db.select().from(satellites).limit(2);
  const realSatId = satsUpdated[0]!.id;
  const satBId = satsUpdated[1]!.id;

  const stations = await db.select().from(groundStations).limit(1);
  const realStationId = stations[0]!.id;

  const orbitals = await db.select().from(satelliteOrbitalData).limit(1);
  const realOrbitalId = orbitals[0]!.id;

  console.log("--- Valid Insert ---");
  const aos = new Date("2026-08-15T12:00:00Z");
  const los = new Date("2026-08-15T12:05:00Z");
  const result = await db.insert(contactWindows).values({
    satelliteId: realSatId,
    groundStationId: realStationId,
    orbitalDataId: realOrbitalId,
    aos,
    los,
    durationSeconds: 300,
    maxElevationDeg: 45.5,
  }).returning();
  console.log("✅ Valid insert successful:", result[0]!.id);

  console.log("--- Invalid AOS >= LOS ---");
  await assertRejects(
    db.insert(contactWindows).values({
      satelliteId: realSatId,
      groundStationId: realStationId,
      orbitalDataId: realOrbitalId,
      aos: los, // AOS == LOS
      los: aos,
      durationSeconds: 300,
      maxElevationDeg: 45.5,
    }),
    "Invalid AOS >= LOS",
    "aos_los_check"
  );

  console.log("--- Invalid Duration ---");
  await assertRejects(
    db.insert(contactWindows).values({
      satelliteId: realSatId,
      groundStationId: realStationId,
      orbitalDataId: realOrbitalId,
      aos,
      los,
      durationSeconds: -10, // Invalid
      maxElevationDeg: 45.5,
    }),
    "Invalid duration",
    "duration_check"
  );

  console.log("--- Invalid Duration (Math Mismatch) ---");
  await assertRejects(
    db.insert(contactWindows).values({
      satelliteId: realSatId,
      groundStationId: realStationId,
      orbitalDataId: realOrbitalId,
      aos,
      los,
      durationSeconds: 50, // Mathematically 300
      maxElevationDeg: 45.5,
    }),
    "Invalid duration math",
    "duration_math_check"
  );

  console.log("--- Invalid Max Elevation ---");
  await assertRejects(
    db.insert(contactWindows).values({
      satelliteId: realSatId,
      groundStationId: realStationId,
      orbitalDataId: realOrbitalId,
      aos,
      los,
      durationSeconds: 300,
      maxElevationDeg: 95, // Invalid > 90
    }),
    "Invalid max elevation",
    "max_elevation_check"
  );

  console.log("--- Invalid FK (Satellite Mismatch) ---");
  await assertRejects(
    db.insert(contactWindows).values({
      satelliteId: satBId, // Satellite B
      groundStationId: realStationId,
      orbitalDataId: realOrbitalId, // Orbital data for Satellite A
      aos,
      los,
      durationSeconds: 300,
      maxElevationDeg: 45.5,
    }),
    "Satellite/Orbital Data mismatch",
    "contact_windows_orbital_sat_fk"
  );

  await pool.end();
}

main().catch(console.error);
