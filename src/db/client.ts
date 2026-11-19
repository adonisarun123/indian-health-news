import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction. Core functions accept either. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export function createDb(connectionString: string, max = 5): { db: Db; pool: pg.Pool } {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max,
    ssl: local ? undefined : { rejectUnauthorized: true },
  });
  return { db: drizzle(pool, { schema }), pool };
}

let shared: { db: Db; pool: pg.Pool } | undefined;

/** Process-wide pooled handle for the web app. Uses the pooled Neon URL. */
export function getDb(): Db {
  if (!shared) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    shared = createDb(url, Number(process.env.DATABASE_POOL_MAX ?? 5));
  }
  return shared.db;
}

export { schema };
