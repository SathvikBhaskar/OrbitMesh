/**
 * trigger-sync.ts
 *
 * CLI entry point for triggering a CelesTrak orbital sync via the running
 * backend API. Reads credentials from environment or prompts interactively.
 *
 * Usage:
 *   npm run orbital-sync
 *   npx tsx src/cli/trigger-sync.ts
 */
import 'dotenv/config';

const API_BASE = `http://localhost:${process.env.PORT ?? 4000}/api`;

async function run() {
  const email = process.env.ADMIN_EMAIL ?? 'admin@orbitmesh.com';
  const password = process.env.ADMIN_PASSWORD ?? 'admin123';

  console.log(`🔐  Authenticating as ${email}...`);

  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!loginRes.ok) {
    const err = await loginRes.json().catch(() => ({}));
    console.error(`❌  Login failed (${loginRes.status}):`, (err as any).error ?? loginRes.statusText);
    console.error('   Make sure the backend is running: npm run dev');
    process.exit(1);
  }

  const { accessToken } = await loginRes.json();
  console.log('✅  Authenticated');
  console.log('🛰   Triggering CelesTrak orbital sync...');

  const syncRes = await fetch(`${API_BASE}/orbital-sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const result = await syncRes.json().catch(() => ({}));

  if (!syncRes.ok) {
    console.error(`❌  Sync failed (${syncRes.status}):`, result);
    process.exit(1);
  }

  console.log('\n📡  Sync result:');
  console.log(`   Status            : ${result.status}`);
  console.log(`   Fetched           : ${result.fetchedCount ?? 'N/A'}`);
  console.log(`   Discovered (new)  : ${result.discoveredCount ?? 'N/A'}`);
  console.log(`   Updated           : ${result.updatedCount ?? 'N/A'}`);
  console.log(`   Ignored           : ${result.ignoredCount ?? 'N/A'}`);
  console.log(`   Rejected          : ${result.rejectedCount ?? 'N/A'}`);
  console.log(`   Contact windows   : ${result.regeneratedWindowCount ?? 'N/A'}`);
  console.log('');
  console.log('✅  Orbital sync complete. Run `npm run test:scaling` to verify.');
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
