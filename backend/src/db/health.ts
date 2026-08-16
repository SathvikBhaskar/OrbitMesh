import { sql } from "drizzle-orm";
import { db } from "./client";

export async function checkDatabaseConnection(): Promise<void> {
  await db.execute(sql`SELECT 1`);
}
