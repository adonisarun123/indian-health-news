/**
 * Polite fetching for the scraper (SRC-03, ING-03): an honest User-Agent,
 * robots.txt checked for every URL, conditional GET and bounded responses.
 * Nothing here retries a block: 401, 403 and 429 are reported to the caller.
 */
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type RobotsRules } from "./robots";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface GetResult {
  /** HTTP status, or 0 when the request never got a response. */
  status: number;
  finalUrl: string;
  body?: string;
  etag?: string;
  lastModified?: string;
  retryAfterSec?: number;
  error?: string;
}

export interface HttpOptions {
  userAgent: string;
  /** Product token matched against robots.txt groups, such as IndiaHealthNewsBot. */
  robotsToken: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  maxBytes?: number;
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

function decode(buf: ArrayBuffer, contentType: string | null): string {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const label = /charset=["']?([\w.-]+)/i.exec(contentType ?? "")?.[1] ?? /<\?xml[^>]*encoding=["']([\w.-]+)["']/i.exec(head)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export class Http {
  private readonly robots = new Map<string, Promise<RobotsRules>>();
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: HttpOptions) {
    this.fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "User-Agent": this.opts.userAgent, ...extra };
  }

  /** RFC 9309: 4xx means no rules; 5xx or no answer means stay out for now. Cached per origin for this process. */
  private rulesFor(origin: string): Promise<RobotsRules> {
    let p = this.robots.get(origin);
    if (!p) {
      p = (async () => {
        try {
          const res = await this.fetcher(`${origin}/robots.txt`, { headers: this.headers({ Accept: "text/plain,*/*;q=0.5" }), redirect: "follow", signal: AbortSignal.timeout(this.timeoutMs) });
          if (res.status >= 500) return DISALLOW_ALL;
          if (res.status >= 400) return ALLOW_ALL;
          return parseRobots(decode(await res.arrayBuffer(), res.headers.get("content-type")), this.opts.robotsToken);
        } catch {
          return DISALLOW_ALL;
        }
      })();
      this.robots.set(origin, p);
    }
    return p;
  }

  async allowed(url: string): Promise<boolean> {
    const u = new URL(url);
    return (await this.rulesFor(u.origin)).allows(`${u.pathname}${u.search}`);
  }

  async get(url: string, cond: { etag?: string | null; lastModified?: string | null } = {}): Promise<GetResult> {
    const extra: Record<string, string> = { Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5" };
    if (cond.etag) extra["If-None-Match"] = cond.etag;
    if (cond.lastModified) extra["If-Modified-Since"] = cond.lastModified;
    let res: Response;
    try {
      res = await this.fetcher(url, { headers: this.headers(extra), redirect: "follow", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      return { status: 0, finalUrl: url, error: err.cause?.code ?? err.name ?? "network error" };
    }
    const base = { status: res.status, finalUrl: res.url || url };
    if (res.status === 304) return base;
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return { ...base, retryAfterSec: parseRetryAfter(res.headers.get("retry-after")) };
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > this.maxBytes) {
      void res.body?.cancel().catch(() => undefined);
      return { ...base, status: 0, error: `response larger than ${this.maxBytes} bytes` };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > this.maxBytes) return { ...base, status: 0, error: `response larger than ${this.maxBytes} bytes` };
    return {
      ...base,
      body: decode(buf, res.headers.get("content-type")),
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
    };
  }

  /**
   * Where a redirecting link points, read from Location headers only: the target
   * itself is never fetched. Same-host hops are followed, up to three.
   */
  async resolve(url: string): Promise<string | null> {
    let current = url;
    for (let hop = 0; hop < 3; hop++) {
      if (!(await this.allowed(current))) return null;
      let res: Response;
      try {
        res = await this.fetcher(current, { method: "HEAD", headers: this.headers(), redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.status === 405) res = await this.fetcher(current, { method: "GET", headers: this.headers(), redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      } catch {
        return null;
      }
      void res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) return res.ok ? current : null;
      const next = new URL(location, current);
      if (next.host !== new URL(current).host) return next.toString();
      current = next.toString();
    }
    return current;
  }
}
