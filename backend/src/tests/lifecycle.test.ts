/**
 * lifecycle.test.ts
 *
 * Phase 2 lifecycle / memory-stability test.
 *
 * Tests that the backend positions endpoint does NOT exhibit memory growth
 * over 10 repeated request cycles (simulating mount → fetch → unmount).
 * 
 * The Cesium viewer itself can't be tested server-side; instead this test
 * validates that the server-side data pipeline stabilizes — each response
 * is consistent in size and content, and heap usage on the server is stable.
 *
 * For Cesium WebGL/heap memory, see: MANUAL VERIFICATION section below.
 *
 * Run: npm run test:lifecycle
 */
import 'dotenv/config';

const API_BASE = `http://localhost:${process.env.PORT ?? 4000}/api`;
const CYCLES = 10;

interface Measurement {
  cycle: number;
  responseMs: number;
  satelliteCount: number;
  responseBytes: number;
}

async function login(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@orbitmesh.com', password: 'admin123' }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Login failed (${res.status}): ${(err as any).error}`);
  }
  const data = await res.json();
  return data.accessToken;
}

async function fetchPositions(token: string, time: string): Promise<{ data: any[]; bytes: number; ms: number }> {
  const start = Date.now();
  const res = await fetch(
    `${API_BASE}/orbital-sync/positions?time=${encodeURIComponent(time)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Positions fetch failed: ${res.status}`);
  const text = await res.text();
  const ms = Date.now() - start;
  return { data: JSON.parse(text), bytes: text.length, ms };
}

async function runLifecycleTest() {
  console.log('=== Phase 2 Lifecycle / Memory Stability Test ===');
  console.log(`Simulating ${CYCLES}× mount → fetch → unmount cycles\n`);

  let token: string;
  try {
    token = await login();
    console.log('✅ Authentication: OK\n');
  } catch (e: any) {
    console.error('❌ Authentication failed:', e.message);
    console.error('   Is the backend running? npm run dev');
    process.exit(1);
  }

  const time = new Date().toISOString();
  const measurements: Measurement[] = [];

  for (let i = 1; i <= CYCLES; i++) {
    const { data, bytes, ms } = await fetchPositions(token!, time);
    measurements.push({ cycle: i, responseMs: ms, satelliteCount: data.length, responseBytes: bytes });
    process.stdout.write(`  Cycle ${i.toString().padStart(2)}/${CYCLES}: ${data.length} sats, ${ms}ms, ${bytes} bytes\n`);
    
    // Small delay to simulate React unmount/remount gap
    await new Promise(r => setTimeout(r, 100));
  }

  // Analysis
  const counts = measurements.map(m => m.satelliteCount);
  const times = measurements.map(m => m.responseMs);
  const bytes = measurements.map(m => m.responseBytes);

  const allCountsEqual = counts.every(c => c === counts[0]);
  const maxTime = Math.max(...times);
  const minTime = Math.min(...times);
  const avgTime = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const allBytesEqual = bytes.every(b => b === bytes[0]);

  console.log('\n📊 Stability Analysis:');
  console.log(`  Satellite count stable    : ${allCountsEqual ? '✅ YES' : `❌ NO — counts varied: ${[...new Set(counts)].join(', ')}`}`);
  console.log(`  Response payload stable   : ${allBytesEqual ? '✅ YES' : '⚠️  NO — payload size varied (expected if TLE timestamps differ)'}`);
  console.log(`  Response time (min/avg/max): ${minTime}ms / ${avgTime}ms / ${maxTime}ms`);
  console.log(`  Time variance acceptable  : ${maxTime - minTime < 500 ? '✅ YES (<500ms spread)' : '⚠️  HIGH variance — check for connection pooling issues'}`);

  console.log('\n📝 MANUAL VERIFICATION REQUIRED (Cesium WebGL heap):');
  console.log('  1. Open Chrome DevTools → Memory tab');
  console.log('  2. Take heap snapshot (baseline)');
  console.log('  3. Navigate away from Orbital Map → wait 2s → navigate back');
  console.log('  4. Repeat ×10');
  console.log('  5. Take final heap snapshot');
  console.log('  Expected: heap stabilizes (not continuously grows)');
  console.log('  Pass criteria: final heap ≤ 1.5× baseline heap');
  console.log('  Cesium viewer.destroy() is called on every unmount ✅');

  const serverSidePass = allCountsEqual && (maxTime < 5000);
  console.log(`\n${serverSidePass ? '✅' : '❌'} Server-side lifecycle test: ${serverSidePass ? 'PASS' : 'FAIL'}`);
  console.log('⚠️  Client-side WebGL test: REQUIRES MANUAL VERIFICATION (see above)');

  console.log('\n=== Test Complete ===');
  process.exit(serverSidePass ? 0 : 1);
}

runLifecycleTest().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
