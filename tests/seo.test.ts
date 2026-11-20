/** Sitemap boundaries (AT-10) and structured data (AT-11, SD-01..04). */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { articles, featureFlags } from "@/db/schema";
import { seedDemoContent } from "@/db/seed-content";
import { createArticle, patchArticle, performAction } from "@/core/articles";
import { articleGraph, homeGraph, hubGraph, istIso, profileGraph, serializeJsonLd, validateGraph } from "@/core/jsonld";
import { getPublicArticle, listPublicFeed } from "@/core/public";
import { countSitemapArticles, getArticleContext, listSitemapArticles, NEWS_WINDOW_MS } from "@/core/reader";
import { at, createCtx, type Ctx, key, T0 } from "./helpers";

const site = { origin: "https://news.test", name: "India Health News" };

describe("AT-10 · SEO — sitemap membership and limits", () => {
  let ctx: Ctx;
  const now = at(0);
  const since = new Date(now.getTime() - NEWS_WINDOW_MS);
  beforeAll(async () => {
    ctx = await createCtx();
    // 1,001 eligible stories inside 48 hours, plus one aged 48 hours and one second.
    // Separate statements: rows written by one statement are not visible to its own sibling clauses.
    await ctx.db.execute(sql`
      insert into articles (slug, type, status, is_indexable, first_published_at, created_at, updated_at)
      select 'bulk-' || g, 'original_brief', 'published', true,
             case when g = 0 then ${new Date(since.getTime() - 1000).toISOString()}::timestamptz
                  else ${now.toISOString()}::timestamptz - (g || ' seconds')::interval end,
             now(), now()
      from generate_series(0, 1001) g`);
    await ctx.db.execute(sql`insert into article_versions (article_id, version, headline, body, content_hash) select id, 1, 'Bulk story ' || slug, '[]'::jsonb, 'x' from articles where slug like 'bulk-%'`);
    await ctx.db.execute(sql`update articles a set public_version_id = v.id, draft_version_id = v.id from article_versions v where v.article_id = a.id and a.slug like 'bulk-%'`);
    await ctx.db.execute(sql`
      insert into feed_entries (kind, article_id, display_title, publisher_name, target_url, visible_from, scope)
      select 'article', a.id, 'Bulk story ' || a.slug, 'India Health News', '/news/' || a.slug, a.first_published_at, '{web,rss}' from articles a where a.slug like 'bulk-%'`);
    await ctx.db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, "indexing"));
  });
  afterAll(() => ctx.close());

  it("keeps each news shard at 1,000 entries or fewer and ages out at 48 hours", async () => {
    expect(await countSitemapArticles(ctx.db, now, since)).toBe(1001);
    const shard1 = await listSitemapArticles(ctx.db, now, { since, limit: 1000, offset: 0 });
    const shard2 = await listSitemapArticles(ctx.db, now, { since, limit: 1000, offset: 1000 });
    expect(shard1).toHaveLength(1000);
    expect(shard2).toHaveLength(1);
    const news = new Set([...shard1, ...shard2].map((r) => r.slug));
    expect(news.has("bulk-0")).toBe(false);
    // The aged-out story stays in the general sitemap.
    expect(await countSitemapArticles(ctx.db, now)).toBe(1002);
    expect((await listSitemapArticles(ctx.db, now, { limit: 5, offset: 0 }))[0]!.slug).toBe("bulk-0");
    // The window keeps moving when nothing new is published.
    const later = new Date(now.getTime() + NEWS_WINDOW_MS - 500_000);
    expect(await countSitemapArticles(ctx.db, later, new Date(later.getTime() - NEWS_WINDOW_MS))).toBe(499);
  });

  it("never lists a draft, a removed story or a non-indexable one", async () => {
    const set = (slug: string, values: Partial<typeof articles.$inferInsert>) => ctx.db.update(articles).set(values).where(eq(articles.slug, slug));
    await set("bulk-10", { isIndexable: false });
    await ctx.db.execute(sql`insert into suppressions (subject_type, subject_id, kind, reason) select 'article', id, 'removal_410', 'test' from articles where slug = 'bulk-11'`);
    await ctx.db.execute(sql`update feed_entries set status = 'suppressed' where article_id = (select id from articles where slug = 'bulk-12')`);
    await ctx.db.execute(sql`update articles set public_version_id = null where slug = 'bulk-13'`);
    const all = new Set((await listSitemapArticles(ctx.db, now, { limit: 5000, offset: 0 })).map((r) => r.slug));
    for (const s of ["bulk-10", "bulk-11", "bulk-12", "bulk-13"]) expect(all.has(s), s).toBe(false);
    expect(all.size).toBe(998);
  });
});

describe("AT-11 · SD — the graph matches the page for the first and corrected revisions", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await createCtx();
    await seedDemoContent(ctx.db, ctx.seed, T0);
  });
  afterAll(() => ctx.close());

  const graphFor = async (slug: string, now: Date) => {
    const r = await getPublicArticle(ctx.db, slug, now);
    if (r.kind !== "ok") throw new Error(`not public: ${slug}`);
    const c = await getArticleContext(ctx.db, r.article.id, r.article.publicVersionId);
    const graph = articleGraph(site, { slug, type: r.article.type, headline: r.article.headline, section: c.section, author: r.article.author, publishedAt: r.article.publishedAt, modifiedAt: r.article.modifiedAt, citations: r.article.citations.map((x) => x.url), reviewer: c.medicalReview ? { name: c.medicalReview.name, slug: c.medicalReview.slug, hasProfile: c.medicalReview.isPublic } : null });
    return { graph, article: r.article, story: graph["@graph"].find((n) => n["@type"] === "NewsArticle"), page: graph["@graph"].find((n) => n["@type"] === "WebPage") };
  };

  it("emits a valid, connected NewsArticle graph with fixed publication date and no modification date before a correction", async () => {
    const { graph, article, story, page } = await graphFor("kerala-outpatient-timetable", at(1));
    expect(validateGraph(graph)).toEqual([]);
    expect(story).toMatchObject({
      "@id": "https://news.test/news/kerala-outpatient-timetable#story",
      headline: article.headline,
      url: "https://news.test/news/kerala-outpatient-timetable",
      author: { "@id": "https://news.test/authors/mira#person" },
      publisher: { "@id": "https://news.test/#org" },
      mainEntityOfPage: { "@id": "https://news.test/news/kerala-outpatient-timetable#page" },
      articleSection: "Healthcare Delivery",
      inLanguage: "en-IN",
      datePublished: istIso(article.publishedAt),
      citation: ["https://kerala-health.example/notices/31"],
    });
    expect(story).not.toHaveProperty("dateModified");
    expect(story).not.toHaveProperty("image");
    expect(story!.datePublished).toMatch(/\+05:30$/);
    expect(page).toMatchObject({ mainEntity: { "@id": story!["@id"] } });
    expect(graph["@graph"].find((n) => n["@type"] === "Person")).toMatchObject({ name: "Mira Rao", url: "https://news.test/authors/mira" });
    expect(graph["@graph"].filter((n) => n["@type"] === "NewsMediaOrganization")).toHaveLength(1);
  });

  it("keeps the first publication date and adds a genuine modification date after a correction", async () => {
    const before = await graphFor("kerala-outpatient-timetable", at(1));
    const [a] = await ctx.db.select().from(articles).where(eq(articles.slug, "kerala-outpatient-timetable"));
    const reporter = await ctx.actor("reporter");
    const editor = await ctx.actor("editor");
    const edited = await patchArticle(ctx.db, reporter, a!.id, { expectedVersion: a!.lockVersion, headline: "Kerala clinics publish a revised outpatient timetable", correctionNote: "Corrected the number of districts." }, at(10));
    let v = (await performAction(ctx.db, reporter, a!.id, { action: "submit", expectedVersion: edited.version, idempotencyKey: key() }, at(11))).version;
    v = (await performAction(ctx.db, editor, a!.id, { action: "approve-editorial", expectedVersion: v, idempotencyKey: key() }, at(12))).version;
    await performAction(ctx.db, editor, a!.id, { action: "correct", expectedVersion: v, idempotencyKey: key() }, at(13));
    const after = await graphFor("kerala-outpatient-timetable", at(14));
    expect(validateGraph(after.graph)).toEqual([]);
    expect(after.story).toMatchObject({ headline: "Kerala clinics publish a revised outpatient timetable", datePublished: before.story!.datePublished, dateModified: istIso(at(13)) });
  });

  it("adds reviewedBy to the page only for a recorded medical review, and never marks a partner copy as our article", async () => {
    const clinical = await graphFor("dengue-bulletin-three-districts", at(1));
    expect(validateGraph(clinical.graph)).toEqual([]);
    expect(clinical.page).toMatchObject({ reviewedBy: { "@id": "https://news.test/authors/demo-reviewer#person" } });
    expect((await graphFor("kerala-outpatient-timetable", at(20))).page).not.toHaveProperty("reviewedBy");

    const copy = articleGraph(site, { slug: "partner-copy", type: "licensed_copy", headline: "Partner headline", section: null, author: null, publishedAt: T0, modifiedAt: null, citations: ["https://partner.example/wire/1"], reviewer: null });
    expect(validateGraph(copy)).toEqual([]);
    expect(copy["@graph"].some((n) => n["@type"] === "NewsArticle")).toBe(false);
  });

  it("builds valid graphs for every other template and serializes them safely", () => {
    const hub = hubGraph(site, { name: "Policy and Regulation", path: "/section/policy", kindLabel: "section", items: [{ name: "Our report", url: "/news/a" }, { name: "Source update", url: "https://health.example/notices/204" }] });
    for (const g of [homeGraph(site), hub, profileGraph(site, { name: "Mira Rao", slug: "mira", bio: "Reporter", jobTitle: "Reporter", credentials: null })]) expect(validateGraph(g)).toEqual([]);
    const list = (hub["@graph"][1]!.mainEntity as { itemListElement: { position: number; url: string }[] }).itemListElement;
    expect(list.map((i) => [i.position, i.url])).toEqual([[1, "https://news.test/news/a"], [2, "https://health.example/notices/204"]]);
    // A headline cannot break out of the script element.
    const hostile = articleGraph(site, { slug: "x", type: "original_brief", headline: 'Bad </script><script>alert(1)</script> <!-- headline', section: null, author: null, publishedAt: T0, modifiedAt: null, citations: [], reviewer: null });
    const text = serializeJsonLd(hostile);
    expect(text).not.toContain("<");
    expect(JSON.parse(text)["@graph"].find((n: { "@type": string }) => n["@type"] === "NewsArticle").headline).toContain("</script>");
    // The validator catches a dangling reference and a relative URL.
    const broken = homeGraph(site);
    broken["@graph"][1]!.publisher = { "@id": "https://news.test/#missing" };
    broken["@graph"][1]!.url = "/relative";
    expect(validateGraph(broken)).toHaveLength(2);
  });
});

describe("verbatim official releases (publisher decision, 20 Nov 2026)", () => {
  let ctx: Ctx;
  beforeAll(async () => void (ctx = await createCtx()));
  afterAll(() => ctx.close());

  const release = {
    type: "press_material",
    slug: "pib-gsdp-draft",
    canonicalUrl: "https://www.pib.gov.in/PressReleasePage.aspx?PRID=2338316",
    headline: "Union Ministry of Health Proposes Incorporation of Good Storage and Distribution Practices into Drugs Rules, 1945",
    standfirst: "Full text of a release issued through the Press Information Bureau.",
    body: [{ type: "paragraph", text: "The Union Ministry of Health and Family Welfare has proposed the incorporation of Good Storage and Distribution Practices guidelines." }],
    sectionSlug: "policy",
    citations: [{ url: "https://www.pib.gov.in/PressReleasePage.aspx?PRID=2338316", label: "Press release, 19 Nov 2026", publisherName: "Press Information Bureau", isPrimary: true }],
  };

  it("accepts a canonical address only for press material that cites it as the primary source", async () => {
    const editor = await ctx.actor("editor");
    await expect(createArticle(ctx.db, editor, { ...release, slug: "x1", type: "original_brief", contribution: "local_reporting", contributionNote: "n" }, T0)).rejects.toMatchObject({ status: 422 });
    await expect(createArticle(ctx.db, editor, { ...release, slug: "x2", citations: [{ ...release.citations[0], isPrimary: false }] }, T0)).rejects.toMatchObject({ status: 422 });
  });

  it("names the original as canonical, credits it, and keeps it out of the sitemaps", async () => {
    const editor = await ctx.actor("editor");
    const made = await createArticle(ctx.db, editor, release, T0);
    let v = made.version;
    for (const action of ["submit", "approve-editorial", "publish"] as const) v = (await performAction(ctx.db, editor, made.id, { action, expectedVersion: v, idempotencyKey: key() }, at(1))).version;
    const r = await getPublicArticle(ctx.db, "pib-gsdp-draft", at(2));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.article.canonicalUrl).toBe(release.canonicalUrl);
    expect((await listSitemapArticles(ctx.db, at(2), { limit: 100, offset: 0 })).map((s) => s.slug)).not.toContain("pib-gsdp-draft");
    expect(await countSitemapArticles(ctx.db, at(2))).toBe(0);
    // Still listed for readers.
    expect((await listPublicFeed(ctx.db, at(2))).map((f) => f.url)).toContain("/news/pib-gsdp-draft");
    const graph = JSON.stringify(articleGraph({ origin: "https://news.test", name: "Test" }, { slug: "pib-gsdp-draft", type: "press_material", reproduced: true, headline: release.headline, section: null, author: null, publishedAt: at(1), modifiedAt: null, citations: [], reviewer: null }));
    expect(graph).not.toContain("NewsArticle");
  });

  it("lists a release at the time it was issued, with release details in place of the standfirst", async () => {
    const editor = await ctx.actor("editor");
    const issued = "2026-07-24T17:30:00+05:30";
    await expect(createArticle(ctx.db, editor, { ...release, slug: "x3", canonicalUrl: undefined, citations: release.citations, sourceIssuedAt: issued }, T0)).rejects.toMatchObject({ status: 422 });
    await expect(createArticle(ctx.db, editor, { ...release, slug: "x4", sourceIssuedAt: "2027-01-01T00:00:00+05:30" }, T0)).rejects.toMatchObject({ status: 422 });
    const made = await createArticle(ctx.db, editor, { ...release, slug: "pib-july", canonicalUrl: "https://pib.gov.in/PressReleasePage.aspx?PRID=1", citations: [{ ...release.citations[0], url: "https://pib.gov.in/PressReleasePage.aspx?PRID=1" }], sourceIssuedAt: issued, sourceIssuer: "Ministry of Health and Family Welfare" }, T0);
    let v = made.version;
    for (const action of ["submit", "approve-editorial", "publish"] as const) v = (await performAction(ctx.db, editor, made.id, { action, expectedVersion: v, idempotencyKey: key() }, at(3))).version;

    const r = await getPublicArticle(ctx.db, "pib-july", at(4));
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.article.sourceIssuedAt).toEqual(new Date(issued));
    expect(r.article.publishedAt).toEqual(at(3));
    const feed = await listPublicFeed(ctx.db, at(4));
    const item = feed.find((f) => f.url === "/news/pib-july")!;
    expect(item.visibleFrom).toEqual(new Date(issued));
    // Older than the release published earlier in this suite, so it sorts after it.
    expect(feed.findIndex((f) => f.url === "/news/pib-july")).toBeGreaterThan(feed.findIndex((f) => f.url === "/news/pib-gsdp-draft"));
  });
});
