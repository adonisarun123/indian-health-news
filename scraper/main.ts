/**
 * India Health News scraper: the producer for POST /api/v1/ingest/events.
 *
 *   npm run scrape -- dry-run [--source a,b] [--out dir]   fetch, build events, write JSONL; sends and stores nothing
 *   npm run scrape -- once [--source a,b] [--force] [--no-send]
 *   npm run scrape -- daemon                               once every minute; each source on its own poll interval
 *   npm run scrape -- receipts                             re-poll receipts still accepted or processing
 *   npm run scrape -- status                               feeds, outbox and recent alerts
 *
 * Environment (.env.local): INGEST_BASE_URL, PRODUCER_KEY, PRODUCER_SECRET, and optionally
 * SCRAPER_DB, SCRAPER_USER_AGENT, SCRAPER_MAX_AGE_DAYS, SCRAPER_SEND_PER_MINUTE,
 * SCRAPER_ALERT_WEBHOOK. See scraper/README.md.
 */
import { resolve } from "node:path";
import { IngestClient, httpTransport } from "./lib/client";
import { Http } from "./lib/http";
import { loadManifest, pickSources } from "./lib/manifest";
import { type Deps, dryRun, pollReceipts, runOnce } from "./lib/run";
import { Store } from "./lib/store";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const env = process.env;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const ROBOTS_TOKEN = "IndiaHealthNewsBot";
const userAgent = env.SCRAPER_USER_AGENT || `${ROBOTS_TOKEN}/1.0 (+https://www.indiahealthnews.com/about)`;
const manifestPath = resolve(opt("--manifest") ?? "scraper/sources.json");
const only = opt("--source")?.split(",").map((s) => s.trim()).filter(Boolean);

const pad = (s: string | number, n: number) => String(s).slice(0, n).padEnd(n);
const padL = (s: string | number, n: number) => String(s).padStart(n);

function baseDeps(): Deps {
  return {
    http: new Http({ userAgent, robotsToken: ROBOTS_TOKEN }),
    config: {
      maxAgeDays: num(env.SCRAPER_MAX_AGE_DAYS, 7),
      sendPerMinute: num(env.SCRAPER_SEND_PER_MINUTE, 120),
      hostConcurrency: 6,
      alertWebhook: env.SCRAPER_ALERT_WEBHOOK || undefined,
    },
    now: () => new Date(),
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function withStore(d: Deps, needClient: boolean): Deps {
  const store = new Store(resolve(env.SCRAPER_DB || "scraper/data/scraper.db"));
  if (!needClient) return { ...d, store };
  const key = env.PRODUCER_KEY;
  const secret = env.PRODUCER_SECRET;
  if (!key || !secret) throw new Error("Set PRODUCER_KEY and PRODUCER_SECRET (issued by the platform for this producer), or pass --no-send to only fill the outbox.");
  const base = env.INGEST_BASE_URL || "http://localhost:3000";
  return { ...d, store, client: new IngestClient({ key, secret, transport: httpTransport(base) }) };
}

function printRuns(runs: Awaited<ReturnType<typeof runOnce>>["runs"]) {
  console.log(`\n${pad("source", 20)} ${pad("outcome", 13)} ${padL("http", 4)} ${padL("items", 5)} ${padL("kept", 5)} ${padL("new", 4)} ${padL("rev", 4)} ${padL("same", 5)}  dropped`);
  for (const r of runs) {
    const dropped = r.parsed ? `host ${r.offHost} path ${r.offPath} topic ${r.notHealth} old ${r.tooOld} bad ${r.invalid}` : (r.message ?? "");
    console.log(
      `${pad(r.slug, 20)} ${pad(r.outcome, 13)} ${padL(r.httpStatus ?? "", 4)} ${padL(r.parsed ?? "", 5)} ${padL(r.kept ?? "", 5)} ${padL(r.staged?.new ?? "", 4)} ${padL(r.staged?.revised ?? "", 4)} ${padL(r.staged?.unchanged ?? "", 5)}  ${dropped}`,
    );
  }
}

async function main() {
  const manifest = loadManifest(manifestPath);
  const sources = pickSources(manifest, only);

  switch (cmd) {
    case "dry-run": {
      const d = baseDeps();
      const out = resolve(opt("--out") ?? "scraper/out");
      const { dir, reports } = await dryRun(d, sources, out);
      console.log(`\n${pad("source", 20)} ${pad("outcome", 13)} ${padL("http", 4)} ${padL("items", 5)} ${padL("events", 6)}  dropped`);
      for (const r of reports) {
        const dropped = r.parsed ? `host ${r.offHost} path ${r.offPath} topic ${r.notHealth} old ${r.tooOld} bad ${r.invalid}` : (r.message ?? "");
        console.log(`${pad(r.slug, 20)} ${pad(r.outcome, 13)} ${padL(r.httpStatus, 4)} ${padL(r.parsed, 5)} ${padL(r.events, 6)}  ${dropped}`);
      }
      const total = reports.reduce((n, r) => n + r.events, 0);
      const failed = reports.filter((r) => r.outcome !== "ok").map((r) => r.slug);
      console.log(`\n${total} events from ${reports.length - failed.length} of ${reports.length} sources -> ${dir}`);
      if (failed.length) console.log(`not ok: ${failed.join(", ")}`);
      break;
    }
    case "once": {
      const d = withStore(baseDeps(), !flag("--no-send"));
      const { runs, send, receipts } = await runOnce(d, sources, { force: flag("--force"), send: !flag("--no-send") });
      printRuns(runs);
      if (send) console.log(`\nsent ${send.sent}, retrying ${send.retried}, parked ${send.parked}, re-issued ${send.reissued}${send.stopped ? `, stopped: ${send.stopped}` : ""}`);
      if (receipts && Object.keys(receipts).length) console.log(`receipts: ${JSON.stringify(receipts)}`);
      d.store!.close();
      if (send?.stopped) process.exitCode = 1;
      break;
    }
    case "daemon": {
      const d = withStore(baseDeps(), true);
      let stop = false;
      const halt = () => {
        stop = true;
        console.log("stopping after this pass");
      };
      process.on("SIGINT", halt);
      process.on("SIGTERM", halt);
      console.log(`scraper daemon: ${sources.length} sources, user agent "${userAgent}"`);
      while (!stop) {
        const started = Date.now();
        try {
          const { runs, send } = await runOnce(d, sources, { send: true });
          const fetched = runs.filter((r) => r.outcome !== "not_due" && r.outcome !== "backoff");
          if (fetched.length || send?.sent) {
            const fresh = fetched.reduce((n, r) => n + (r.staged?.new ?? 0) + (r.staged?.revised ?? 0), 0);
            console.log(`${new Date().toISOString()} fetched ${fetched.length}, staged ${fresh}, sent ${send?.sent ?? 0}${send?.stopped ? `, stopped: ${send.stopped}` : ""}`);
          }
        } catch (e) {
          console.error(`${new Date().toISOString()} pass failed: ${(e as Error).stack ?? e}`);
        }
        for (let waited = Date.now() - started; !stop && waited < 60_000; waited += 1000) await d.sleep(1000);
      }
      d.store!.close();
      break;
    }
    case "receipts": {
      const d = withStore(baseDeps(), true);
      console.log(JSON.stringify(await pollReceipts(d)));
      d.store!.close();
      break;
    }
    case "status": {
      const d = withStore(baseDeps(), false);
      const store = d.store!;
      console.log(`${pad("source", 20)} ${pad("last fetch", 20)} ${pad("outcome", 13)} ${padL("items", 5)} ${pad("newest item", 11)} ${padL("fail", 4)} backoff until`);
      for (const f of store.feeds()) {
        console.log(`${pad(f.source_id, 20)} ${pad(f.last_fetch_at?.slice(0, 19) ?? "", 20)} ${pad(f.last_outcome ?? "", 13)} ${padL(f.last_item_count ?? "", 5)} ${pad(f.newest_item_at?.slice(0, 10) ?? "", 11)} ${padL(f.failures, 4)} ${f.backoff_until?.slice(0, 19) ?? ""}`);
      }
      console.log("\noutbox");
      for (const c of store.outboxCounts()) console.log(`  ${pad(c.source_id, 20)} ${pad(c.state, 8)} ${pad(c.receipt_status ?? "", 12)} ${c.n}`);
      console.log("\nrecent alerts");
      for (const a of store.recentAlerts()) console.log(`  ${a.at.slice(0, 19)} ${pad(a.kind, 16)} ${pad(a.source_id ?? "", 20)} ${a.message}`);
      store.close();
      break;
    }
    default:
      console.log("Usage: npm run scrape -- dry-run|once|daemon|receipts|status [--source a,b] [--force] [--no-send] [--out dir]");
      if (cmd !== "help") process.exitCode = 1;
  }
}

await main();
