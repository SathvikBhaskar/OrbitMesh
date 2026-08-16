import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'scheduler_runs';`).then(res => {
  console.table(res.rows);
  process.exit(0);
});
