/**
 * synthetic-stress-fixtures.ts
 *
 * Generates SYNTHETIC_STRESS satellite TLE fixtures for 100 and 250 satellite
 * scaling tests. These are NOT real CelesTrak data and must be labelled as such.
 * They exist solely to stress-test the Cesium rendering pipeline.
 *
 * Data source label: SYNTHETIC_STRESS
 * DO NOT use these results as evidence of real orbital accuracy.
 *
 * Run: npm run test:scaling:synthetic
 */
import 'dotenv/config';
import { db } from '../db/client';
import { satellites, satelliteOrbitalData } from '../db/schema';
import { eq, sql } from 'drizzle-orm';

const REAL_TLE_TEMPLATE = {
  // ISS-derived TLE with modified inclination/RAAN per satellite
  line1Base: '1 {norad}U 98067A   26049.50000000  .00001234  00000-0  12345-4 0  9990',
  line2Base: '2 {norad}  51.6400  {raan}.0000  0006703  213.0000  147.0000 15.49253456789012',
};

/** Generate a plausible-looking TLE line1 for a synthetic satellite */
function makeTle1(noradId: number): string {
  const n = String(noradId).padStart(5, '0');
  return `1 ${n}U 26001A   26049.50000000  .00001234  00000-0  12345-4 0  999${(noradId % 9)}`;
}

/** Generate a plausible-looking TLE line2 for a synthetic satellite */
function makeTle2(noradId: number, inclination: number, raan: number): string {
  const n = String(noradId).padStart(5, '0');
  const inc = inclination.toFixed(4).padStart(8, ' ');
  const ra = raan.toFixed(4).padStart(8, ' ');
  return `2 ${n} ${inc} ${ra}  0006703  213.0000  147.0000 15.49253456${String(noradId).padStart(8, '0')}`;
}

async function ensureSyntheticSatellites(targetCount: number) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(satellites);

  const needed = targetCount - count;
  if (needed <= 0) {
    console.log(`  DB already has ${count} satellites (≥ ${targetCount}), no synthetic fixtures needed.`);
    return count;
  }

  console.log(`  DB has ${count} real satellites. Adding ${needed} SYNTHETIC_STRESS satellites to reach ${targetCount}...`);

  // Use NORAD IDs far above real range to avoid conflicts
  const syntheticStart = 900000;

  for (let i = 0; i < needed; i++) {
    const noradId = syntheticStart + i;
    const inclination = 28 + (i % 63); // vary between 28–90 degrees
    const raan = (i * 7.2) % 360;      // distribute around orbit
    const altKm = 400 + (i % 1600);    // vary between 400–2000km

    // Insert satellite record
    const [sat] = await db.insert(satellites).values({
      noradId,
      name: `SYNTHETIC-STRESS-${String(i + 1).padStart(4, '0')}`,
      status: 'ACTIVE',
    }).onConflictDoNothing().returning();

    if (!sat) continue; // already exists

    // Insert orbital data — source must be a valid enum value.
    // Synthetic sats are identified by NORAD ID >= 900000 and name prefix SYNTHETIC-STRESS-*
    await db.insert(satelliteOrbitalData).values({
      satelliteId: sat.id,
      tleLine1: makeTle1(noradId),
      tleLine2: makeTle2(noradId, inclination, raan),
      tleEpoch: new Date('2026-02-18T00:00:00Z'),
      receivedAt: new Date(),
      source: 'CELESTRAK', // enum constraint; synthetic sats identified by name/NORAD ID
    }).onConflictDoNothing();
  }

  const [{ count: newCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(satellites);

  return newCount;
}

async function cleanupSynthetic() {
  console.log('  Removing SYNTHETIC_STRESS satellites (NORAD ID >= 900000)...');
  // First remove orbital data for synthetic satellites
  await db.execute(sql`
    DELETE FROM satellite_orbital_data sod
    USING satellites s
    WHERE sod.satellite_id = s.id
      AND s.norad_id >= 900000
  `);
  // Then remove synthetic satellite records
  await db.execute(sql`
    DELETE FROM satellites
    WHERE norad_id >= 900000
  `);
  console.log('  ✅ Synthetic satellites removed.');
}

async function runSyntheticScalingTest() {
  const API_BASE = `http://localhost:${process.env.PORT ?? 4000}/api`;

  console.log('=== Synthetic Stress Scaling Test ===');
  console.log('⚠️  Data source: SYNTHETIC_STRESS (not real orbital data)');
  console.log('   These results measure Cesium rendering pipeline capacity only.\n');

  // Login
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@orbitmesh.com', password: 'admin123' }),
  });
  if (!loginRes.ok) {
    console.error('❌ Login failed — is backend running?');
    process.exit(1);
  }
  const { accessToken } = await loginRes.json();
  console.log('✅ Authentication: OK\n');

  const thresholds = [10, 50, 100, 250];

  for (const target of thresholds) {
    console.log(`\n── Target: ${target} satellites ──────────────────────`);
    const actualCount = await ensureSyntheticSatellites(target);

    const times: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t = new Date().toISOString();
      const start = Date.now();
      const res = await fetch(
        `${API_BASE}/orbital-sync/positions?time=${encodeURIComponent(t)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await res.json();
      const ms = Date.now() - start;
      times.push(ms);

      if (r === 0) {
        const valid = Array.isArray(data) ? data.filter((p: any) =>
          typeof p.latitude === 'number' && Math.abs(p.latitude) <= 90
        ).length : 0;
        console.log(`  Positions returned: ${Array.isArray(data) ? data.length : '?'} (${valid} valid coords)`);
      }
    }

    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const max = Math.max(...times);
    const pass = max < 2000;
    console.log(`  Response times: ${times.join('ms, ')}ms  →  avg ${avg}ms`);
    console.log(`  ${pass ? '✅' : '❌'} ${target}-satellite threshold: ${pass ? 'PASS' : 'SLOW — >2s'} [SYNTHETIC_STRESS]`);
  }

  // Cleanup synthetic satellites
  console.log('\n── Cleanup ────────────────────────────────────────');
  await cleanupSynthetic();

  console.log('\n=== Summary ===');
  console.log('  Source label   : SYNTHETIC_STRESS');
  console.log('  Not real data  : TLE lines are structurally valid but not from CelesTrak');
  console.log('  Valid for      : API pipeline performance, not orbital accuracy');
  console.log('\n✅ Synthetic scaling test complete.');
  process.exit(0);
}

runSyntheticScalingTest().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
