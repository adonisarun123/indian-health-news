import { getDb } from "@/db/client";
import { nextDistributor } from "@/lib/cache";
import { internalAuthorized } from "@/lib/internal";
import { runDueJobs, schedulerTick } from "@/worker/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduler tick for hosts without a long-running worker. Claims due jobs,
 * runs the rights sweeps and delivers publication events. Safe to call from
 * several places at once: jobs are leased and deliveries are unique.
 */
export async function GET(request: Request): Promise<Response> {
  if (!internalAuthorized(request)) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  const db = getDb();
  const now = new Date();
  const jobs = await runDueJobs(db, "tick", now, { max: 200 });
  const tick = await schedulerTick(db, nextDistributor, new Date());
  return Response.json({ jobs, ...tick });
}
