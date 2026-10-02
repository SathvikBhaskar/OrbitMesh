/**
 * seed-guard.ts
 *
 * A safety-wrapped entry point for the development seed script.
 * Refuses to run if DATABASE_URL looks like a production connection string.
 * Usage:
 *   npx tsx src/db/seed-guard.ts           → seed demo data
 *   npx tsx src/db/seed-guard.ts --reset   → same + explicit reset flag
 *
 * Never import from here in application code.
 */
import 'dotenv/config';

const dbUrl = process.env.DATABASE_URL ?? '';
const nodeEnv = process.env.NODE_ENV ?? 'development';

// Block if this looks like production
const PROD_SIGNALS = ['prod', 'production', 'railway', 'render', 'fly.io', 'supabase'];
const looksLikeProd = PROD_SIGNALS.some(sig => dbUrl.toLowerCase().includes(sig));

if (looksLikeProd || nodeEnv === 'production') {
  console.error('');
  console.error('❌  BLOCKED: db:seed:demo refused to run.');
  console.error(`   NODE_ENV: ${nodeEnv}`);
  console.error(`   DATABASE_URL contains a production signal.`);
  console.error('   Seeding would destroy live data.');
  console.error('');
  process.exit(1);
}

// Print the active database so there is no ambiguity in logs
const dbName = dbUrl.split('/').pop()?.split('?')[0] ?? 'unknown';
console.log('');
console.log(`⚙️  Environment : ${nodeEnv}`);
console.log(`⚙️  Database    : ${dbName}`);
console.log(`⚙️  Host        : ${dbUrl.split('@')[1]?.split('/')[0] ?? 'localhost'}`);
console.log('');
console.log('▶  Running development seed...');
console.log('');

// Dynamically import the actual seed so the guard logic runs first
(async () => {
  try {
    const { runSeed } = await import('./seed.js');
    await runSeed();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
