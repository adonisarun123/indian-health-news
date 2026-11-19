import { after } from "next/server";
import { getDb } from "@/db/client";
import { processOutbox } from "@/core/outbox";
import { runDueJobs } from "@/worker/run";
import { nextDistributor } from "./cache";

/**
 * Run due work right after the response is sent: process accepted intake,
 * release anything scheduled and deliver publication events. This keeps
 * freshness within seconds without holding the request open. The scheduled
 * tick and the standalone worker cover anything this misses.
 */
export function pump(): void {
  after(async () => {
    try {
      const db = getDb();
      await runDueJobs(db, "web", new Date(), { max: 25 });
      await processOutbox(db, nextDistributor, new Date());
    } catch (e) {
      console.error(JSON.stringify({ msg: "pump_error", error: e instanceof Error ? e.message : String(e) }));
    }
  });
}
