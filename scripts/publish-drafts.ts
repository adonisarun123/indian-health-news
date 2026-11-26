/**
 * Publish newsroom drafts by slug, through the same commands an editor uses:
 * (reclassify), submit, approve-editorial, publish.
 *
 *   npm run publish-drafts -- --slugs a,b,c --as you@example.com [--override-risk --reason "…"]
 *
 * A draft the risk screen routed to clinical or sensitive review needs a medical
 * reviewer's sign-off. With --override-risk the managing editor named by --as
 * reclassifies it as routine with the recorded --reason instead: a publisher decision,
 * logged in the audit trail. Without it such drafts are left as they are.
 */
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { articles, people } from "../src/db/schema";
import { CommandError, loadActor, performAction } from "../src/core/articles";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const slugs = (opt("--slugs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const email = opt("--as");
const override = args.includes("--override-risk");
const reason = opt("--reason");
if (!slugs.length || !email) throw new Error("Usage: npm run publish-drafts -- --slugs a,b --as <staff email> [--override-risk --reason \"…\"]");
if (override && !reason) throw new Error("--override-risk needs a --reason for the audit trail.");
const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL_DIRECT or DATABASE_URL");

const { db, pool } = createDb(url, 1);
const tally = { published: 0, overridden: 0, held: 0, skipped: 0, failed: 0 };
try {
  const [person] = await db.select().from(people).where(eq(people.email, email.toLowerCase()));
  if (!person) throw new Error(`No staff account for ${email}.`);
  const actor = await loadActor(db, person.id);
  for (const slug of slugs) {
    const [row] = await db.select({ id: articles.id, status: articles.status, risk: articles.riskRoute, lock: articles.lockVersion }).from(articles).where(eq(articles.slug, slug));
    if (!row) { tally.failed++; console.log(`FAILED    ${slug}: no such article`); process.exitCode = 1; continue; }
    if (row.status === "published") { tally.skipped++; console.log(`skip      ${slug} already published`); continue; }
    let lock = row.lock;
    const step = async (action: string, extra: Record<string, unknown> = {}) => {
      await performAction(db, actor, row.id, { action, expectedVersion: lock, idempotencyKey: `publish-drafts-${row.id}-${lock}-${action}`, ...extra }, new Date());
      const [now] = await db.select({ lock: articles.lockVersion }).from(articles).where(eq(articles.id, row.id));
      lock = now!.lock;
    };
    try {
      if (row.risk !== "routine") {
        if (!override) { tally.held++; console.log(`held      ${slug} (${row.risk}: needs medical review)`); continue; }
        await step("classify", { riskRoute: "routine", reason });
        tally.overridden++;
      }
      if (row.status === "draft") await step("submit");
      if (row.status !== "approved") await step("approve-editorial");
      await step("publish");
      tally.published++;
      console.log(`published ${slug}`);
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      tally.failed++;
      console.log(`FAILED    ${slug}: ${e.code} ${e.message} ${JSON.stringify(e.extra?.fieldErrors ?? [])}`);
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
console.log(`\n${JSON.stringify(tally)}`);
