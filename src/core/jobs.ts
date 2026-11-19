/**
 * Durable job queue on PostgreSQL (ING-04, ARC-01).
 *
 * Workers claim with row locking and an expiring lease. A crashed worker's
 * lease runs out and the job becomes claimable again. Transient failures retry
 * with exponential backoff and jitter; after max attempts the job is dead and
 * waits for a manual replay under the same business key.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db/client";
import { jobs } from "@/db/schema";

export const LEASE_MS = 60_000;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export interface EnqueueInput {
  queue: string;
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
}

/** Idempotent: a second enqueue with the same key is a no-op. Returns true when a row was created. */
export async function enqueue(db: DbOrTx, input: EnqueueInput): Promise<boolean> {
  const rows = await db
    .insert(jobs)
    .values({
      queue: input.queue,
      kind: input.kind,
      key: input.key,
      payload: input.payload,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: jobs.key })
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export type ClaimedJob = typeof jobs.$inferSelect;

/**
 * Claim one due job. A queue runs one job at a time, so a slow or failing
 * source cannot starve other sources, and one source's items apply in order.
 */
export async function claim(db: Db, worker: string, now: Date, leaseMs = LEASE_MS): Promise<ClaimedJob | null> {
  const lease = new Date(now.getTime() + leaseMs);
  const result = await db.execute<{ id: string }>(sql`
    update jobs set status = 'running', lease_owner = ${worker}, lease_expires_at = ${lease.toISOString()}::timestamptz,
                    attempts = attempts + 1
    where id = (
      select j.id from jobs j
      where ((j.status = 'queued' and j.run_at <= ${now.toISOString()}::timestamptz)
          or (j.status = 'running' and j.lease_expires_at <= ${now.toISOString()}::timestamptz))
        and not exists (
          select 1 from jobs r
          where r.queue = j.queue and r.id <> j.id and r.status = 'running'
            and r.lease_expires_at > ${now.toISOString()}::timestamptz)
      order by j.run_at, j.created_at
      for update skip locked
      limit 1)
    returning id`);
  const id = result.rows[0]?.id;
  if (!id) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  return job ?? null;
}

export async function complete(db: DbOrTx, job: ClaimedJob, worker: string, now: Date): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "succeeded", finishedAt: now, leaseOwner: null, leaseExpiresAt: null, lastError: null })
    .where(and(eq(jobs.id, job.id), eq(jobs.leaseOwner, worker)));
}

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + (exp / 2) * random());
}

/** Record a failure. Returns "retry" or "dead". */
export async function fail(
  db: DbOrTx,
  job: ClaimedJob,
  worker: string,
  now: Date,
  error: string,
  opts: { retryable?: boolean; random?: () => number } = {},
): Promise<"retry" | "dead"> {
  const retryable = opts.retryable ?? true;
  const dead = !retryable || job.attempts >= job.maxAttempts;
  await db
    .update(jobs)
    .set(
      dead
        ? { status: "dead", finishedAt: now, leaseOwner: null, leaseExpiresAt: null, lastError: error.slice(0, 2000) }
        : {
            status: "queued",
            runAt: new Date(now.getTime() + backoffMs(job.attempts, opts.random)),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: error.slice(0, 2000),
          },
    )
    .where(and(eq(jobs.id, job.id), eq(jobs.leaseOwner, worker)));
  return dead ? "dead" : "retry";
}

/** Replay a dead-lettered job under its original business key. */
export async function replayDead(db: DbOrTx, jobId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "queued", attempts: 0, runAt: now, finishedAt: null, lastError: null })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "dead")))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** Marks a failure that must not be retried. */
export class PermanentJobError extends Error {}
