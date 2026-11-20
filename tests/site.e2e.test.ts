/**
 * Reader site over HTTP, as a crawler or a reader with JavaScript disabled
 * would see it. Covers the HTTP parts of AT-09 and the index policy table.
 * Runs against a production build: `npm run test:site`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { articles, featureFlags, sourceRevisions, staffSessions } from "@/db/schema";
import { sha256Hex } from "@/core/crypto";
import { seedDemoContent } from "@/db/seed-content";
import { createArticle, createLicensedCopy, performAction, renameSlug } from "@/core/articles";
import { createCtx, type Ctx, key, ROUTINE_STORY } from "./helpers";

const PORT = 3200 + Math.floor(Math.random() * 500);
const ORIGIN = "https://news.test";
const base = `http://127.0.0.1:${PORT}`;
let ctx: Ctx;
let server: ChildProcess;

const get = (path: string) => fetch(base + path, { redirect: "manual" });
// React separates adjacent text with empty comment nodes. They are not content.
const html = async (path: string) => (await (await get(path)).text()).replaceAll("<!-- -->", "");
const robots = (page: string) => page.match(/<meta name="robots" content="([^"]+)"/)?.[1] ?? "";
const canonical = (page: string) => page.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? "";

beforeAll(async () => {
  ctx = await createCtx();
  const now = new Date();
  await seedDemoContent(ctx.db, ctx.seed, now);
  const reporter = await ctx.actor("reporter");
  const editor = await ctx.actor("editor");
  const boss = await ctx.actor("managingEditor");
  const bySlug = async (slug: string) => (await ctx.db.select().from(articles).where(eq(articles.slug, slug)))[0]!;

  // A private draft that must never be reachable.
  await createArticle(ctx.db, reporter, { ...ROUTINE_STORY, slug: "private-draft", headline: "Unpublished draft about a secret calendar" }, now);
  // A moved story.
  const moved = await bySlug("journal-submission-window");
  await renameSlug(ctx.db, editor, moved.id, { expectedVersion: moved.lockVersion, slug: "journal-window", reason: "Shorter address" }, now);
  // A retracted story and a removed one.
  const retract = await bySlug("device-procurement-workshop-dates");
  await performAction(ctx.db, boss, retract.id, { action: "retract", expectedVersion: retract.lockVersion, idempotencyKey: key(), reason: "Notice issued in error", publicNote: "The underlying notice was issued in error." }, now);
  const remove = await bySlug("bengaluru-hospital-board-schedule");
  await performAction(ctx.db, boss, remove.id, { action: "remove", expectedVersion: remove.lockVersion, idempotencyKey: key(), reason: "Legal removal", removalStatus: 451 }, now);
  // A labelled partner copy.
  await ctx.db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, "licensed_feeds"));
  const [wire] = await ctx.db.select().from(sourceRevisions).where(eq(sourceRevisions.title, "Community clinic timetable published"));
  const copy = await createLicensedCopy(ctx.db, editor, { sourceRevisionId: wire!.id, body: [{ type: "paragraph", text: "The clinic network has published its timetable for the quarter." }], sectionSlug: "healthcare-delivery" }, now);
  const v = (await performAction(ctx.db, editor, copy.id, { action: "approve-editorial", expectedVersion: copy.version, idempotencyKey: key() }, now)).version;
  await performAction(ctx.db, editor, copy.id, { action: "publish", expectedVersion: v, idempotencyKey: key() }, now);

  server = spawn("npx", ["next", "start", "-p", String(PORT)], { env: { ...process.env, DATABASE_URL: ctx.url, SITE_URL: ORIGIN, NODE_ENV: "production" }, stdio: "ignore", detached: true });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await get("/about")).status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("site did not start");
}, 90_000);

afterAll(async () => {
  if (server?.pid) process.kill(-server.pid);
  await ctx?.close();
});

describe("AT-09 · WEB, SEO — article HTML, canonical, moved and missing addresses", () => {
  it("serves headline, body, byline and a clickable original source without JavaScript", async () => {
    const res = await get("/news/district-reporting-calendar");
    expect(res.status).toBe(200);
    const page = (await res.text()).replaceAll("<!-- -->", "");
    expect(page).toContain("<h1>What changed in the district reporting calendar</h1>");
    expect(page).toContain("The new notice revises the reporting calendar.");
    expect(page).toMatch(/By <a href="\/authors\/mira">Mira Rao<\/a>/);
    expect(page).toMatch(/<a class="open ext" href="https:\/\/health\.example\/notices\/204"/);
    expect(page).toContain('href="https://health.example/notices/173"');
    expect(page).toMatch(/Published <time dateTime="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+05:30">[^<]+ IST<\/time>/i);
    expect(page).toMatch(/Updated <time/);
    expect(page).toContain("An earlier version gave the wrong closing day");
    expect(page).toContain('<html lang="en-IN"');
    // The primary source link comes before the body in reading order.
    expect(page.indexOf("Open original source")).toBeLessThan(page.indexOf("The new notice revises"));
  });

  it("keeps one canonical address across parameter variants", async () => {
    const plain = await html("/news/district-reporting-calendar");
    const tracked = await html("/news/district-reporting-calendar?utm_source=wa&fbclid=abc");
    expect(canonical(plain)).toBe(`${ORIGIN}/news/district-reporting-calendar`);
    expect(canonical(tracked)).toBe(canonical(plain));
    expect(tracked).toContain(`https://wa.me/?text=${encodeURIComponent(`What changed in the district reporting calendar ${ORIGIN}/news/district-reporting-calendar`)}`);
  });

  it("redirects a moved story once and returns 404 for a missing one", async () => {
    const res = await get("/news/journal-submission-window");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/news/journal-window");
    expect((await get("/news/journal-window")).status).toBe(200);
    expect((await get("/news/no-such-story")).status).toBe(404);
    expect((await get("/section/no-such-section")).status).toBe(404);
  });
});

describe("public surfaces never leak private or removed content", () => {
  it("returns 404 for a draft and keeps it out of listings and search", async () => {
    expect((await get("/news/private-draft")).status).toBe(404);
    for (const path of ["/", "/latest", "/section/policy", "/search?q=secret+calendar", "/authors/mira"]) {
      expect((await html(path)).includes("Unpublished draft"), path).toBe(false);
    }
  });

  it("shows a dated notice for a retraction and removes the claims", async () => {
    const res = await get("/news/device-procurement-workshop-dates");
    expect(res.status).toBe(200);
    const page = (await res.text()).replaceAll("<!-- -->", "");
    expect(page).toContain("This report has been retracted");
    expect(page).toContain("The underlying notice was issued in error.");
    expect(page).not.toContain("Two sessions are planned");
    expect(robots(page)).toContain("noindex");
    expect(await html("/latest")).not.toContain("device procurement workshop");
  });

  it("answers a mandatory removal with 451 and no content", async () => {
    const res = await get("/news/bengaluru-hospital-board-schedule");
    expect(res.status).toBe(451);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toContain("teaching hospital");
    expect(await html("/search?q=Bangalore")).toContain("No results for");
  });
});

describe("index policy and labelling", () => {
  it("links a source card straight to the publisher and never to a local page", async () => {
    const home = await html("/");
    // The front page shows a card as a teaser: the headline links straight to the publisher, which is named.
    expect(home).toMatch(/<a class="ext" href="https:\/\/health\.example\/notices\/206" rel="noopener external">[^<]+<span class="visually-hidden"> \(at State Health Bulletin\)<\/span><\/a>/);
    // Listings keep the full card with its "Read at" link.
    expect(await html("/latest")).toContain('<a class="read-at ext" href="https://health.example/notices/206" rel="noopener external">Read at State Health Bulletin');
    expect(home).not.toContain('href="/news/appointment');
    expect(home).toContain("Source update");
  });

  it("labels a partner copy, credits the original author and indexes every page with content", async () => {
    await ctx.db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, "indexing"));
    const copy = await html("/news/community-clinic-timetable-published");
    expect(copy).toContain("Republished from Partner Health Wire");
    expect(copy).toContain("By Partner Health Wire");
    expect(robots(copy)).toBe("index, follow, max-image-preview:large");
    // With indexing switched on, every story is indexable; search and paginated pages are not.
    expect(robots(await html("/news/district-reporting-calendar"))).toBe("index, follow, max-image-preview:large");
    expect(robots(await html("/search?q=district"))).toContain("noindex");
    const latest = await html("/latest");
    expect(robots(latest)).toContain("index, follow");
    expect(canonical(latest)).toBe(`${ORIGIN}/latest`);
    // A hub with material and every policy page are indexable; an empty hub and a cursor page are not.
    expect(robots(await html("/section/policy"))).toContain("index, follow");
    expect(robots(await html("/state/goa"))).toContain("noindex");
    expect(robots(await html("/latest?before=2026-01-01T00:00:00.000Z_00000000-0000-0000-0000-000000000000"))).toContain("noindex");
    const privacy = await html("/privacy");
    expect(robots(privacy)).toContain("index, follow");
    expect(privacy).toContain("still to be confirmed by the publisher");
    expect(privacy).toContain("Version 1, effective");
  });

  it("is noindex everywhere while the indexing rollout flag is off", async () => {
    await ctx.db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "indexing"));
    for (const path of ["/", "/latest", "/news/district-reporting-calendar", "/corrections", "/states"]) {
      expect(robots(await html(path)), path).toContain("noindex");
    }
  });

  it("offers a recovery action on an empty search and resolves a renamed place", async () => {
    const empty = await html("/search?q=zzzzqq&state=kerala");
    expect(empty).toContain("No results for");
    expect(empty).toContain("Search all of India without filters");
    const alias = await get("/state/orissa");
    expect(alias.status).toBe(308);
    expect(alias.headers.get("location")).toBe("/state/odisha");
  });
});

describe("newsroom and staff API (ADM-01, ADM-02, SEC-02, AT-14)", () => {
  const cookieFor = async (role: "reporter" | "editor" | "managingEditor") => {
    const token = `test-${role}-${Math.random().toString(36).slice(2)}`;
    await ctx.db.insert(staffSessions).values({ personId: ctx.seed.people[role], tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 3600_000) });
    return `ihn_session=${token}`;
  };
  const api = (path: string, method: string, body: unknown, cookie?: string, origin: string | null = base) =>
    fetch(base + path, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  const draft = { type: "original_brief", headline: "Private newsroom draft about tender dates", standfirst: "Not for readers yet.", body: [{ type: "paragraph", text: "Working text about the tender calendar." }], sectionSlug: "policy", contribution: "local_reporting", contributionNote: "Spoke to the tender office.", citations: [{ url: "https://health.example/notices/300", label: "Tender notice", publisherName: "State Health Bulletin", isPrimary: true }] };

  it("opens on the dashboard for signed-in staff, with the queue one link away", async () => {
    const cookie = await cookieFor("editor");
    const page = async (path: string) => (await (await fetch(base + path, { redirect: "manual", headers: { Cookie: cookie } })).text()).replaceAll("<!-- -->", "");
    const dash = await page("/newsroom");
    expect(dash).toContain("<h1>Dashboard</h1>");
    for (const text of ["Needs attention", "Published today", "Live on the site", "Sources and rights", "Intake and background work", 'href="/newsroom/queue"']) expect(dash, text).toContain(text);
    // The chart is server-rendered SVG: no script is needed to read it.
    expect(dash).toMatch(/<svg[^>]+role="img"/);
    expect(await page("/newsroom/queue")).toContain("<h1>Queue</h1>");
    // Optional: keep a self-contained copy of the page for a visual check.
    if (process.env.SNAPSHOT_DIR) {
      const css = await Promise.all([...dash.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(async (m) => (await get(m[1]!)).text()));
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(process.env.SNAPSHOT_DIR, { recursive: true });
      await writeFile(`${process.env.SNAPSHOT_DIR}/dashboard.html`, dash.replace("</head>", `<style>${css.join("\n")}</style></head>`).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
    }
  });

  it("keeps the newsroom and previews behind sign-in, uncached and unindexed", async () => {
    for (const path of ["/newsroom", "/newsroom/queue", "/newsroom/stories", "/newsroom/settings", "/newsroom/stories/00000000-0000-0000-0000-000000000000/preview"]) {
      const res = await get(path);
      expect(res.status, path).toBe(307);
      expect(res.headers.get("location")).toBe("/newsroom/login");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    const login = await get("/newsroom/login");
    expect(login.status).toBe(200);
    expect(robots(await login.text())).toContain("noindex");
    // A forged or expired cookie is the same as none.
    expect((await fetch(`${base}/newsroom`, { redirect: "manual", headers: { Cookie: "ihn_session=forged" } })).status).toBe(307);
    const res = await get("/");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("enforces session, origin, roles, versions and approvals on the staff API", async () => {
    expect((await api("/api/v1/staff/articles", "POST", draft)).status).toBe(401);
    const reporter = await cookieFor("reporter");
    const editor = await cookieFor("editor");
    // A cross-site request carrying the cookie is refused.
    expect((await api("/api/v1/staff/articles", "POST", draft, reporter, "https://evil.example")).status).toBe(403);
    expect((await api("/api/v1/staff/articles", "POST", draft, reporter, null)).status).toBe(403);

    const created = await api("/api/v1/staff/articles", "POST", draft, reporter);
    expect(created.status).toBe(201);
    const story = (await created.json()) as { id: string; slug: string; version: number };
    expect((await api("/api/v1/staff/articles", "POST", { ...draft, headline: "" }, reporter)).status).toBe(422);

    const saved = await api(`/api/v1/staff/articles/${story.id}`, "PATCH", { expectedVersion: story.version, standfirst: "Edited once." }, reporter);
    expect(saved.status).toBe(200);
    const stale = await api(`/api/v1/staff/articles/${story.id}`, "PATCH", { expectedVersion: story.version, standfirst: "Edited from a stale tab." }, editor);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "STALE_VERSION", current_version: story.version + 1 });

    const act = (cookie: string, action: string, expectedVersion: number, extra = {}) => api(`/api/v1/staff/articles/${story.id}/actions`, "POST", { action, expectedVersion, idempotencyKey: `e2e-${action}-${expectedVersion}-${Math.random()}`, ...extra }, cookie);
    const early = await act(editor, "publish", story.version + 1);
    expect(early.status).toBe(422);
    expect(((await early.json()) as { field_errors: { code: string }[] }).field_errors.map((f) => f.code)).toEqual(["EDITORIAL_APPROVAL_MISSING"]);
    expect((await act(reporter, "approve-editorial", story.version + 1)).status).toBe(403);

    // The private draft is visible in an authenticated preview and nowhere public.
    const preview = await fetch(`${base}/newsroom/stories/${story.id}/preview`, { headers: { Cookie: reporter } });
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("Private newsroom draft about tender dates");
    // A private draft must never be reachable at its future public address.
    const leak = await get(`/news/${story.slug}`);
    const leakBody = await leak.text();
    expect({ status: leak.status, hasDraft: leakBody.includes("Working text about"), hasHeadline: leakBody.includes("Private newsroom draft") }).toEqual({ status: 404, hasDraft: false, hasHeadline: false });
    expect(await html("/latest")).not.toContain("Private newsroom draft");

    const submitted = (await (await act(reporter, "submit", story.version + 1)).json()) as { version: number };
    const approved = (await (await act(editor, "approve-editorial", submitted.version)).json()) as { version: number };
    const published = await act(editor, "publish", approved.version);
    expect(published.status).toBe(200);
    expect((await get(`/news/${story.slug}`)).status).toBe(200);

    // Source commands: an editor cannot revoke; a managing editor needs a reason.
    const src = ctx.seed.sources.unknownGrant;
    expect((await api(`/api/v1/staff/sources/${src}/actions`, "POST", { action: "revoke", reason: "x" }, editor)).status).toBe(403);
    const boss = await cookieFor("managingEditor");
    expect((await api(`/api/v1/staff/sources/${src}/actions`, "POST", { action: "pause" }, boss)).status).toBe(422);
    const paused = await api(`/api/v1/staff/sources/${src}/actions`, "POST", { action: "pause", reason: "Rights unclear" }, boss);
    expect(await paused.json()).toMatchObject({ status: "paused", affected: { publicCards: 0 } });
  });

  it("shows the reader report form and never exposes case details publicly", async () => {
    const { submitCase } = await import("@/core/cases");
    const r = await submitCase(ctx.db, { reason: "privacy_concern", description: "My relative is identifiable in paragraph two.", contact: "private.person@example.org", clientKey: "e2e" }, new Date());
    expect(r.ok).toBe(true);
    const page = await html("/corrections?story=district-reporting-calendar");
    expect(page).toContain('name="description"');
    expect(page).toContain("About the report at /news/district-reporting-calendar");
    for (const path of ["/", "/latest", "/corrections", "/search?q=relative+identifiable", "/news/district-reporting-calendar"]) {
      const body = await html(path);
      expect(body.includes("private.person@example.org") || body.includes("is identifiable in paragraph"), path).toBe(false);
    }
    const reporter = await cookieFor("reporter");
    const cases = await (await fetch(`${base}/newsroom/cases`, { headers: { Cookie: reporter } })).text();
    expect(cases).not.toContain("private.person@example.org");
    const editorView = await (await fetch(`${base}/newsroom/cases`, { headers: { Cookie: await cookieFor("editor") } })).text();
    expect(editorView).toContain("private.person@example.org");
  });
});

describe("discovery outputs and cache invalidation (SEO-02, SD, ARC-02)", () => {
  const ld = (page: string) => JSON.parse(page.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]!) as { "@graph": Record<string, unknown>[] };

  it("renders JSON-LD that matches the visible article", async () => {
    const page = await html("/news/district-reporting-calendar");
    const graph = ld(page)["@graph"];
    const story = graph.find((n) => n["@type"] === "NewsArticle")!;
    expect(page).toContain(`<h1>${story.headline as string}</h1>`);
    expect(story.url).toBe(`${ORIGIN}/news/district-reporting-calendar`);
    expect(story.url).toBe(canonical(page));
    // The dates in the markup are the dates a reader sees.
    expect(page).toContain(`Published <time dateTime="${story.datePublished as string}">`);
    expect(page).toContain(`Updated <time dateTime="${story.dateModified as string}">`);
    for (const url of story.citation as string[]) expect(page).toContain(`href="${url}"`);
    const author = graph.find((n) => n["@type"] === "Person")!;
    expect(page).toContain(`<a href="/authors/mira">${author.name as string}</a>`);
    // A partner copy and a retraction carry no NewsArticle markup.
    expect(ld(await html("/news/community-clinic-timetable-published"))["@graph"].some((n) => n["@type"] === "NewsArticle")).toBe(false);
    expect(await html("/news/device-procurement-workshop-dates")).not.toContain("application/ld+json");
    expect(ld(await html("/section/policy"))["@graph"].some((n) => n["@type"] === "CollectionPage")).toBe(true);
    expect(ld(await html("/about"))["@graph"].some((n) => n["@type"] === "AboutPage")).toBe(true);
  });

  it("serves sitemaps, a news sitemap, robots.txt and RSS with the right membership", async () => {
    const robotsTxt = await (await get("/robots.txt")).text();
    expect(robotsTxt).toContain("Disallow: /newsroom");
    expect(robotsTxt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(robotsTxt).toContain(`Sitemap: ${ORIGIN}/news-sitemap.xml`);

    // With indexing off, the sitemaps list nothing.
    await ctx.db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "indexing"));
    expect(await (await get("/sitemaps/pages.xml")).text()).not.toContain("<loc>");
    await ctx.db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, "indexing"));

    const index = await (await get("/sitemap.xml")).text();
    expect(index).toContain(`<loc>${ORIGIN}/sitemaps/pages.xml</loc>`);
    expect(index).toContain(`<loc>${ORIGIN}/sitemaps/articles-1.xml</loc>`);
    const articlesXml = await (await get("/sitemaps/articles-1.xml")).text();
    expect(articlesXml).toContain(`<loc>${ORIGIN}/news/district-reporting-calendar</loc>`);
    expect(articlesXml).toContain(`<loc>${ORIGIN}/news/journal-window</loc>`);
    expect(articlesXml).toContain(`<loc>${ORIGIN}/news/community-clinic-timetable-published</loc>`);
    for (const absent of ["private-draft", "device-procurement-workshop-dates", "bengaluru-hospital-board-schedule", "journal-submission-window"]) expect(articlesXml, absent).not.toContain(absent);
    const pagesXml = await (await get("/sitemaps/pages.xml")).text();
    expect(pagesXml).toContain(`<loc>${ORIGIN}/corrections</loc>`);
    expect(pagesXml).toContain(`<loc>${ORIGIN}/submit-news</loc>`);
    expect(pagesXml).toContain(`<loc>${ORIGIN}/privacy</loc>`);
    expect(pagesXml).not.toContain("/search");
    expect((await get("/sitemaps/articles-2.xml")).status).toBe(404);

    const news = await (await get("/news-sitemaps/1.xml")).text();
    expect(news).toContain('xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"');
    expect(news).toMatch(/<news:publication_date>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+05:30<\/news:publication_date>/);
    expect(news).toContain("<news:title>What changed in the district reporting calendar</news:title>");
    expect(news).not.toContain("community-clinic");
    expect(await (await get("/news-sitemap.xml")).text()).toContain(`${ORIGIN}/news-sitemaps/1.xml`);

    const feed = await get("/feed.xml");
    expect(feed.headers.get("content-type")).toContain("application/rss+xml");
    const rss = await feed.text();
    expect(rss).toContain(`<link>${ORIGIN}/news/district-reporting-calendar</link>`);
    // A source card links to its origin and is described as a source update.
    expect(rss).toContain("<link>https://health.example/notices/206</link>");
    expect(rss).toContain("Source update from State Health Bulletin");
    // The partner grant covers the website only, so its copy and card stay out of RSS.
    expect(rss).not.toContain("partner.example");
    expect(rss).not.toContain("community-clinic");
    expect((await get("/section/policy/feed.xml")).status).toBe(200);
    expect((await get("/section/nope/feed.xml")).status).toBe(404);
  });

  it("drops cached pages as soon as a story is published or retracted through the newsroom", async () => {
    const token = `cache-${Math.random().toString(36).slice(2)}`;
    await ctx.db.insert(staffSessions).values({ personId: ctx.seed.people.managingEditor, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 3600_000) });
    const call = (path: string, method: string, body: unknown) => fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: `ihn_session=${token}`, Origin: base }, body: JSON.stringify(body) });
    // Warm the caches, including a 404 for the address the story will take.
    expect(await html("/")).not.toContain("Cache test");
    const created = (await (await call("/api/v1/staff/articles", "POST", { type: "original_brief", slug: "cache-test-story", headline: "Cache test: office hours notice compared", standfirst: "Checks invalidation.", body: [{ type: "paragraph", text: "The notice sets new office hours." }], sectionSlug: "policy", contribution: "local_reporting", contributionNote: "Called the office.", citations: [{ url: "https://health.example/notices/400", label: "Office hours notice", publisherName: "State Health Bulletin", isPrimary: true }] })).json()) as { id: string; version: number };
    expect((await get("/news/cache-test-story")).status).toBe(404);
    const act = async (action: string, v: number, extra = {}) => (await (await call(`/api/v1/staff/articles/${created.id}/actions`, "POST", { action, expectedVersion: v, idempotencyKey: `c-${action}-${Math.random()}`, ...extra })).json()) as { version: number };
    let v = (await act("submit", created.version)).version;
    v = (await act("approve-editorial", v)).version;
    v = (await act("publish", v)).version;
    const visible = async (path: string, text: string, want: boolean) => {
      for (let i = 0; i < 40; i++) {
        if ((await html(path)).includes(text) === want) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    };
    // Well inside the 60 second target for an approved publish (OPS-01).
    expect(await visible("/", "Cache test: office hours notice compared", true)).toBe(true);
    expect((await get("/news/cache-test-story")).status).toBe(200);
    await act("retract", v, { reason: "Test retraction", publicNote: "Withdrawn in a test." });
    expect(await visible("/", "Cache test: office hours notice compared", false)).toBe(true);
    expect(await visible("/news/cache-test-story", "This report has been retracted", true)).toBe(true);
  });
});
