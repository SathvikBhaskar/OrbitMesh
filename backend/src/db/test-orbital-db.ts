import { db, pool } from "./client";
import { satelliteOrbitalData, satellites } from "./schema";
import { eq } from "drizzle-orm";

async function assertRejects(promise: Promise<any>, testName: string, expectedErrorPattern?: string) {
  try {
    await promise;
    console.error(`❌ [${testName}] FAILED: Expected promise to reject but it resolved.`);
  } catch (err: any) {
    if (expectedErrorPattern && !err.message.includes(expectedErrorPattern)) {
       console.log(`⚠️ [${testName}] REJECTED AS EXPECTED, but error didn't match '${expectedErrorPattern}'. Error was: ${err.message}`);
    } else {
       console.log(`✅ [${testName}] SUCCESS (Rejected as expected: ${err.message})`);
    }
  }
}

async function main() {
  console.log("Testing satellite_orbital_data FK Constraint...");
  
  const sats = await db.select().from(satellites).limit(1);
  if (sats.length === 0) {
      console.log("No satellites exist. Please seed first.");
      process.exit(1);
  }
  const realSatId = sats[0]!.id;

  console.log("--- Insert with valid satellite_id ---");
  const result = await db.insert(satelliteOrbitalData).values({
    satelliteId: realSatId,
    source: "CELESTRAK",
    tleLine1: "1 25544U 98067A   26227.12345678  .00000000  00000-0  00000-0 0  9999",
    tleLine2: "2 25544  51.6400  10.0000 0001000   0.0000   0.0000 15.50000000000000",
    tleEpoch: new Date(),
    receivedAt: new Date()
  }).returning();
  console.log("✅ Inserted successfully:", result[0]!.id);

  console.log("--- Insert with invalid satellite_id ---");
  const randomUuid = "11111111-1111-1111-1111-111111111111";
  await assertRejects(
    db.insert(satelliteOrbitalData).values({
      satelliteId: randomUuid,
      source: "CELESTRAK",
      tleLine1: "LINE1",
      tleLine2: "LINE2",
      tleEpoch: new Date(),
      receivedAt: new Date()
    }),
    "Invalid satellite_id",
    "foreign key"
  );

  console.log("--- Delete satellite with historical data ---");
  await assertRejects(
    db.delete(satellites).where(eq(satellites.id, realSatId)),
    "Delete Satellite ON DELETE RESTRICT",
    "foreign key"
  );

  await pool.end();
}

main().catch(console.error);
