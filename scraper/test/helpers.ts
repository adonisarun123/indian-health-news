import { Http } from "../lib/http";
import { manifestSchema, type Source } from "../lib/manifest";
import type { Deps } from "../lib/run";

/** A manifest source with the schema's defaults applied. */
export function source(overrides: Record<string, unknown> = {}): Source {
  const base = {
    slug: "example-news",
    displayName: "Example News",
    legalName: "Example News Ltd",
    homepageUrl: "https://example.in/",
    family: "independent_commercial",
    wave: 1,
    enabled: true,
    adapter: "rss",
    feedUrl: "https://example.in/health/feed.xml",
    hosts: [{ host: "example.in", pathPrefix: "/" }],
  };
  return manifestSchema.parse({ version: 1, probedOn: "2026-11-25", sources: [{ ...base, ...overrides }], notCarried: [] }).sources[0]!;
}

type Route = Response | ((req: { url: string; init?: RequestInit }) => Response | Promise<Response>);

/** A fake web: routes by exact URL; robots.txt is 404 (no rules) unless routed. Records every request. */
export function fakeWeb(routes: Record<string, Route>) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) } });
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    const res = typeof r === "function" ? await r({ url, init }) : r.clone();
    return res;
  };
  return { fetcher, calls, http: new Http({ userAgent: "IndiaHealthNewsBot/1.0 (+test)", robotsToken: "IndiaHealthNewsBot", fetcher }) };
}

export const xml = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "content-type": "application/rss+xml; charset=utf-8", ...headers } });

export function rss(items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Example</title><link>https://example.in/</link>${items.join("")}</channel></rss>`;
}

export function item(o: { title: string; link: string; guid?: string; date?: string; description?: string }): string {
  return `<item><title><![CDATA[${o.title}]]></title><link>${o.link}</link>${o.guid ? `<guid isPermaLink="false">${o.guid}</guid>` : ""}${o.date ? `<pubDate>${o.date}</pubDate>` : ""}${o.description ? `<description><![CDATA[${o.description}]]></description>` : ""}</item>`;
}

export function clockAt(iso: string) {
  let t = new Date(iso).getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export function deps(http: Http, clock: { now: () => Date }, extra: Partial<Deps> = {}): Deps & { lines: string[] } {
  const lines: string[] = [];
  return {
    http,
    config: { maxAgeDays: 7, sendPerMinute: 6000, hostConcurrency: 2 },
    now: clock.now,
    log: (l) => void lines.push(l),
    sleep: async () => undefined,
    notify: async () => undefined,
    lines,
    ...extra,
  };
}
