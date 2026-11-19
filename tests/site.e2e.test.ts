/**
 * Reader site over HTTP, as a crawler or a reader with JavaScript disabled
 * would see it. Covers the HTTP parts of AT-09 and the index policy table.
 * Runs against a production build: `npm run test:site`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { articles, featureFlags, sourceRevisions } from "@/db/schema";
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
    expect(home.includes('<a class="read-at ext" href="https://health.example/notices/206" rel="noopener external">Read at State Health Bulletin')).toBe(true);
    expect(home).not.toContain('href="/news/appointment');
    expect(home).toContain("Source update");
  });

  it("labels a partner copy, credits the original author and keeps it noindex", async () => {
    await ctx.db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, "indexing"));
    const copy = await html("/news/community-clinic-timetable-published");
    expect(copy).toContain("Republished from Partner Health Wire");
    expect(copy).toContain("By Partner Health Wire");
    expect(robots(copy)).toContain("noindex");
    // With indexing switched on, an original report is indexable; search and paginated pages are not.
    expect(robots(await html("/news/district-reporting-calendar"))).toBe("index, follow, max-image-preview:large");
    expect(robots(await html("/search?q=district"))).toContain("noindex");
    const latest = await html("/latest");
    expect(robots(latest)).toContain("index, follow");
    expect(canonical(latest)).toBe(`${ORIGIN}/latest`);
    // A thin hub and a placeholder policy page stay out of the index.
    expect(robots(await html("/section/policy"))).toContain("noindex");
    expect(robots(await html("/privacy"))).toContain("noindex");
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
