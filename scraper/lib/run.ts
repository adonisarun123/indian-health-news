/**
 * Runs: collect due sources into the outbox, send what is due, poll receipts.
 * Also the dry run, which builds the same events and writes them to files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IngestClient } from "./client";
import { type CollectReport, collect } from "./collect";
import { buildEvent } from "./event";
import type { Http } from "./http";
import { pollMinutesOf, type Source } from "./manifest";
import type { Store } from "./store";

export interface Config {
  maxAgeDays: number;
  sendPerMinute: number;
  /** Requests to distinct feed hosts that may run at once. One host is never hit in parallel. */
  hostConcurrency: number;
  alertWebhook?: string;
}

export interface Deps {
  http: Http;
  config: Config;
  now: () => Date;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  store?: Store;
  client?: IngestClient;
  /** Posts alerts somewhere a person will see them. Defaults to the webhook in config, if any. */
  notify?: (text: string) => Promise<void>;
}

export interface SourceRun extends Partial<Omit<CollectReport, "outcome">> {
  slug: string;
  outcome: CollectReport["outcome"] | "not_due" | "backoff";
  staged?: { new: number; revised: number; unchanged: number; invalid: number };
}

export async function raise(deps: Deps, sourceId: string | null, kind: string, message: string) {
  const fresh = deps.store ? deps.store.alert(sourceId, kind, message, deps.now()) : true;
  deps.log(`ALERT ${kind}${sourceId ? ` [${sourceId}]` : ""}: ${message}`);
  if (!fresh) return;
  const text = `India Health News scraper: ${kind}${sourceId ? ` [${sourceId}]` : ""}: ${message}`;
  try {
    if (deps.notify) await deps.notify(text);
    else if (deps.config.alertWebhook) await fetch(deps.config.alertWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    deps.log(`alert webhook failed: ${(e as Error).message}`);
  }
}

/** Run `fn` over sources, one feed host at a time each, several hosts in parallel. */
async function byHost<T>(sources: Source[], limit: number, sleep: Deps["sleep"], fn: (s: Source) => Promise<T>): Promise<T[]> {
  const groups = new Map<string, Source[]>();
  for (const s of sources) {
    const host = new URL(s.feedUrl!).host;
    groups.set(host, [...(groups.get(host) ?? []), s]);
  }
  const queue = [...groups.values()];
  const out = new Map<string, T>();
  const worker = async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      for (const [i, s] of g.entries()) {
        if (i > 0) await sleep(1000);
        out.set(s.slug, await fn(s));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, worker));
  return sources.map((s) => out.get(s.slug)!);
}

const BACKOFF_CAP_MS = 24 * 3_600_000;

/** Fetch one source into the outbox, with due-time, backoff and alert handling. */
async function collectInto(deps: Deps, src: Source, force: boolean): Promise<SourceRun> {
  const store = deps.store!;
  const now = deps.now();
  const state = store.feed(src.slug);
  const pollMs = pollMinutesOf(src) * 60_000;
  if (!force && state?.backoff_until && state.backoff_until > now.toISOString()) return { slug: src.slug, outcome: "backoff" };
  if (!force && state?.last_fetch_at && new Date(state.last_fetch_at).getTime() + pollMs > now.getTime() + 30_000) return { slug: src.slug, outcome: "not_due" };

  const { report, candidates } = await collect(deps.http, src, {
    now,
    maxAgeDays: src.maxAgeDays ?? deps.config.maxAgeDays,
    cond: { etag: state?.etag, lastModified: state?.last_modified },
    knownResolved: (id) => store.resolvedFor(src.slug, id),
    sleep: deps.sleep,
  });

  const ok = report.outcome === "ok" || report.outcome === "not_modified";
  const failures = ok ? 0 : (state?.failures ?? 0) + 1;
  const backoffMs =
    report.outcome === "rate_limited" && report.retryAfterSec ? report.retryAfterSec * 1000 : ok ? 0 : Math.min(pollMs * 2 ** failures, BACKOFF_CAP_MS);
  store.saveFeed(src.slug, {
    last_fetch_at: now.toISOString(),
    last_outcome: report.outcome,
    last_status: report.httpStatus,
    failures,
    backoff_until: backoffMs ? new Date(now.getTime() + backoffMs).toISOString() : null,
    ...(ok ? { last_ok_at: now.toISOString() } : {}),
    ...(report.outcome === "ok" ? { etag: report.etag ?? null, last_modified: report.lastModified ?? null, last_item_count: report.parsed, newest_item_at: report.newestAt } : {}),
  });

  // Blocks, robots, rate limits and drift need a person at once; a flaky network only after three runs.
  if (["robots", "blocked", "rate_limited", "drift", "http_error"].includes(report.outcome)) await raise(deps, src.slug, report.outcome, report.message ?? report.outcome);
  else if (report.outcome === "network" && failures >= 3) await raise(deps, src.slug, "network", `${failures} failed fetches in a row (${report.message})`);
  if (report.outcome === "ok") {
    const newest = report.newestAt ?? state?.newest_item_at;
    if (newest && now.getTime() - new Date(newest).getTime() > src.staleDays * 86_400_000) await raise(deps, src.slug, "stale_feed", `newest item is from ${newest.slice(0, 10)}`);
    if (report.parsed > 0 && report.offHost === report.parsed) await raise(deps, src.slug, "off_host", "every item links outside the approved hosts; check the manifest");
  }

  const staged = { new: 0, revised: 0, unchanged: 0, invalid: 0 };
  let firstInvalid: string | null = null;
  for (const c of candidates) {
    const result = store.stage(c, now, (revision, eventId) => {
      const built = buildEvent(c, revision, eventId, now);
      if (!built.ok) firstInvalid ??= `${c.sourceUrl}: ${built.errors.join("; ")}`;
      return built.ok ? built.body : null;
    });
    staged[result]++;
  }
  if (firstInvalid) await raise(deps, src.slug, "invalid_event", `${staged.invalid} item(s) failed the v1 contract, first: ${firstInvalid}`);
  return { ...report, staged };
}

export interface SendReport {
  sent: number;
  retried: number;
  parked: number;
  reissued: number;
  refusedSources: string[];
  stopped?: string;
}

/** Send due outbox rows, paced, oldest first. Stops on a rate limit or an authentication failure. */
export async function sendDue(deps: Deps): Promise<SendReport> {
  const store = deps.store!;
  const client = deps.client!;
  const r: SendReport = { sent: 0, retried: 0, parked: 0, reissued: 0, refusedSources: [] };
  const gap = Math.ceil(60_000 / Math.max(1, deps.config.sendPerMinute));
  const refused = new Set<string>();

  for (let batch = store.due(deps.now(), 50); batch.length; batch = store.due(deps.now(), 50)) {
    for (const row of batch) {
      const now = deps.now();
      if (refused.has(row.source_id)) {
        store.markRetry(row.event_id, new Date(now.getTime() + 30 * 60_000), "source refused by intake earlier in this run", false);
        continue;
      }
      const out = await client.submit(row.event_id, Buffer.from(row.body, "utf8"));
      switch (out.kind) {
        case "accepted":
          store.markSent(row.event_id, deps.now(), out.httpStatus, out.receiptStatus, out.reasonCode);
          r.sent++;
          break;
        case "retry": {
          const wait = Math.min(60_000 * 2 ** row.attempts, 3_600_000);
          store.markRetry(row.event_id, new Date(now.getTime() + wait), out.error);
          r.retried++;
          if (row.attempts + 1 >= 5) await raise(deps, row.source_id, "send_retrying", `event ${row.event_id} failed ${row.attempts + 1} times: ${out.error}`);
          break;
        }
        case "rate_limited":
          store.markRetry(row.event_id, new Date(now.getTime() + out.afterSec * 1000), "429 RATE_LIMITED", false);
          r.stopped = `intake rate limit, retry after ${out.afterSec}s`;
          return r;
        case "revision_conflict":
          store.reissue(row, now);
          r.reissued++;
          if (r.reissued > 25) {
            r.stopped = "too many revision conflicts in one run";
            await raise(deps, null, "revision_conflicts", "More than 25 REVISION_CONFLICT answers in one run. Was the scraper database replaced?");
            return r;
          }
          break;
        case "source_refused":
          refused.add(row.source_id);
          r.refusedSources.push(row.source_id);
          store.markRetry(row.event_id, new Date(now.getTime() + 30 * 60_000), `${out.code}: ${out.message}`, false);
          await raise(deps, row.source_id, "source_refused", `${out.code}: ${out.message} Events wait in the outbox until the source is registered, assigned and enabled.`);
          break;
        case "park":
          store.markParked(row.event_id, out.httpStatus, `${out.code}: ${out.message}`);
          r.parked++;
          await raise(deps, row.source_id, out.code === "URL_NOT_ALLOWED" ? "url_not_allowed" : "event_parked", `${out.code}: ${out.message}`);
          break;
        case "fatal":
          store.markRetry(row.event_id, now, `${out.code}: ${out.message}`, false);
          r.stopped = `${out.code}: ${out.message}`;
          await raise(deps, null, "intake_auth", r.stopped);
          return r;
      }
      await deps.sleep(gap);
    }
  }
  return r;
}

export async function pollReceipts(deps: Deps): Promise<Record<string, number>> {
  const store = deps.store!;
  const tally: Record<string, number> = {};
  for (const row of store.receiptsDue(deps.now())) {
    const r = await deps.client!.receipt(row.event_id);
    if (!r.ok) {
      tally.error = (tally.error ?? 0) + 1;
      continue;
    }
    store.setReceipt(row.event_id, deps.now(), r.status, r.reasonCode);
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    if (r.status === "failed") await raise(deps, row.source_id, "receipt_failed", `event ${row.event_id} failed at intake${r.reasonCode ? ` (${r.reasonCode})` : ""}`);
    await deps.sleep(100);
  }
  return tally;
}

export async function runOnce(deps: Deps, sources: Source[], opts: { force?: boolean; send?: boolean } = {}) {
  const runs = await byHost(sources, deps.config.hostConcurrency, deps.sleep, (s) => collectInto(deps, s, !!opts.force));
  let send: SendReport | null = null;
  let receipts: Record<string, number> | null = null;
  if (opts.send && deps.client) {
    send = await sendDue(deps);
    receipts = await pollReceipts(deps);
  }
  return { runs, send, receipts };
}

/* ───────────── dry run ───────────── */

export interface DryRunResult {
  dir: string;
  reports: (CollectReport & { events: number; invalidEvents: number })[];
}

/** Fetch every source fresh, build revision-1 events and write them as JSON Lines. Sends nothing, stores nothing. */
export async function dryRun(deps: Deps, sources: Source[], outDir: string): Promise<DryRunResult> {
  const now = deps.now();
  const dir = join(outDir, now.toISOString().replace(/[:.]/g, "-").slice(0, 19));
  mkdirSync(dir, { recursive: true });
  const reports = await byHost(sources, deps.config.hostConcurrency, deps.sleep, async (src) => {
    const { report, candidates } = await collect(deps.http, src, { now, maxAgeDays: src.maxAgeDays ?? deps.config.maxAgeDays, sleep: deps.sleep });
    const lines: string[] = [];
    let invalidEvents = 0;
    for (const c of candidates) {
      const built = buildEvent(c, 1, crypto.randomUUID(), now);
      if (built.ok) lines.push(built.body);
      else {
        invalidEvents++;
        deps.log(`invalid [${src.slug}] ${c.sourceUrl}: ${built.errors.join("; ")}`);
      }
    }
    if (lines.length) writeFileSync(join(dir, `${src.slug}.jsonl`), `${lines.join("\n")}\n`);
    return { ...report, events: lines.length, invalidEvents };
  });
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify({ generatedAt: now.toISOString(), sources: reports }, null, 1)}\n`);
  return { dir, reports };
}
