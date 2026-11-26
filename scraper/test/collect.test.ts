import { describe, expect, it } from "vitest";
import { collect } from "../lib/collect";
import { buildEvent } from "../lib/event";
import { loadManifest, pickSources } from "../lib/manifest";
import { fakeWeb, item, rss, source, xml } from "./helpers";

const NOW = new Date("2026-11-26T06:00:00Z");
const FEED = "https://example.in/health/feed.xml";

describe("collect", () => {
  it("keeps on-host, in-scope, recent health items and counts why the rest were dropped", async () => {
    const web = fakeWeb({
      [FEED]: xml(
        rss([
          item({ title: "Dengue wards fill up", link: "https://example.in/health/dengue-1?utm_source=rss", guid: "a1", date: "Wed, 25 Nov 2026 15:52:27 +0530", description: "Cases rise." }),
          item({ title: "Malaria drive begins", link: "https://aajtak.example/health/m-1", guid: "a2", date: "Wed, 25 Nov 2026 10:00:00 +0530" }),
          item({ title: "Hospital photos", link: "https://example.in/photogallery/h-1", guid: "a3", date: "Wed, 25 Nov 2026 10:00:00 +0530" }),
          item({ title: "Sensex closes higher", link: "https://example.in/markets/s-1", guid: "a4", date: "Wed, 25 Nov 2026 10:00:00 +0530" }),
          item({ title: "Old TB report", link: "https://example.in/health/tb-0", guid: "a5", date: "Mon, 02 Nov 2026 10:00:00 +0530" }),
          item({ title: "Dengue wards fill up", link: "https://example.in/health/dengue-1", guid: "a1", date: "Wed, 25 Nov 2026 15:52:27 +0530" }),
          item({ title: "", link: "https://example.in/health/untitled", guid: "a6" }),
          item({ title: "Clinic opens", link: "https://example.in/health/clinic-7", guid: "a7" }),
        ]),
      ),
    });
    const src = source({ filter: "health", excludePaths: ["/photogallery"] });
    const { report, candidates } = await collect(web.http, src, { now: NOW, maxAgeDays: 7 });
    expect(report).toMatchObject({ outcome: "ok", httpStatus: 200, parsed: 8, kept: 2, offHost: 1, offPath: 1, notHealth: 1, tooOld: 1, duplicate: 1, invalid: 1 });
    expect(report.newestAt).toBe("2026-11-25T10:22:27.000Z");
    // Oldest first; the undated item sorts first.
    expect(candidates.map((c) => c.externalId)).toEqual(["a7", "a1"]);
    expect(candidates[0]).toMatchObject({ publishedAt: null, publishedReason: "feed gives no publication time" });
    expect(candidates[1]).toMatchObject({ sourceUrl: "https://example.in/health/dengue-1", title: "Dengue wards fill up", excerpt: "Cases rise.", publishedAt: "2026-11-25T10:22:27.000Z", adapterVersion: "rss@1.0.0" });
    // Every request names the bot.
    expect(web.calls.every((c) => c.headers["User-Agent"]?.startsWith("IndiaHealthNewsBot/1.0"))).toBe(true);
  });

  it("builds events that pass the platform's own v1 schema", async () => {
    const web = fakeWeb({ [FEED]: xml(rss([item({ title: "Clinic opens", link: "https://example.in/health/clinic-7", guid: "a7" })])) });
    const { candidates } = await collect(web.http, source(), { now: NOW, maxAgeDays: 7 });
    const built = buildEvent(candidates[0]!, 1, "6f1c2a0e-4b8d-4c55-9a51-0d4f6c3e2b10", NOW);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(JSON.parse(built.body)).toEqual({
      schema_version: 1,
      event_id: "6f1c2a0e-4b8d-4c55-9a51-0d4f6c3e2b10",
      source_id: "example-news",
      external_id: "a7",
      revision: 1,
      event_type: "item.upsert",
      source_url: "https://example.in/health/clinic-7",
      source_title: "Clinic opens",
      language: "en",
      source_published_at: null,
      source_published_at_reason: "feed gives no publication time",
      adapter_version: "rss@1.0.0",
      observed_at: "2026-11-26T06:00:00.000Z",
    });
    expect(buildEvent({ ...candidates[0]!, sourceUrl: "http://example.in/x" }, 1, "6f1c2a0e-4b8d-4c55-9a51-0d4f6c3e2b10", NOW)).toMatchObject({ ok: false });
  });

  it("sends validators on a conditional GET and treats 304 as nothing new", async () => {
    const web = fakeWeb({ [FEED]: ({ init }) => new Response(null, { status: (init?.headers as Record<string, string>)["If-None-Match"] === '"v1"' ? 304 : 500 }) });
    const { report } = await collect(web.http, source(), { now: NOW, maxAgeDays: 7, cond: { etag: '"v1"' } });
    expect(report.outcome).toBe("not_modified");
  });

  it("reports blocks, rate limits and parser drift instead of working around them", async () => {
    const blocked = fakeWeb({ [FEED]: new Response("no", { status: 403 }) });
    expect((await collect(blocked.http, source(), { now: NOW, maxAgeDays: 7 })).report.outcome).toBe("blocked");

    const limited = fakeWeb({ [FEED]: new Response("slow down", { status: 429, headers: { "Retry-After": "120" } }) });
    expect((await collect(limited.http, source(), { now: NOW, maxAgeDays: 7 })).report).toMatchObject({ outcome: "rate_limited", retryAfterSec: 120 });
    expect(limited.calls.filter((c) => c.url === FEED)).toHaveLength(1);

    const html = fakeWeb({ [FEED]: xml("<!doctype html><html><body>Please enable JavaScript</body></html>") });
    expect((await collect(html.http, source(), { now: NOW, maxAgeDays: 7 })).report).toMatchObject({ outcome: "drift", message: "200 response is not a feed (unknown)" });

    const empty = fakeWeb({ [FEED]: xml(rss([])) });
    expect((await collect(empty.http, source(), { now: NOW, maxAgeDays: 7 })).report).toMatchObject({ outcome: "drift", message: "200 response with no items (rss)" });
  });

  it("never fetches a feed that robots.txt disallows", async () => {
    const web = fakeWeb({ "https://example.in/robots.txt": new Response("User-agent: IndiaHealthNewsBot\nDisallow: /health/\n"), [FEED]: xml(rss([])) });
    const { report } = await collect(web.http, source(), { now: NOW, maxAgeDays: 7 });
    expect(report.outcome).toBe("robots");
    expect(web.calls.map((c) => c.url)).toEqual(["https://example.in/robots.txt"]);
  });

  it("stays out when robots.txt cannot be read because of a server error", async () => {
    const web = fakeWeb({ "https://example.in/robots.txt": new Response("oops", { status: 503 }), [FEED]: xml(rss([])) });
    expect((await collect(web.http, source(), { now: NOW, maxAgeDays: 7 })).report.outcome).toBe("robots");
  });

  it("resolves redirecting links from the Location header only, once per item", async () => {
    const link = "https://tools.example.gov/podcasts/download?m=1";
    const web = fakeWeb({
      "https://tools.example.gov/podcasts/feed": xml(rss([item({ title: "Measles elimination status lost", link, guid: "m1", date: "Tue, 17 Nov 2026 11:10:00 GMT" })])),
      [link]: new Response(null, { status: 301, headers: { Location: "https://www.example.gov/media/releases/2026/measles.html" } }),
    });
    const src = source({ feedUrl: "https://tools.example.gov/podcasts/feed", resolveRedirects: true, maxAgeDays: 30, hosts: [{ host: "tools.example.gov", pathPrefix: "/podcasts" }, { host: "www.example.gov", pathPrefix: "/" }] });
    const first = await collect(web.http, src, { now: NOW, maxAgeDays: 30 });
    expect(first.candidates[0]).toMatchObject({ sourceUrl: link, resolvedUrl: "https://www.example.gov/media/releases/2026/measles.html" });
    expect(web.calls.find((c) => c.url === link)?.method).toBe("HEAD");
    expect(web.calls.some((c) => c.url.startsWith("https://www.example.gov/media"))).toBe(false);

    const before = web.calls.length;
    await collect(web.http, src, { now: NOW, maxAgeDays: 30, knownResolved: () => "https://www.example.gov/media/releases/2026/measles.html" });
    expect(web.calls.slice(before).some((c) => c.url === link)).toBe(false);
  });
});

describe("manifest", () => {
  const m = loadManifest("scraper/sources.json");

  it("accounts for all 55 probed sources: 23 on, 8 for wave 2, 5 awaiting permission, 4 awaiting bot allowlisting, 15 not carried", () => {
    expect(m.sources.filter((s) => s.enabled)).toHaveLength(23);
    expect(m.sources.filter((s) => s.wave === 2)).toHaveLength(8);
    expect(m.sources.filter((s) => s.requires === "written_permission")).toHaveLength(5);
    expect(m.sources.filter((s) => s.requires === "bot_allowlisting").map((s) => s.slug)).toEqual(["business-standard", "news18", "firstpost", "medical-dialogues"]);
    expect(m.notCarried).toHaveLength(15);
    expect(m.sources.length + m.notCarried.length).toBe(55);
  });

  it("refuses to fetch a source that is off, even when named", () => {
    expect(() => pickSources(m, ["bbc-health"])).toThrow(/off in the manifest/);
    expect(() => pickSources(m, ["no-such-source"])).toThrow(/Unknown source/);
    expect(pickSources(m, ["the-hindu"]).map((s) => s.slug)).toEqual(["the-hindu"]);
  });
});
