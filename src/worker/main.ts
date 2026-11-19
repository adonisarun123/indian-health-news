import { randomUUID } from "node:crypto";
import { createDb } from "@/db/client";
import { type Distributor, logDistributor } from "@/core/outbox";
import { runDueJobs, schedulerTick } from "./run";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const { db, pool } = createDb(url, Number(process.env.WORKER_POOL_MAX ?? 4));
const worker = `worker-${randomUUID().slice(0, 8)}`;

// With SITE_URL and CRON_SECRET set, deliveries invalidate the web cache. Otherwise they are logged.
const site = process.env.SITE_URL?.replace(/\/+$/, "");
const secret = process.env.CRON_SECRET;
const distributor: Distributor =
  site && secret
    ? {
        async deliver(target, event) {
          const res = await fetch(`${site}/api/internal/revalidate`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ target, eventType: event.eventType }) });
          if (!res.ok) throw new Error(`revalidate ${target} failed: ${res.status}`);
        },
      }
    : logDistributor;
const JOB_POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1000);
const TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? 5000);

let stopping = false;
let lastTick = 0;

async function loop() {
  console.log(JSON.stringify({ msg: "worker_started", worker }));
  while (!stopping) {
    const now = new Date();
    try {
      const handled = await runDueJobs(db, worker, now, { max: 50 });
      if (Date.now() - lastTick >= TICK_MS) {
        lastTick = Date.now();
        const tick = await schedulerTick(db, distributor, new Date());
        if (tick.cardsSuppressed || tick.copiesSuppressed || tick.outbox.events || tick.reconciled.suppressionsReapplied || tick.reconciled.scheduledJobsRestored) console.log(JSON.stringify({ msg: "tick", ...tick }));
      }
      if (handled === 0) await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    } catch (e) {
      console.error(JSON.stringify({ msg: "worker_loop_error", error: e instanceof Error ? e.message : String(e) }));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await pool.end();
  console.log(JSON.stringify({ msg: "worker_stopped", worker }));
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));
void loop();
