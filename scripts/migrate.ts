/** Apply reviewed SQL migrations. Uses the direct (unpooled) connection where set. */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../src/db/client";

const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL_DIRECT or DATABASE_URL");

const { db, pool } = createDb(url, 1);
await migrate(db, { migrationsFolder: "./drizzle" });
await pool.end();
console.log("Migrations applied.");
