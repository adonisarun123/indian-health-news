/**
 * Outbox consumer (ARC-01, ARC-02, DB-03).
 *
 * A publication event is written in the same transaction as the public
 * change. This consumer fans it out to delivery targets exactly once per
 * target. Before a publish-type delivery it rechecks live state, so an old or
 * replayed event can never bring back content that was suppressed since.
 */
import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { articles, deliveries, feedEntries, outbox, sourceItems, sources } from "@/db/schema";
import { activeSuppression } from "./audit";
import { loadCurrentGrant } from "./cards";

export type OutboxEvent = typeof outbox.$inferSelect;

export interface Distributor {
  deliver(target: string, event: OutboxEvent): Promise<void>;
}

/** Phase 1 default. Phase 4 replaces it with cache invalidation, CDN purge, RSS and sitemap rebuilds. */
export const logDistributor: Distributor = {
  async deliver(target, event) {
    console.log(JSON.stringify({ msg: "delivery", target, eventType: event.eventType, aggregateId: event.aggregateId, version: event.aggregateVersion }));
  },
};

const ARTICLE_TARGETS = ["cache:article", "cache:home", "cache:hubs", "feed:rss", "sitemap"];
const CARD_TARGETS = ["cache:home", "feed:rss"];
const PUBLISH_EVENTS = new Set(["article.published", "article.corrected", "source_card.published"]);

export function targetsFor(event: OutboxEvent): string[] {
  return event.aggregateType === "article" ? ARTICLE_TARGETS : CARD_TARGETS;
}

/** Why a publish-type event must not be delivered, or null when it is still current. */
async function staleReason(tx: Tx, event: OutboxEvent, now: Date): Promise<string | null> {
  if (!PUBLISH_EVENTS.has(event.eventType)) return null; // Removals are always safe to deliver.
  const newerDelivered = async (): Promise<string | null> => {
    const [newer] = await tx
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(
        eq(outbox.aggregateType, event.aggregateType),
        eq(outbox.aggregateId, event.aggregateId),
        gt(outbox.aggregateVersion, event.aggregateVersion),
        isNotNull(outbox.processedAt),
      ),
    )
    .limit(1);
    return newer ? "outdated: a newer event was already delivered" : null;
  };

  const payload = event.payload as { versionId?: string; feedEntryId?: string };
  if (event.aggregateType === "article") {
    const [a] = await tx.select().from(articles).where(eq(articles.id, event.aggregateId));
    if (!a) return "article missing";
    if (await activeSuppression(tx, "article", a.id)) return "suppressed";
    if (a.publicVersionId !== payload.versionId) return "outdated: public version moved on";
    if (a.type === "licensed_copy" && a.sourceItemId) {
      const [row] = await tx.select({ s: sources }).from(sourceItems).innerJoin(sources, eq(sources.id, sourceItems.sourceId)).where(eq(sourceItems.id, a.sourceItemId));
      const grant = row?.s.status === "enabled" ? await loadCurrentGrant(tx, row.s.id, now) : null;
      if (!grant || grant.id !== a.grantId) return "rights no longer in force";
    }
    return newerDelivered();
  }
  if (await activeSuppression(tx, "source_item", event.aggregateId)) return "suppressed";
  const [entry] = payload.feedEntryId ? await tx.select().from(feedEntries).where(eq(feedEntries.id, payload.feedEntryId)) : [];
  if (!entry || entry.status !== "active") return "outdated: card replaced or removed";
  return newerDelivered();
}

async function handle(tx: Tx, event: OutboxEvent, distributor: Distributor, now: Date, replay: boolean): Promise<{ delivered: number; dropped: number }> {
  const stale = await staleReason(tx, event, now);
  let delivered = 0;
  let dropped = 0;
  for (const target of targetsFor(event)) {
    await tx.insert(deliveries).values({ outboxId: event.id, target }).onConflictDoNothing();
    const [d] = await tx.select().from(deliveries).where(and(eq(deliveries.outboxId, event.id), eq(deliveries.target, target))).for("update");
    if (!d) continue;
    if (stale) {
      // A delivery that already happened stays on record; the replay itself is refused.
      await tx.update(deliveries).set(d.state === "delivered" ? { detail: `replay refused: ${stale}` } : { state: "dropped", detail: stale }).where(eq(deliveries.id, d.id));
      dropped++;
      continue;
    }
    if (d.state === "delivered" && !replay) continue;
    await distributor.deliver(target, event);
    await tx.update(deliveries).set({ state: "delivered", attempts: d.attempts + 1, deliveredAt: now, detail: null }).where(eq(deliveries.id, d.id));
    delivered++;
  }
  return { delivered, dropped };
}

/** Drain pending events. Safe to run from several workers at once. */
export async function processOutbox(db: Db, distributor: Distributor, now: Date, limit = 100): Promise<{ events: number; delivered: number; dropped: number }> {
  const total = { events: 0, delivered: 0, dropped: 0 };
  for (let i = 0; i < limit; i++) {
    const done = await db.transaction(async (tx) => {
      const [event] = await tx.select().from(outbox).where(isNull(outbox.processedAt)).orderBy(asc(outbox.createdAt), asc(outbox.aggregateVersion)).limit(1).for("update", { skipLocked: true });
      if (!event) return false;
      const r = await handle(tx, event, distributor, now, false);
      await tx.update(outbox).set({ processedAt: now }).where(eq(outbox.id, event.id));
      total.events++;
      total.delivered += r.delivered;
      total.dropped += r.dropped;
      return true;
    });
    if (!done) break;
  }
  return total;
}

/** Operator replay of one event. Redelivers only if the content is still entitled to be public. */
export async function replayOutboxEvent(db: Db, distributor: Distributor, outboxId: string, now: Date): Promise<{ delivered: number; dropped: number }> {
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(outbox).where(eq(outbox.id, outboxId)).for("update");
    if (!event) return { delivered: 0, dropped: 0 };
    return handle(tx, event, distributor, now, true);
  });
}
