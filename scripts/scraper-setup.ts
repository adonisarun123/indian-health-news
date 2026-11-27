/**
 * The platform side of the scraper: register the sources it fetches and issue
 * the producer key it signs its intake events with.
 *
 *   npm run scraper-setup -- sources  --as <staff email> [--source a,b] [--no-trial]
 *   npm run scraper-setup -- producer --as <staff email> [--key-id ihn-scraper] [--source a,b] [--write-env .env.local]
 *   npm run scraper-setup -- assign   --as <staff email> [--key-id ihn-scraper] [--source a,b]
 *   npm run scraper-setup -- rotate   --as <staff email> [--key-id ihn-scraper] [--overlap-hours 24] [--write-env .env.local]
 *   npm run scraper-setup -- list
 *
 * --source defaults to every enabled source in scraper/sources.json (--manifest to use another file).
 *
 * `sources` registers each new source and puts it on trial (under_review): intake
 * is open and nothing publishes while its grant is unknown. A source already in
 * the register is not changed. --no-trial leaves new sources as proposed.
 *
 * `producer` and `rotate` show the secret once. With --write-env they write
 * PRODUCER_KEY and PRODUCER_SECRET into that file instead of printing the secret.
 *
 * Needs DATABASE_URL (or DATABASE_URL_DIRECT) and, for producer, rotate and list,
 * the same INGEST_SECRET_KEY the site runs with.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { loadManifest, pickSources, registerEntryOf } from "../scraper/lib/manifest";
import { CommandError, loadActor } from "../src/core/articles";
import { assignSources, createProducer, listProducers, type ProducerCredentials, rotateSecret, setEnvLines } from "../src/core/producers";
import { registerSources } from "../src/core/sources";
import { createDb } from "../src/db/client";
import { people } from "../src/db/schema";

const [command, ...args] = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const USAGE = "Usage: npm run scraper-setup -- sources|producer|assign|rotate|list [--as <staff email>] (see scripts/scraper-setup.ts)";
if (!command || !["sources", "producer", "assign", "rotate", "list"].includes(command)) throw new Error(USAGE);

const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL_DIRECT or DATABASE_URL");
if (command !== "sources" && !process.env.INGEST_SECRET_KEY) throw new Error("Set INGEST_SECRET_KEY to the value the site runs with: producer secrets are stored encrypted with it.");

const manifest = loadManifest(opt("--manifest") ?? "scraper/sources.json");
const only = opt("--source")?.split(",").map((s) => s.trim()).filter(Boolean);
const chosen = pickSources(manifest, only);
const keyId = opt("--key-id") ?? "ihn-scraper";

function handOver(c: ProducerCredentials) {
  const file = opt("--write-env");
  if (file) {
    writeFileSync(file, setEnvLines(existsSync(file) ? readFileSync(file, "utf8") : "", { PRODUCER_KEY: c.keyId, PRODUCER_SECRET: c.secret }), { mode: 0o600 });
    console.log(`Wrote PRODUCER_KEY=${c.keyId} and PRODUCER_SECRET to ${file}. The secret is not shown and cannot be read back from the database.`);
  } else {
    console.log(`PRODUCER_KEY=${c.keyId}\nPRODUCER_SECRET=${c.secret}\nThis is the only time the secret is shown. Put both lines in the scraper's .env.local.`);
  }
}

console.log(`Database host: ${new URL(url).host}`);
const { db, pool } = createDb(url, 1);
try {
  if (command === "list") {
    const list = await listProducers(db);
    if (!list.length) console.log("No producers.");
    for (const p of list) {
      console.log(`${p.keyId}  "${p.name}"  ${p.isActive ? "active" : "inactive"}  ${p.sources.length} sources`);
      console.log(`  sources: ${p.sources.join(", ") || "none"}`);
      for (const s of p.secrets) console.log(`  secret valid ${s.validFrom.toISOString()} to ${s.validUntil?.toISOString() ?? "open"}${s.readable ? "" : "  NOT readable with this INGEST_SECRET_KEY"}`);
    }
  } else {
    const email = opt("--as");
    if (!email) throw new Error(`${USAGE}\n--as <staff email> is required for ${command}.`);
    const [person] = await db.select().from(people).where(eq(people.email, email.toLowerCase()));
    if (!person) throw new Error(`No staff account for ${email}.`);
    const actor = await loadActor(db, person.id);
    const now = new Date();
    const slugs = chosen.map((s) => s.slug);

    if (command === "sources") {
      const trialReason = args.includes("--no-trial") ? undefined : (opt("--reason") ?? "Scraper trial: intake open, nothing publishes until a grant is recorded.");
      const results = await registerSources(db, actor, chosen.map((s) => registerEntryOf(s)), now, { trialReason });
      for (const r of results) console.log(`${r.outcome.padEnd(13)} ${r.slug.padEnd(20)} ${r.status ?? ""}${r.detail ? `  ${r.detail}` : ""}`);
      const count = (o: string) => results.filter((r) => r.outcome === o).length;
      console.log(JSON.stringify({ registered: count("registered"), exists: count("exists"), hostsDiffer: count("hosts_differ"), failed: count("failed") }));
      if (count("failed") || count("hosts_differ")) process.exitCode = 1;
    } else if (command === "producer") {
      const name = opt("--name") ?? "India Health News scraper";
      handOver(await createProducer(db, actor, { keyId, name, sourceSlugs: slugs, reason: opt("--reason") ?? `Producer key for the scraper (scraper/), ${slugs.length} sources.` }, now));
      console.log(`Assigned ${slugs.length} sources to ${keyId}.`);
    } else if (command === "assign") {
      const added = await assignSources(db, actor, keyId, slugs, opt("--reason") ?? "Assign scraper sources.", now);
      console.log(`Assigned ${added} new sources to ${keyId} (${slugs.length - added} already assigned).`);
    } else if (command === "rotate") {
      const overlapHours = Number(opt("--overlap-hours") ?? 24);
      handOver(await rotateSecret(db, actor, keyId, { overlapHours, reason: opt("--reason") ?? "Rotate the scraper's producer secret." }, now));
      console.log(`Earlier secrets stay valid for ${overlapHours} hours.`);
    }
  }
} catch (e) {
  if (!(e instanceof CommandError)) throw e;
  console.error(`FAILED ${e.code}: ${e.message}${e.extra?.fieldErrors ? ` ${JSON.stringify(e.extra.fieldErrors)}` : ""}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
