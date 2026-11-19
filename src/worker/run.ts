/**
 * Background worker (ARC-01). Runs outside any web request.
 *
 * One loop claims durable jobs. A scheduler tick drains the outbox and runs
 * the rights sweeps. Each tick takes `now` as an argument so tests can drive
 * the whole pipeline with a fixed clock.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { ingestEvents } from "@/db/schema";
import { runScheduledPublish, sweepArticleRights } from "@/core/articles";
import { sweepCardRights } from "@/core/cards";
import { processIngestEvent } from "@/core/ingest/process";
import { claim, complete, fail, PermanentJobError, type ClaimedJob } from "@/core/jobs";
import { type Distributor, processOutbox } from "@/core/outbox";

export type JobHandler = (db: Db, job: ClaimedJob, now: Date) => Promise<void>;

export const handlers: Record<string, JobHandler> = {
  "ingest.process": async (db, job, now) => {
    await processIngestEvent(db, (job.payload as { ingestEventId: string }).ingestEventId, now);
  },
  "article.publish": async (db, job, now) => {
    const p = job.payload as { articleId: string; versionId: string };
    await runScheduledPublish(db, p.articleId, p.versionId, now);
  },
};

/** Claim and run jobs until none are due. Returns the number of jobs handled. */
export async function runDueJobs(db: Db, worker: string, now: Date, opts: { max?: number; handlers?: Record<string, JobHandler>; random?: () => number } = {}): Promise<number> {
  const table = opts.handlers ?? handlers;
  let n = 0;
  for (; n < (opts.max ?? 500); n++) {
    const job = await claim(db, worker, now);
    if (!job) break;
    try {
      const handler = table[job.kind];
      if (!handler) throw new PermanentJobError(`no handler for job kind ${job.kind}`);
      await handler(db, job, now);
      await complete(db, job, worker, now);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const outcome = await fail(db, job, worker, now, message, { retryable: !(e instanceof PermanentJobError), random: opts.random });
      if (outcome === "dead" && job.kind === "ingest.process") {
        // The producer's receipt must show the failure; an operator replay resets it.
        await db
          .update(ingestEvents)
          .set({ status: "failed", reasonCode: "PROCESSING_FAILED", retryable: true, processedAt: now })
          .where(eq(ingestEvents.id, (job.payload as { ingestEventId: string }).ingestEventId));
      }
      console.error(JSON.stringify({ msg: "job_failed", jobId: job.id, kind: job.kind, queue: job.queue, attempts: job.attempts, outcome, error: message }));
    }
  }
  return n;
}

/** One scheduler pass: rights sweeps, then publication events. */
export async function schedulerTick(db: Db, distributor: Distributor, now: Date) {
  const cards = await db.transaction((tx) => sweepCardRights(tx, now));
  const copies = await sweepArticleRights(db, now);
  const outbox = await processOutbox(db, distributor, now);
  return { cardsSuppressed: cards, copiesSuppressed: copies, outbox };
}
