/** AT-07, AT-08 and AT-16: removal decisions survive recovery, and missed work is picked up. */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { articles, auditEntries, editorialTasks, feedEntries, jobs, sourceItems } from "@/db/schema";
import { seedDemoContent } from "@/db/seed-content";
import { createArticle, performAction } from "@/core/articles";
import { getPublicArticle, listPublicFeed } from "@/core/public";
import { countSitemapArticles, searchPublic } from "@/core/reader";
import { reconcile } from "@/core/reconcile";
import { at, createCtx, type Ctx, drain, key, notice, ROUTINE_STORY, send, T0 } from "./helpers";

describe("AT-07 · COR, ARC — retraction, mandatory removal and recovery", () => {
  let ctx: Ctx;
  const now = at(5);
  beforeAll(async () => {
    ctx = await createCtx();
    await seedDemoContent(ctx.db, ctx.seed, T0);
  });
  afterAll(() => ctx.close());

  it("honours removal decisions on every surface after a restore brings stale rows back", async () => {
    const boss = await ctx.actor("managingEditor");
    const bySlug = async (slug: string) => (await ctx.db.select().from(articles).where(eq(articles.slug, slug)))[0]!;
    const retract = await bySlug("kerala-outpatient-timetable");
    await performAction(ctx.db, boss, retract.id, { action: "retract", expectedVersion: retract.lockVersion, idempotencyKey: key(), reason: "Bulletin withdrawn", publicNote: "Retracted: the bulletin was withdrawn." }, now);
    const remove = await bySlug("journal-submission-window");
    await performAction(ctx.db, boss, remove.id, { action: "remove", expectedVersion: remove.lockVersion, idempotencyKey: key(), reason: "Court order", removalStatus: 451 }, now);
    const withdraw = { schema_version: 1, event_id: crypto.randomUUID(), source_id: "state-bulletin-demo", external_id: "notice-206", revision: 2, event_type: "item.withdraw", source_url: "https://health.example/notices/206", observed_at: now.toISOString(), reason: "Issued in error" };
    await send(ctx, ctx.seed.producers.a, withdraw, now);
    await drain(ctx, now);

    // Simulate a point-in-time restore taken before the takedowns: feed rows and flags come back
    // as they were. The suppression records are reapplied from the decision log before traffic reopens.
    await ctx.db.execute(sql`update feed_entries set status = 'active' where article_id in (${retract.id}, ${remove.id})`);
    await ctx.db.execute(sql`update feed_entries set status = 'active' where id = (select id from feed_entries where source_item_id = (select id from source_items where external_id = 'notice-206') order by created_at desc limit 1)`);
    await ctx.db.execute(sql`update articles set is_indexable = true, status = 'published' where id in (${retract.id}, ${remove.id})`);
    await ctx.db.execute(sql`update source_items set status = 'active' where external_id = 'notice-206'`);

    // Even before reconciliation runs, the read path refuses to serve them.
    const later = at(60);
    expect(await getPublicArticle(ctx.db, "kerala-outpatient-timetable", later)).toMatchObject({ kind: "retracted", note: "Retracted: the bulletin was withdrawn." });
    expect(await getPublicArticle(ctx.db, "journal-submission-window", later)).toEqual({ kind: "gone", status: 451 });
    const feed = await listPublicFeed(ctx.db, later, { limit: 50 });
    expect(feed.map((f) => f.url)).not.toEqual(expect.arrayContaining(["/news/kerala-outpatient-timetable", "/news/journal-submission-window", "https://health.example/notices/206"]));
    expect((await listPublicFeed(ctx.db, later, { limit: 50, channel: "rss" })).map((f) => f.url)).not.toContain("https://health.example/notices/206");
    expect((await searchPublic(ctx.db, later, { q: "outpatient timetable" })).items.map((i) => i.url)).not.toContain("/news/kerala-outpatient-timetable");

    // Reconciliation repairs the rows and queues purges.
    const before = ctx.delivered.length;
    const tick = await drain(ctx, later);
    expect(tick.reconciled).toMatchObject({ suppressionsReapplied: 3 });
    expect(await ctx.db.select().from(feedEntries).where(eq(feedEntries.articleId, retract.id))).toMatchObject([{ status: "suppressed" }]);
    expect((await bySlug("journal-submission-window")).isIndexable).toBe(false);
    expect(ctx.delivered.slice(before).filter((d) => d.event.eventType === "article.suppressed")).toHaveLength(10);
    expect((await ctx.db.select().from(auditEntries).where(eq(auditEntries.action, "reconcile"))).length).toBe(1);
    // A second pass finds nothing to do.
    expect(await reconcile(ctx.db, at(61))).toMatchObject({ suppressionsReapplied: 0, scheduledJobsRestored: 0 });
    await ctx.db.update(sourceItems).set({ status: "withdrawn" }).where(eq(sourceItems.externalId, "notice-206"));
  });

  it("reports a public story that lost its source, and keeps sitemap flags honest", async () => {
    const story = (await ctx.db.select().from(articles).where(eq(articles.slug, "district-plan-template-consultation")))[0]!;
    // Citations are immutable in normal operation; this stands in for damaged or partially restored data.
    await ctx.db.execute(sql`alter table article_citations disable trigger article_citations_immutable`);
    await ctx.db.execute(sql`delete from article_citations where version_id = ${story.publicVersionId}`);
    await ctx.db.execute(sql`alter table article_citations enable trigger article_citations_immutable`);
    await ctx.db.execute(sql`update articles set is_indexable = true where type = 'original_brief' and public_version_id is null`);
    const report = await reconcile(ctx.db, at(70));
    expect(report.storiesMissingSource).toEqual(["district-plan-template-consultation"]);
    expect((await ctx.db.select().from(editorialTasks).where(eq(editorialTasks.kind, "story_missing_source"))).length).toBe(1);
    await reconcile(ctx.db, at(71));
    expect((await ctx.db.select().from(editorialTasks).where(eq(editorialTasks.kind, "story_missing_source"))).length).toBe(1);
  });
});

describe("AT-08 · ING, OPS — a missed scheduled release is recovered once", () => {
  let ctx: Ctx;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  it("publishes late when the worker was down, and restores a lost job without duplicating it", async () => {
    const reporter = await ctx.actor("reporter");
    const editor = await ctx.actor("editor");
    const c = await createArticle(ctx.db, reporter, ROUTINE_STORY, T0);
    let v = (await performAction(ctx.db, reporter, c.id, { action: "submit", expectedVersion: c.version, idempotencyKey: key() }, at(1))).version;
    v = (await performAction(ctx.db, editor, c.id, { action: "approve-editorial", expectedVersion: v, idempotencyKey: key() }, at(2))).version;
    await performAction(ctx.db, editor, c.id, { action: "schedule", expectedVersion: v, idempotencyKey: key(), scheduledAt: at(30).toISOString().replace("Z", "+00:00") }, at(3));

    // The job row is lost (for example, restored from a backup taken before scheduling).
    await ctx.db.delete(jobs);
    expect((await getPublicArticle(ctx.db, c.slug, at(45))).kind).toBe("not_found");
    // The worker comes back fifteen minutes late. Reconciliation restores the job; the next pass runs it.
    const first = await drain(ctx, at(45));
    expect(first.reconciled.scheduledJobsRestored).toBe(1);
    await drain(ctx, at(46));
    const page = await getPublicArticle(ctx.db, c.slug, at(46));
    expect(page.kind).toBe("ok");
    // The publication time is when it actually went public, not the time it was meant to.
    expect(page.kind === "ok" && page.article.publishedAt.toISOString()).toBe(at(46).toISOString());
    expect((await drain(ctx, at(47))).reconciled.scheduledJobsRestored).toBe(0);
    expect(await ctx.db.select().from(jobs)).toHaveLength(1);
    expect(await countSitemapArticles(ctx.db, at(47))).toBe(1);

    // A source that keeps sending during the outage is processed in order when the worker returns.
    for (const rev of [1, 2, 3]) await send(ctx, ctx.seed.producers.a, notice({ external_id: "outage-1", source_url: "https://health.example/notices/500", revision: rev, source_title: `Office notice, revision ${rev}` }), at(50 + rev));
    await drain(ctx, at(60));
    expect((await listPublicFeed(ctx.db, at(60))).filter((f) => f.isExternal).map((f) => f.title)).toEqual(["Office notice, revision 3"]);
  });
});
