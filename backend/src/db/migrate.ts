import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client";

async function runMigrations() {
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Migrations complete!");
  await pool.end();
}

runMigrations().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
