const { Client } = require('pg');
require('dotenv').config();

async function reset() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE;');
  await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE;');
  await client.query('CREATE SCHEMA public;');
  await client.end();
}

reset().catch(console.error);
