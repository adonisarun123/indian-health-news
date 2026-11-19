/**
 * External source cards. A card links straight to the publisher. It has no
 * local article permalink and never carries article markup (PUB-01, PUB-02).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { feedEntries, sourceAutomation, sourceGrants, sourceItems, sourceRevisions, sources } from "@/db/schema";
import { activeSuppression, audit, emit, getFlags } from "./audit";
import { cardTitle, currentGrant, decideSourceCard, type CardDecision, type GrantView } from "./policy";
import { languageMismatch } from "./risk";

type Source = typeof sources.$inferSelect;
type Item = typeof sourceItems.$inferSelect;
type Revision = typeof sourceRevisions.$inferSelect;

export async function loadCurrentGrant(db: DbOrTx, sourceId: string, now: Date) {
  const grants = await db.select().from(sourceGrants).where(eq(sourceGrants.sourceId, sourceId));
  return currentGrant(grants as (typeof grants[number] & GrantView)[], now);
}

/** Evaluate the card rule for the item's current revision, using live state. */
export async function evaluateCard(
  db: DbOrTx,
  source: Source,
  item: Item,
  revision: Revision,
  now: Date,
): Promise<{ decision: CardDecision; grant: Awaited<ReturnType<typeof loadCurrentGrant>> }> {
  // Sequential on purpose: a transaction runs on one connection.
  const grant = await loadCurrentGrant(db, source.id, now);
  const flags = await getFlags(db);
  const automation = await db.select().from(sourceAutomation).where(and(eq(sourceAutomation.sourceId, source.id), eq(sourceAutomation.format, "source_card")));
  const suppression = await activeSuppression(db, "source_item", item.id);
  const decision = decideSourceCard({
    sourceStatus: source.status,
    grant,
    riskRoute: revision.riskRoute,
    riskFlags: revision.riskFlags,
    flags: { autoPublish: flags.auto_publish ?? false, sourceCards: flags.source_cards ?? false },
    automationEnabled: automation[0]?.enabled ?? false,
    embargoUntil: item.embargoUntil,
    sourcePublishedAt: revision.sourcePublishedAt,
    languageMismatch: revision.title ? languageMismatch(revision.language ?? source.language, revision.title) : false,
    suppressed: Boolean(suppression) || item.status === "withdrawn",
    now,
  });
  return { decision, grant };
}

/** Publish or refresh the single active card for an item. Feed row and outbox event commit together. */
export async function publishCard(db: DbOrTx, source: Source, item: Item, revision: Revision, grant: GrantView, now: Date): Promise<string> {
  const [previous] = await db
    .select()
    .from(feedEntries)
    .where(and(eq(feedEntries.sourceItemId, item.id), eq(feedEntries.kind, "source_card")))
    .orderBy(desc(feedEntries.createdAt))
    .limit(1);
  await db
    .update(feedEntries)
    .set({ status: "replaced" })
    .where(and(eq(feedEntries.sourceItemId, item.id), eq(feedEntries.kind, "source_card"), eq(feedEntries.status, "active")));
  const [entry] = await db
    .insert(feedEntries)
    .values({
      kind: "source_card",
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      displayTitle: cardTitle(grant, revision.title, source.neutralLabel, source.displayName),
      publisherName: source.displayName,
      targetUrl: revision.submittedUrl,
      // A refreshed card keeps its place in the timeline.
      visibleFrom: previous?.status === "active" ? previous.visibleFrom : now,
      scope: grant.channels,
      grantId: grant.id,
    })
    .returning({ id: feedEntries.id });
  await emit(db, {
    eventType: "source_card.published",
    aggregateType: "source_item",
    aggregateId: item.id,
    payload: { feedEntryId: entry!.id, revision: revision.revision },
  });
  return entry!.id;
}

/** Take a card off every public surface. */
export async function pullCard(db: DbOrTx, itemId: string, status: "withdrawn" | "suppressed", reason: string): Promise<number> {
  const rows = await db
    .update(feedEntries)
    .set({ status })
    .where(and(eq(feedEntries.sourceItemId, itemId), eq(feedEntries.kind, "source_card"), eq(feedEntries.status, "active")))
    .returning({ id: feedEntries.id });
  if (rows.length > 0) {
    await emit(db, { eventType: "source_card.removed", aggregateType: "source_item", aggregateId: itemId, payload: { reason } });
  }
  return rows.length;
}

/**
 * Editor release of a card that is waiting only because automation is off.
 * A risk-flagged item cannot be released this way: it needs editor and medical
 * sign-off on an exact version, which the article workflow provides.
 */
export async function releaseCard(
  db: DbOrTx,
  actor: { personId: string; roles: string[] },
  itemId: string,
  reason: string,
  now: Date,
): Promise<{ ok: true; feedEntryId: string } | { ok: false; reasons: string[] }> {
  if (!actor.roles.some((r) => r === "editor" || r === "managing_editor")) return { ok: false, reasons: ["FORBIDDEN"] };
  const [item] = await db.select().from(sourceItems).where(eq(sourceItems.id, itemId)).for("update");
  if (!item?.currentRevisionId) return { ok: false, reasons: ["NOT_FOUND"] };
  const [revision] = await db.select().from(sourceRevisions).where(eq(sourceRevisions.id, item.currentRevisionId));
  const [source] = await db.select().from(sources).where(eq(sources.id, item.sourceId));
  if (!revision || !source) return { ok: false, reasons: ["NOT_FOUND"] };
  const { decision, grant } = await evaluateCard(db, source, item, revision, now);
  if (decision.outcome === "hold" || !grant) return { ok: false, reasons: decision.reasons };
  const feedEntryId = await publishCard(db, source, item, revision, grant, now);
  await audit(db, { actorType: "staff", actorId: actor.personId, action: "source_card.release", subjectType: "source_item", subjectId: itemId, reason });
  return { ok: true, feedEntryId };
}

/**
 * Rights sweep (COR-01 rights expiry or revocation). Cards whose source no
 * longer has a grant in force come down. Read paths also check the grant at
 * query time, so a late sweep never leaves expired content public.
 */
export async function sweepCardRights(db: DbOrTx, now: Date): Promise<number> {
  const active = await db
    .select({ entry: feedEntries, sourceId: sourceItems.sourceId })
    .from(feedEntries)
    .innerJoin(sourceItems, eq(sourceItems.id, feedEntries.sourceItemId))
    .where(and(eq(feedEntries.kind, "source_card"), eq(feedEntries.status, "active")));
  const bySource = new Map<string, string[]>();
  for (const row of active) bySource.set(row.sourceId, [...(bySource.get(row.sourceId) ?? []), row.entry.sourceItemId!]);
  let pulled = 0;
  for (const [sourceId, itemIds] of bySource) {
    const grant = await loadCurrentGrant(db, sourceId, now);
    if (grant?.channels.includes("web")) continue;
    for (const itemId of itemIds) {
      await db.select({ id: sourceItems.id }).from(sourceItems).where(eq(sourceItems.id, itemId)).for("update");
      pulled += await pullCard(db, itemId, "suppressed", "RIGHTS_EXPIRED");
    }
    await audit(db, { actorType: "system", action: "source_card.rights_sweep", subjectType: "source", subjectId: sourceId, diff: { items: itemIds.length } });
  }
  return pulled;
}

export async function activeCardsForItems(db: DbOrTx, itemIds: string[]) {
  if (itemIds.length === 0) return [];
  return db
    .select()
    .from(feedEntries)
    .where(and(inArray(feedEntries.sourceItemId, itemIds), eq(feedEntries.status, "active")));
}
