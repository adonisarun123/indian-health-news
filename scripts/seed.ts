/**
 * npm run db:seed            reference taxonomy only (safe everywhere)
 * npm run db:seed -- --demo  also fictional demo newsroom, sources and producers (dev only)
 *
 * Demo producer secrets are printed once. Put them in .env.local for `npm run produce`.
 */
import { createDb } from "../src/db/client";
import { seedDemo, seedReference } from "../src/db/seed";

const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL_DIRECT or DATABASE_URL");
const { db, pool } = createDb(url, 1);

await seedReference(db);
console.log("Reference taxonomy seeded: 5 sections, 36 states and union territories.");

if (process.argv.includes("--demo")) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production.");
  const demo = await seedDemo(db, new Date());
  console.log("\nDemo data seeded. Add these to .env.local:\n");
  console.log(`PRODUCER_KEY=${demo.producers.a.keyId}`);
  console.log(`PRODUCER_SECRET=${demo.producers.a.secret}`);
  console.log(`PRODUCER_B_KEY=${demo.producers.b.keyId}`);
  console.log(`PRODUCER_B_SECRET=${demo.producers.b.secret}`);
}
await pool.end();
