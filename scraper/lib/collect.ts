/**
 * One source, one fetch: robots check, conditional GET, parse, filter, and
 * candidates ready to become events. Nothing here talks to intake.
 */
import { createHash } from "node:crypto";
import { checkSourceUrl } from "../../src/core/urls";
import { parseFeedDate } from "./dates";
import { ADAPTER_VERSIONS, type Candidate } from "./event";
import { authorOf, cleanUrl, clip, excerptOf, isHealthRelated, pathAllowed } from "./filters";
import type { Http } from "./http";
import type { Source } from "./manifest";
import { parseDocument } from "./parse";

export type Outcome = "ok" | "not_modified" | "robots" | "blocked" | "rate_limited" | "http_error" | "network" | "drift";

export interface CollectReport {
  slug: string;
  outcome: Outcome;
  httpStatus: number;
  message?: string;
  retryAfterSec?: number;
  etag?: string;
  lastModified?: string;
  /** Items in the document. */
  parsed: number;
  kept: number;
  offHost: number;
  offPath: number;
  notHealth: number;
  tooOld: number;
  invalid: number;
  duplicate: number;
  newestAt: string | null;
}

export interface CollectOptions {
  now: Date;
  maxAgeDays: number;
  cond?: { etag?: string | null; lastModified?: string | null };
  /** Redirect targets already on record, so a known item is not resolved again. */
  knownResolved?: (externalId: string) => string | null | undefined;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_EXTERNAL_ID = 300;

function externalIdOf(guid: string | undefined, link: string): string {
  const fromGuid = guid ? (/^https?:\/\//i.test(guid) ? cleanUrl(guid) : guid.trim()) : null;
  const id = fromGuid || link;
  return id.length <= MAX_EXTERNAL_ID ? id : `sha256:${createHash("sha256").update(id).digest("hex")}`;
}

export async function collect(http: Http, src: Source, opts: CollectOptions): Promise<{ report: CollectReport; candidates: Candidate[] }> {
  const report: CollectReport = { slug: src.slug, outcome: "ok", httpStatus: 0, parsed: 0, kept: 0, offHost: 0, offPath: 0, notHealth: 0, tooOld: 0, invalid: 0, duplicate: 0, newestAt: null };
  const candidates: Candidate[] = [];
  const feedUrl = src.feedUrl!;
  const done = (outcome: Outcome, message?: string) => ({ report: { ...report, outcome, ...(message ? { message } : {}) }, candidates });

  if (!(await http.allowed(feedUrl))) return done("robots", `robots.txt disallows ${feedUrl}`);
  const res = await http.get(feedUrl, opts.cond);
  report.httpStatus = res.status;
  if (res.status === 304) return done("not_modified");
  if (res.status === 0) return done("network", res.error);
  if (res.status === 401 || res.status === 403) return done("blocked", `HTTP ${res.status} for ${feedUrl}`);
  if (res.status === 429) {
    report.retryAfterSec = res.retryAfterSec;
    return done("rate_limited", `HTTP 429${res.retryAfterSec ? `, retry after ${res.retryAfterSec}s` : ""}`);
  }
  if (res.status >= 400 || !res.body) return done("http_error", `HTTP ${res.status} for ${feedUrl}`);
  report.etag = res.etag;
  report.lastModified = res.lastModified;

  const doc = parseDocument(res.body);
  report.parsed = doc.items.length;
  if (doc.kind === "unknown" || doc.kind === "sitemap_index") return done("drift", `200 response is not a ${src.adapter === "rss" ? "feed" : "news sitemap"} (${doc.kind})`);
  if (doc.items.length === 0) return done("drift", `200 response with no items (${doc.kind})`);

  const oldest = opts.now.getTime() - opts.maxAgeDays * 86_400_000;
  const seen = new Set<string>();
  let newest = 0;

  for (const item of doc.items) {
    const link = cleanUrl(item.link ?? "", res.finalUrl);
    const title = clip(item.title ?? "", 500);
    if (!link || !title) {
      report.invalid++;
      continue;
    }
    if (!checkSourceUrl(link, src.hosts).ok) {
      report.offHost++;
      continue;
    }
    if (!pathAllowed(link, src.includePaths, src.excludePaths)) {
      report.offPath++;
      continue;
    }
    if (src.filter === "health" && !isHealthRelated(title, link)) {
      report.notHealth++;
      continue;
    }
    const published = parseFeedDate(item.published || item.updated, { zone: src.dateZone, now: opts.now });
    if (published.at) {
      newest = Math.max(newest, published.at.getTime());
      if (published.at.getTime() < oldest) {
        report.tooOld++;
        continue;
      }
    }
    const externalId = externalIdOf(item.guid, link);
    if (seen.has(externalId)) {
      report.duplicate++;
      continue;
    }
    seen.add(externalId);

    let updatedAt: string | undefined;
    if (item.updated && item.published && item.updated !== item.published) {
      const u = parseFeedDate(item.updated, { zone: src.dateZone, now: opts.now });
      if (u.at && published.at && u.at.getTime() > published.at.getTime()) updatedAt = u.at.toISOString();
    }

    let resolvedUrl: string | undefined;
    if (src.resolveRedirects) {
      const known = opts.knownResolved?.(externalId);
      if (known !== undefined) resolvedUrl = known ?? undefined;
      else {
        const target = await http.resolve(link);
        const cleaned = target ? cleanUrl(target) : null;
        if (cleaned && checkSourceUrl(cleaned, src.hosts).ok) resolvedUrl = cleaned;
        await opts.sleep?.(1000);
      }
    }

    candidates.push({
      sourceId: src.slug,
      externalId,
      sourceUrl: link,
      ...(resolvedUrl ? { resolvedUrl } : {}),
      title,
      publishedAt: published.at ? published.at.toISOString() : null,
      ...(published.at ? {} : { publishedReason: published.reason }),
      ...(updatedAt ? { updatedAt } : {}),
      ...(authorOf(item.author) ? { author: authorOf(item.author) } : {}),
      ...(excerptOf(item.summary, title) ? { excerpt: excerptOf(item.summary, title) } : {}),
      adapterVersion: ADAPTER_VERSIONS[src.adapter as keyof typeof ADAPTER_VERSIONS],
    });
  }

  report.kept = candidates.length;
  report.newestAt = newest ? new Date(newest).toISOString() : null;
  // Oldest first, so intake sees items in the order they appeared.
  candidates.sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));
  return { report, candidates };
}
