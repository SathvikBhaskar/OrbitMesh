import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({
  connectionString: databaseUrl,
});

import { AsyncLocalStorage } from "async_hooks";

export const txContext = new AsyncLocalStorage<any>();

const realDb = drizzle({
  client: pool,
});

export const db = new Proxy(realDb, {
  get(target, prop, receiver) {
    const tx = txContext.getStore();
    if (tx && prop in tx) {
      const value = Reflect.get(tx, prop, receiver);
      if (typeof value === "function") {
        return value.bind(tx);
      }
      return value;
    }
    const value = Reflect.get(target, prop, receiver);
    if (typeof value === "function") {
      return value.bind(target);
    }
    return value;
  }
}) as typeof realDb;
