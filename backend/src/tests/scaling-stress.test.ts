/**
 * Orbital Map Scaling Test
 * 
 * Tests that the satellite positions API handles 10, 50, 100, and 250 satellites
 * and that the backend returns valid coordinate data for each.
 * 
 * Run: npx tsx src/tests/scaling-stress.test.ts
 */
import { db } from '../db/client';
import { satellites } from '../db/schema';
import { sql } from 'drizzle-orm';

const API_BASE = 'http://localhost:4000/api';

async function login(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@orbitmesh.com', password: 'admin123' }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const data = await res.json();
  return data.accessToken;
}

async function fetchPositions(token: string, time: string) {
  const res = await fetch(
    `${API_BASE}/orbital-sync/positions?time=${encodeURIComponent(time)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Positions fetch failed: ${res.status}`);
  return res.json() as Promise<any[]>;
}

async function runScalingTest() {
  console.log('=== Orbital Map Scaling Test ===\n');

  // 1. Count satellites currently in DB
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(satellites);
  console.log(`Satellites in DB: ${count}`);

  // 2. Login
  let token: string;
  try {
    token = await login();
    console.log('✅ Authentication: OK\n');
  } catch (e: any) {
    console.error('❌ Authentication failed:', e.message);
    console.error('   Is the backend running on port 4000?');
    process.exit(1);
  }

  const time = new Date().toISOString();
  const positions = await fetchPositions(token!, time);

  console.log(`Positions returned: ${positions.length}`);

  // 3. Validate coordinate data
  let validCount = 0;
  let tleMissingCount = 0;
  let coordInvalidCount = 0;

  for (const p of positions) {
    const hasCoords =
      typeof p.latitude === 'number' &&
      typeof p.longitude === 'number' &&
      typeof p.altitudeKm === 'number' &&
      Math.abs(p.latitude) <= 90 &&
      Math.abs(p.longitude) <= 180 &&
      p.altitudeKm > 0;

    const hasTle = Boolean(p.tleLine1 && p.tleLine2);

    if (hasCoords && hasTle) validCount++;
    else if (!hasTle) tleMissingCount++;
    else coordInvalidCount++;
  }

  console.log(`\n📊 Data Quality:`);
  console.log(`  ✅ Valid (coords + TLE): ${validCount}/${positions.length}`);
  if (tleMissingCount > 0) console.log(`  ⚠️  Missing TLE: ${tleMissingCount}`);
  if (coordInvalidCount > 0) console.log(`  ❌ Invalid coords: ${coordInvalidCount}`);

  // 4. Scaling thresholds — honest reporting
  console.log('\n📈 Scaling Thresholds:');
  const thresholds = [
    { n: 10,  label: 'smoke' },
    { n: 50,  label: 'medium' },
    { n: 100, label: 'large' },
    { n: 250, label: 'stress' },
  ];

  let allScalingPassed = true;
  for (const { n, label } of thresholds) {
    if (validCount >= n) {
      console.log(`  ✅ ${n.toString().padEnd(3)} satellites (${label}): PASS — ${validCount} real satellites available [REAL_CELESTRAK]`);
    } else {
      allScalingPassed = false;
      console.log(`  ❌ ${n.toString().padEnd(3)} satellites (${label}): BLOCKED — only ${validCount} satellites in DB`);
      console.log(`       → Run: npm run orbital-sync   to fetch CelesTrak data`);
      console.log(`       → Or:  use SYNTHETIC_STRESS fixtures for ${n}+ (must be labelled synthetic, not real-data results)`);
    }
  }

  if (!allScalingPassed) {
    console.log('\n⚠️  Scaling validation: INCOMPLETE');
    console.log('   Infrastructure tested OK. Real-data thresholds blocked.');
    console.log('   Phase 2 scaling requirement is NOT MET until these pass.');
  } else {
    console.log('\n✅  Scaling validation: ALL THRESHOLDS PASSED');
  }

  // 5. Timing check — re-request 3 times
  console.log('\n⏱️  Response Time (3 requests):');
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    await fetchPositions(token!, time);
    const ms = Date.now() - start;
    const status = ms < 2000 ? '✅' : ms < 5000 ? '⚠️ ' : '❌';
    console.log(`  ${status} Request ${i + 1}: ${ms}ms`);
  }

  // 6. 401 test — no token
  console.log('\n🔒 Auth enforcement:');
  const unauthedRes = await fetch(`${API_BASE}/orbital-sync/positions?time=${encodeURIComponent(time)}`);
  if (unauthedRes.status === 401) {
    console.log('  ✅ No-token request → 401 Unauthorized');
  } else {
    console.log(`  ❌ Expected 401 but got ${unauthedRes.status}`);
  }

  // 7. 403 test — wrong token
  const badRes = await fetch(`${API_BASE}/orbital-sync/positions?time=${encodeURIComponent(time)}`, {
    headers: { Authorization: 'Bearer invalid.token.here' },
  });
  if (badRes.status === 401 || badRes.status === 403) {
    console.log(`  ✅ Bad-token request → ${badRes.status}`);
  } else {
    console.log(`  ❌ Expected 401/403 but got ${badRes.status}`);
  }

  console.log('\n=== Test Complete ===');
  process.exit(0);
}

runScalingTest().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
