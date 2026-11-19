/** Reader-site queries: listings, hubs, profiles, search and moved addresses (WEB-01..04, SEO-01). */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { articles, featureFlags, sourceGrants, sourceItems, sources, suppressions, terms } from "@/db/schema";
import { seedDemoContent } from "@/db/seed-content";
import { performAction, renameSlug } from "@/core/articles";
import { getPublicArticle } from "@/core/public";
import { buildTsQuery, countFeed, decodeCursor, encodeCursor, getAuthor, getHub, getLead, getSourceProfile, listCorrections, listFeed, listTermsWithContent, searchPublic } from "@/core/reader";
import { at, createCtx, type Ctx, key, T0 } from "./helpers";

describe("reader site", () => {
  let ctx: Ctx;
  const now = at(1);
  const term = async (kind: "section" | "state", slug: string) => (await ctx.db.select().from(terms).where(eq(terms.slug, slug))).find((t) => t.kind === kind)!.id;
  beforeAll(async () => {
    ctx = await createCtx();
    await seedDemoContent(ctx.db, ctx.seed, T0);
  });
  afterAll(() => ctx.close());

  it("lists everything public in time order with stable keyset pages", async () => {
    expect(await countFeed(ctx.db, now)).toBe(12);
    const first = await listFeed(ctx.db, now, { limit: 5 });
    expect(first.items).toHaveLength(5);
    expect(first.next).not.toBeNull();
    const second = await listFeed(ctx.db, now, { limit: 5, cursor: decodeCursor(encodeCursor(first.next!)) });
    const third = await listFeed(ctx.db, now, { limit: 5, cursor: second.next! });
    expect(third.next).toBeNull();
    const all = [...first.items, ...second.items, ...third.items];
    expect(new Set(all.map((i) => i.id)).size).toBe(12);
    expect(all.map((i) => i.visibleFrom.getTime())).toEqual([...all.map((i) => i.visibleFrom.getTime())].sort((a, b) => b - a));
    expect(decodeCursor("junk")).toBeUndefined();
  });

  it("distinguishes local reporting from an external source card", async () => {
    const { items } = await listFeed(ctx.db, now, { limit: 50 });
    const card = items.find((i) => i.title === "District reporting calendar released")!;
    expect(card).toMatchObject({ kind: "source_card", isExternal: true, publisher: "State Health Bulletin", url: "https://health.example/notices/204", author: null, state: { slug: "karnataka" } });
    expect(card.sourcePublishedAt).toBeInstanceOf(Date);
    const story = items.find((i) => i.url === "/news/district-reporting-calendar")!;
    expect(story).toMatchObject({ kind: "article", isExternal: false, author: { name: "Mira Rao", slug: "mira" }, section: { slug: "policy", name: "Policy and Regulation" }, state: { slug: "karnataka" } });
    expect(story.modifiedAt).toBeInstanceOf(Date);
  });

  it("picks the lead by editorial importance, then recency", async () => {
    expect((await getLead(ctx.db, now))?.url).toBe("/news/district-reporting-calendar");
    await ctx.db.update(articles).set({ leadRank: null });
    // With no editor choice the newest original leads. A newer source card never does.
    expect((await getLead(ctx.db, now))?.url).toBe("/news/district-reporting-calendar");
    await ctx.db.update(articles).set({ leadRank: 5, leadUntil: at(-1) }).where(eq(articles.slug, "journal-submission-window"));
    expect((await getLead(ctx.db, now))?.url).toBe("/news/district-reporting-calendar");
    await ctx.db.update(articles).set({ leadUntil: at(60) }).where(eq(articles.slug, "journal-submission-window"));
    expect((await getLead(ctx.db, now))?.url).toBe("/news/journal-submission-window");
  });

  it("builds section and state hubs, resolves aliases and withholds thin hubs from the index", async () => {
    const policy = await getHub(ctx.db, "section", "policy", now);
    expect(policy).toMatchObject({ kind: "ok", originals: 2, indexable: false });
    const karnataka = await listFeed(ctx.db, now, { termId: await term("state", "karnataka"), limit: 50 });
    // Three stories tagged Karnataka plus two cards from the Karnataka source.
    expect(karnataka.items.filter((i) => i.kind === "article")).toHaveLength(3);
    expect(karnataka.items.filter((i) => i.kind === "source_card")).toHaveLength(2);
    expect(await getHub(ctx.db, "state", "orissa", now)).toEqual({ kind: "redirect", slug: "odisha" });
    expect(await getHub(ctx.db, "state", "atlantis", now)).toEqual({ kind: "not_found" });

    const states = await listTermsWithContent(ctx.db, "state", now);
    expect(states.map((s) => s.slug)).toEqual(["karnataka", "kerala", "tamil-nadu"]);

    // A hub is indexable only with enough originals, an editor's introduction, approval and the rollout flag.
    const id = await term("section", "policy");
    await ctx.db.update(terms).set({ intro: "Rules, notices and consultations.", isHubApproved: true }).where(eq(terms.id, id));
    await ctx.db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, "indexing"));
    expect(await getHub(ctx.db, "section", "policy", now)).toMatchObject({ indexable: false, originals: 2 });
  });

  it("serves author and publisher profiles and keeps stub records private", async () => {
    const mira = await getAuthor(ctx.db, "mira");
    expect(mira).toMatchObject({ name: "Mira Rao", roles: ["reporter"] });
    expect((await listFeed(ctx.db, now, { authorId: mira!.id, limit: 50 })).items).toHaveLength(7);
    expect((await getAuthor(ctx.db, "demo-reviewer"))?.reviews).toBe(1);
    expect(await getAuthor(ctx.db, "nobody")).toBeNull();

    const bulletin = await getSourceProfile(ctx.db, "state-bulletin-demo");
    expect(bulletin).toMatchObject({ name: "State Health Bulletin", homepageUrl: "https://health.example/", state: { slug: "karnataka" } });
    // The source filter matches the credited publisher on a card or a cited source on a report.
    const bySource = await listFeed(ctx.db, now, { sourceId: bulletin!.id, limit: 50 });
    expect(bySource.items.filter((i) => i.kind === "source_card")).toHaveLength(2);
    expect(bySource.items.filter((i) => i.kind === "article")).toHaveLength(6);
    await ctx.db.update(sources).set({ status: "under_review" }).where(eq(sources.slug, "unknown-grant-demo"));
    expect(await getSourceProfile(ctx.db, "unknown-grant-demo")).toBeNull();
  });

  it("ranks headline matches above body matches and breaks ties by recency", async () => {
    // "reporting" is in one headline and one card title, and in the body of other stories.
    const r = await searchPublic(ctx.db, now, { q: "reporting calendar" });
    expect(r.items.slice(0, 2).map((i) => i.title).sort()).toEqual(["District reporting calendar released", "What changed in the district reporting calendar"]);
    expect(r.total).toBe(r.items.length);
    const latest = await searchPublic(ctx.db, now, { q: "district", sort: "latest" });
    expect(latest.items.map((i) => i.visibleFrom.getTime())).toEqual([...latest.items.map((i) => i.visibleFrom.getTime())].sort((a, b) => b - a));
    expect(latest.total).toBeGreaterThan(4);
    const relevance = await searchPublic(ctx.db, now, { q: "district" });
    const tiers = relevance.items.map((i) => (i.title.toLowerCase().includes("district") ? 1 : 0));
    expect(tiers).toEqual([...tiers].sort((a, b) => b - a));
  });

  it("treats Bangalore and Bengaluru as the same word, and matches state names", async () => {
    expect(await buildTsQuery(ctx.db, "Bangalore hospital")).toBe("(bangalore | bengaluru) & (hospital)");
    for (const q of ["Bangalore", "Bengaluru", "bengalūru"]) {
      const r = await searchPublic(ctx.db, now, { q });
      expect(r.items.map((i) => i.url)).toEqual(["/news/bengaluru-hospital-board-schedule"]);
    }
    const kerala = await searchPublic(ctx.db, now, { q: "Kerala" });
    expect(kerala.items.map((i) => i.url)).toEqual(expect.arrayContaining(["/news/kerala-outpatient-timetable", "https://kerala-health.example/notices/31"]));
    // Filters narrow by state, and an empty or hostile query returns nothing rather than an error.
    const filtered = await searchPublic(ctx.db, now, { q: "district", stateId: await term("state", "kerala") });
    expect(filtered.items.every((i) => i.state?.slug === "kerala")).toBe(true);
    expect(filtered.total).toBeGreaterThan(0);
    expect((await searchPublic(ctx.db, now, { q: "  " })).total).toBe(0);
    expect((await searchPublic(ctx.db, now, { q: "'); drop table articles; -- & | ! :*" })).total).toBe(0);
    expect((await searchPublic(ctx.db, now, { q: "zzzzqqq" })).items).toEqual([]);
  });

  it("drops suppressed and unlicensed content from listings and search at query time", async () => {
    const before = (await searchPublic(ctx.db, now, { q: "dengue" })).total;
    expect(before).toBe(1);
    const [a] = await ctx.db.select().from(articles).where(eq(articles.slug, "dengue-bulletin-three-districts"));
    await performAction(ctx.db, await ctx.actor("managingEditor"), a!.id, { action: "retract", expectedVersion: a!.lockVersion, idempotencyKey: key(), reason: "Bulletin figures withdrawn", publicNote: "Retracted after the department withdrew the bulletin." }, now);
    expect((await searchPublic(ctx.db, now, { q: "dengue" })).total).toBe(0);
    expect((await listFeed(ctx.db, now, { limit: 50 })).items.map((i) => i.url)).not.toContain("/news/dengue-bulletin-three-districts");

    // Revoking the Kerala grant removes its cards everywhere, with no sweep needed.
    await ctx.db.update(sourceGrants).set({ revokedAt: at(0), revokedReason: "test" }).where(eq(sourceGrants.sourceId, ctx.seed.sources.bulletinKerala));
    const feed = (await listFeed(ctx.db, now, { limit: 50 })).items;
    expect(feed.filter((i) => i.publisher === "Kerala Health Bulletin")).toHaveLength(0);
    expect((await searchPublic(ctx.db, now, { q: "outpatient timetable" })).items.map((i) => i.kind)).toEqual(["article"]);
  });

  it("honours a tombstone at read time even if the feed row was never updated", async () => {
    // A restore from backup, or a failed job, can leave a feed row active. The suppression record still wins.
    const [a] = await ctx.db.select().from(articles).where(eq(articles.slug, "kerala-outpatient-timetable"));
    const [card] = await ctx.db.select().from(sourceItems).where(eq(sourceItems.externalId, "notice-206"));
    await ctx.db.insert(suppressions).values([
      { subjectType: "article", subjectId: a!.id, kind: "removal_410", reason: "test" },
      { subjectType: "source_item", subjectId: card!.id, kind: "source_withdrawal", reason: "test" },
    ]);
    const urls = (await listFeed(ctx.db, now, { limit: 50 })).items.map((i) => i.url);
    expect(urls).not.toContain("/news/kerala-outpatient-timetable");
    expect(urls).not.toContain("https://health.example/notices/206");
    expect((await searchPublic(ctx.db, now, { q: "outpatient timetable" })).total).toBe(0);
    expect(await getPublicArticle(ctx.db, "kerala-outpatient-timetable", now)).toEqual({ kind: "gone", status: 410 });
  });

  it("lists published corrections with their notes", async () => {
    const list = await listCorrections(ctx.db, now);
    expect(list).toMatchObject([{ url: "/news/district-reporting-calendar", note: "An earlier version gave the wrong closing day for the second reporting window." }]);
  });

  it("redirects a moved story in one hop, however many times it moves", async () => {
    const editor = await ctx.actor("editor");
    const [a] = await ctx.db.select().from(articles).where(eq(articles.slug, "district-plan-template-consultation"));
    const r1 = await renameSlug(ctx.db, editor, a!.id, { expectedVersion: a!.lockVersion, slug: "plan-template-consultation", reason: "Shorter address" }, now);
    const r2 = await renameSlug(ctx.db, editor, a!.id, { expectedVersion: r1.version, slug: "district-plan-consultation", reason: "Clearer address" }, now);
    expect(r2.slug).toBe("district-plan-consultation");
    for (const old of ["district-plan-template-consultation", "plan-template-consultation"]) {
      expect(await getPublicArticle(ctx.db, old, now)).toEqual({ kind: "redirect", slug: "district-plan-consultation" });
    }
    expect((await getPublicArticle(ctx.db, "district-plan-consultation", now)).kind).toBe("ok");
    expect((await listFeed(ctx.db, now, { limit: 50 })).items.map((i) => i.url)).toContain("/news/district-plan-consultation");
    // A former address stays reserved for its story.
    const [other] = await ctx.db.select().from(articles).where(eq(articles.slug, "journal-submission-window"));
    await expect(renameSlug(ctx.db, editor, other!.id, { expectedVersion: other!.lockVersion, slug: "plan-template-consultation", reason: "x" }, now)).rejects.toMatchObject({ status: 409, code: "SLUG_TAKEN" });
    expect((await getPublicArticle(ctx.db, "no-such-story", now)).kind).toBe("not_found");
  });
});
