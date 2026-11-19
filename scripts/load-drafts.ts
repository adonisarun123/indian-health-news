/**
 * Load prepared briefs into the newsroom as private drafts. Nothing is submitted or published.
 *
 *   npm run drafts -- scripts/drafts/2026-11-19.json --as you@example.com
 *
 * Each brief goes through the same command an editor's "Save draft" uses, so the
 * risk screen, validation and audit trail all apply. A slug that already exists
 * is skipped, which makes the command safe to repeat.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { articles, people } from "../src/db/schema";
import { CommandError, createArticle, loadActor } from "../src/core/articles";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".json"));
const email = args[args.indexOf("--as") + 1];
if (!file || !args.includes("--as") || !email) throw new Error("Usage: npm run drafts -- <file.json> --as <staff email>");
const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL_DIRECT or DATABASE_URL");

const briefs = JSON.parse(readFileSync(file, "utf8")) as { slug: string; headline: string }[];
const { db, pool } = createDb(url, 1);
try {
  const [person] = await db.select().from(people).where(eq(people.email, email.toLowerCase()));
  if (!person) throw new Error(`No staff account for ${email}.`);
  const actor = await loadActor(db, person.id);

  for (const brief of briefs) {
    const [existing] = await db.select({ id: articles.id }).from(articles).where(eq(articles.slug, brief.slug));
    if (existing) {
      console.log(`skip     ${brief.slug} (already exists)`);
      continue;
    }
    try {
      const r = await createArticle(db, actor, brief, new Date());
      console.log(`${r.status.padEnd(8)} ${r.slug}`);
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      console.log(`FAILED   ${brief.slug}: ${e.code} ${JSON.stringify(e.extra.fieldErrors ?? [])}`);
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
