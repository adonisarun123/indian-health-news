import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5433/postgres";
export const TEMPLATE = "ihn_template";

export function urlFor(database: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Build one migrated template database. Each test file clones it. */
export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(`Test database not reachable at ${ADMIN_URL}. Run \`npm run test:db\` or set TEST_DATABASE_URL. (${(e as Error).message})`);
  }
  const stale = await admin.query<{ datname: string }>("select datname from pg_database where datname like 'ihn_t_%' or datname = $1", [TEMPLATE]);
  for (const { datname } of stale.rows) await admin.query(`drop database if exists "${datname}" with (force)`);
  await admin.query(`create database "${TEMPLATE}"`);

  const pool = new pg.Pool({ connectionString: urlFor(TEMPLATE), max: 1 });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();
  await admin.end();
}
