/**
 * Worker-side processing of one accepted event (ING-01, ING-02, ING-05).
 *
 * Three identities are kept apart: the event (one submission), the source
 * item (one publisher's evolving item) and the story cluster (one editorial
 * subject). Everything for one event happens in a single transaction.
 */
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import {
  articleCitations,
  articles,
  articleVersions,
  clusterItems,
  feedEntries,
  ingestEvents,
  sourceAutomation,
  sourceItems,
  sourceItemUrls,
  sourceRevisions,
  sources,
  storyClusters,
  suppressions,
} from "@/db/schema";
import { audit, emit, openTask } from "../audit";
import { autoPublishLicensedCopy } from "../articles";
import { getFlags } from "../audit";
import { evaluateCard, loadCurrentGrant, publishCard, pullCard } from "../cards";
import { assessRisk, detectScript, jaccard, titleFingerprint, titleTokens } from "../risk";
import { normalizeUrl } from "../urls";
import type { IngestEvent, UpsertEvent, WithdrawEvent } from "./contract";

export interface ProcessResult {
  status: "applied" | "held" | "superseded" | "skipped";
  reasonCode: string | null;
}

const CLUSTER_WINDOW_MS = 72 * 3600 * 1000;
const CLUSTER_THRESHOLD = 0.6;

export async function processIngestEvent(db: Db, ingestEventId: string, now: Date): Promise<ProcessResult> {
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(ingestEvents).where(eq(ingestEvents.id, ingestEventId)).for("update");
    if (!event) return { status: "skipped", reasonCode: "EVENT_NOT_FOUND" };
    if (event.status !== "accepted" && event.status !== "processing") return { status: "skipped", reasonCode: event.reasonCode };

    const finish = async (status: "applied" | "held" | "superseded", reasonCode: string): Promise<ProcessResult> => {
      await tx.update(ingestEvents).set({ status, reasonCode, processedAt: now, retryable: false }).where(eq(ingestEvents.id, event.id));
      return { status, reasonCode };
    };

    const payload = event.payload as IngestEvent;
    const [source] = await tx.select().from(sources).where(eq(sources.id, event.sourceId));
    if (!source) throw new Error(`source ${event.sourceId} missing`);

    await tx.insert(sourceItems).values({ sourceId: source.id, externalId: event.externalId, firstSeenAt: now, updatedAt: now }).onConflictDoNothing();
    const [item] = await tx
      .select()
      .from(sourceItems)
      .where(and(eq(sourceItems.sourceId, source.id), eq(sourceItems.externalId, event.externalId)))
      .for("update");
    if (!item) throw new Error("source item missing after upsert");

    // Only a strictly newer revision is applied. A late or repeated one is recorded and dropped.
    if (event.revision <= item.highestRevision) {
      return finish("superseded", event.revision === item.highestRevision ? "DUPLICATE_REVISION" : "STALE_REVISION");
    }

    const priorRevision = item.currentRevisionId
      ? (await tx.select().from(sourceRevisions).where(eq(sourceRevisions.id, item.currentRevisionId)))[0]
      : undefined;

    if (payload.event_type === "item.withdraw") {
      await applyWithdrawal(tx, event.id, source.displayName, item, payload, priorRevision?.normalizedUrl, now);
      return finish("applied", "WITHDRAWN");
    }
    return applyUpsert(tx, event.id, source, item, payload, priorRevision, now, finish);
  });
}

async function applyUpsert(
  tx: Tx,
  ingestEventId: string,
  source: typeof sources.$inferSelect,
  item: typeof sourceItems.$inferSelect,
  p: UpsertEvent,
  prior: typeof sourceRevisions.$inferSelect | undefined,
  now: Date,
  finish: (status: "applied" | "held" | "superseded", reasonCode: string) => Promise<ProcessResult>,
): Promise<ProcessResult> {
  const normalizedUrl = normalizeUrl(p.canonical_url ?? p.resolved_url ?? p.source_url);
  const risk = assessRisk(`${p.source_title} ${p.excerpt ?? ""}`, source.defaultRiskRoute);
  const extraHolds: string[] = [];

  // The same canonical URL under a second external ID is a data conflict for an editor.
  const [alias] = await tx
    .select()
    .from(sourceItemUrls)
    .where(and(eq(sourceItemUrls.sourceId, source.id), eq(sourceItemUrls.normalizedUrl, normalizedUrl)));
  if (alias && alias.itemId !== item.id) extraHolds.push("URL_ALIAS_CONFLICT");
  else if (!alias) await tx.insert(sourceItemUrls).values({ sourceId: source.id, itemId: item.id, normalizedUrl });

  // Full text is evidence we may hold only under a grant that covers it (SEC-03).
  const intakeGrant = await loadCurrentGrant(tx, source.id, now);
  const bodyText = p.body_text && intakeGrant?.allowFullText ? p.body_text : null;
  if (p.body_text && !bodyText) {
    const { body_text: _dropped, ...kept } = p;
    await tx.update(ingestEvents).set({ payload: kept }).where(eq(ingestEvents.id, ingestEventId));
  }

  const [revision] = await tx
    .insert(sourceRevisions)
    .values({
      itemId: item.id,
      revision: p.revision,
      kind: "upsert",
      bodyText,
      ingestEventId,
      submittedUrl: p.source_url,
      resolvedUrl: p.resolved_url ?? null,
      declaredCanonicalUrl: p.canonical_url ?? null,
      normalizedUrl,
      title: p.source_title,
      language: p.language,
      detectedScript: detectScript(p.source_title),
      sourceAuthor: p.source_author ?? null,
      excerpt: p.excerpt ?? null,
      documentUrl: p.document_url ?? null,
      mediaCandidates: p.media_candidates ?? null,
      sourcePublishedAt: p.source_published_at ? new Date(p.source_published_at) : null,
      sourcePublishedAtReason: p.source_published_at_reason ?? null,
      sourceUpdatedAt: p.source_updated_at ? new Date(p.source_updated_at) : null,
      observedAt: new Date(p.observed_at),
      checksum: (await tx.select({ d: ingestEvents.contentDigest }).from(ingestEvents).where(eq(ingestEvents.id, ingestEventId)))[0]!.d,
      fingerprint: titleFingerprint(p.source_title),
      adapterVersion: p.adapter_version ?? null,
      riskRoute: risk.route,
      riskFlags: risk.flags,
    })
    .returning();
  if (!revision) throw new Error("revision insert failed");

  const liveItem = { ...item, highestRevision: p.revision, currentRevisionId: revision.id };
  await tx
    .update(sourceItems)
    .set({ highestRevision: p.revision, currentRevisionId: revision.id, updatedAt: now })
    .where(eq(sourceItems.id, item.id));

  // A source change never overwrites approved copy. It opens a review for each linked story.
  if (prior) await notifyLinkedStories(tx, item.id, "source_changed", `Source item changed to revision ${p.revision}: ${changedFields(prior, revision).join(", ") || "metadata"}`);

  const { decision, grant } = await evaluateCard(tx, source, liveItem, revision, now);
  const reasons = decision.outcome === "hold" ? [...decision.reasons, ...extraHolds] : extraHolds.length > 0 ? extraHolds : decision.reasons;
  const outcome = extraHolds.length > 0 ? "hold" : decision.outcome;
  await tx.update(sourceRevisions).set({ holdReasons: reasons }).where(eq(sourceRevisions.id, revision.id));

  await suggestClusters(tx, source, item.id, revision, now);

  if (outcome === "publish" && grant) {
    // A partner feed switched on for republication publishes the labelled copy instead of a card.
    if (revision.bodyText && grant.allowFullText) {
      const flags = await getFlags(tx);
      const [auto] = await tx.select().from(sourceAutomation).where(and(eq(sourceAutomation.sourceId, source.id), eq(sourceAutomation.format, "licensed_copy")));
      if (flags.licensed_feeds && auto?.enabled) {
        const copy = await autoPublishLicensedCopy(tx, { source, item: liveItem, revision, grantId: grant.id }, now);
        if (copy.ok) {
          await tx.update(feedEntries).set({ status: "replaced" }).where(and(eq(feedEntries.sourceItemId, item.id), eq(feedEntries.kind, "source_card"), eq(feedEntries.status, "active")));
          return finish("applied", "COPY_PUBLISHED");
        }
        await openTask(tx, { kind: "partner_copy_blocked", subjectType: "source_item", subjectId: item.id, detail: copy.reasons.join(", ") });
      }
    }
    await publishCard(tx, source, liveItem, revision, grant, now);
    return finish("applied", "CARD_PUBLISHED");
  }
  if (outcome === "await_editor") {
    await openTask(tx, { kind: "card_awaiting_editor", subjectType: "source_item", subjectId: item.id, detail: reasons.join(", ") });
    return finish("applied", "AWAITING_EDITOR");
  }
  // Held: the newest revision may not appear, so an earlier card for this item comes down too.
  await pullCard(tx, item.id, "suppressed", reasons[0] ?? "HELD");
  await openTask(tx, { kind: "held_item", subjectType: "source_item", subjectId: item.id, detail: reasons.join(", ") });
  return finish("held", reasons[0] ?? "HELD");
}

function changedFields(a: typeof sourceRevisions.$inferSelect, b: typeof sourceRevisions.$inferSelect): string[] {
  const out: string[] = [];
  if (a.title !== b.title) out.push("title");
  if (a.normalizedUrl !== b.normalizedUrl) out.push("url");
  if (a.excerpt !== b.excerpt) out.push("excerpt");
  if (a.documentUrl !== b.documentUrl) out.push("document");
  if ((a.sourcePublishedAt?.getTime() ?? 0) !== (b.sourcePublishedAt?.getTime() ?? 0)) out.push("published date");
  return out;
}

async function applyWithdrawal(
  tx: Tx,
  ingestEventId: string,
  publisher: string,
  item: typeof sourceItems.$inferSelect,
  p: WithdrawEvent,
  priorNormalizedUrl: string | undefined,
  now: Date,
): Promise<void> {
  const [revision] = await tx
    .insert(sourceRevisions)
    .values({
      itemId: item.id,
      revision: p.revision,
      kind: "withdraw",
      ingestEventId,
      submittedUrl: p.source_url,
      normalizedUrl: priorNormalizedUrl ?? normalizeUrl(p.source_url),
      title: p.source_title ?? null,
      language: p.language ?? null,
      observedAt: new Date(p.observed_at),
      checksum: "withdrawn",
      withdrawReason: p.reason,
      adapterVersion: p.adapter_version ?? null,
    })
    .returning({ id: sourceRevisions.id });
  await tx
    .update(sourceItems)
    .set({ status: "withdrawn", highestRevision: p.revision, currentRevisionId: revision!.id, updatedAt: now })
    .where(eq(sourceItems.id, item.id));
  await tx.insert(suppressions).values({ subjectType: "source_item", subjectId: item.id, kind: "source_withdrawal", reason: p.reason, createdAt: now });
  await pullCard(tx, item.id, "withdrawn", "SOURCE_WITHDRAWN");

  // A partner copy of a withdrawn item comes down immediately.
  const copies = await tx
    .select()
    .from(articles)
    .where(and(eq(articles.sourceItemId, item.id), eq(articles.type, "licensed_copy")));
  for (const copy of copies) {
    await tx.insert(suppressions).values({ subjectType: "article", subjectId: copy.id, kind: "source_withdrawal", reason: `Withdrawn by ${publisher}: ${p.reason}`, createdAt: now });
    await tx.update(feedEntries).set({ status: "suppressed" }).where(and(eq(feedEntries.articleId, copy.id), eq(feedEntries.status, "active")));
    await emit(tx, { eventType: "article.suppressed", aggregateType: "article", aggregateId: copy.id, payload: { kind: "source_withdrawal" } });
  }

  // Original reporting is marked for review. A clinical story whose primary evidence
  // was withdrawn is held off public surfaces until an editor decides (COR-02).
  const linked = await linkedArticles(tx, item.id);
  for (const a of linked) {
    if (a.type === "licensed_copy") continue;
    await openTask(tx, { kind: "source_retracted", subjectType: "article", subjectId: a.id, detail: `${publisher} withdrew a cited source: ${p.reason}` });
    if (a.isPublic && a.riskRoute !== "routine" && a.primaryCited) {
      await tx.insert(suppressions).values({ subjectType: "article", subjectId: a.id, kind: "risk_hold", reason: "Primary source withdrawn upstream; clinical claims held pending review", createdAt: now });
      await tx.update(feedEntries).set({ status: "suppressed" }).where(and(eq(feedEntries.articleId, a.id), eq(feedEntries.status, "active")));
      await emit(tx, { eventType: "article.suppressed", aggregateType: "article", aggregateId: a.id, payload: { kind: "risk_hold" } });
    }
  }
  await audit(tx, { actorType: "producer", action: "source_item.withdraw", subjectType: "source_item", subjectId: item.id, reason: p.reason });
}

/** Articles whose draft or public version cites any revision of this item. */
async function linkedArticles(tx: Tx, itemId: string) {
  const rows = await tx
    .select({
      id: articles.id,
      type: articles.type,
      riskRoute: articles.riskRoute,
      publicVersionId: articles.publicVersionId,
      versionId: articleVersions.id,
      isPrimary: articleCitations.isPrimary,
    })
    .from(articleCitations)
    .innerJoin(sourceRevisions, eq(sourceRevisions.id, articleCitations.sourceRevisionId))
    .innerJoin(articleVersions, eq(articleVersions.id, articleCitations.versionId))
    .innerJoin(articles, eq(articles.id, articleVersions.articleId))
    .where(
      and(
        eq(sourceRevisions.itemId, itemId),
        sql`${articleVersions.id} in (${articles.draftVersionId}, ${articles.publicVersionId})`,
      ),
    );
  const byArticle = new Map<string, { id: string; type: string; riskRoute: string; isPublic: boolean; primaryCited: boolean }>();
  for (const r of rows) {
    const cur = byArticle.get(r.id) ?? { id: r.id, type: r.type, riskRoute: r.riskRoute, isPublic: false, primaryCited: false };
    if (r.publicVersionId && r.versionId === r.publicVersionId) {
      cur.isPublic = true;
      cur.primaryCited ||= r.isPrimary;
    }
    byArticle.set(r.id, cur);
  }
  return [...byArticle.values()];
}

async function notifyLinkedStories(tx: Tx, itemId: string, kind: string, detail: string): Promise<void> {
  for (const a of await linkedArticles(tx, itemId)) {
    await openTask(tx, { kind, subjectType: "article", subjectId: a.id, detail });
  }
}

/**
 * Cross-publisher suggestions only. Headline similarity inside a time window
 * proposes a cluster; it never merges anything. Two sources with different
 * known jurisdictions are left apart, so a similar notice from another state
 * stays a separate story.
 */
async function suggestClusters(
  tx: Tx,
  source: typeof sources.$inferSelect,
  itemId: string,
  revision: typeof sourceRevisions.$inferSelect,
  now: Date,
): Promise<void> {
  if (!revision.title) return;
  const tokens = titleTokens(revision.title);
  const since = new Date(now.getTime() - CLUSTER_WINDOW_MS);
  const candidates = await tx
    .select({
      itemId: sourceItems.id,
      title: sourceRevisions.title,
      fingerprint: sourceRevisions.fingerprint,
      jurisdiction: sources.jurisdictionTermId,
    })
    .from(sourceItems)
    .innerJoin(sourceRevisions, eq(sourceRevisions.id, sourceItems.currentRevisionId))
    .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
    .where(and(ne(sourceItems.sourceId, source.id), eq(sourceItems.status, "active"), gt(sourceRevisions.observedAt, since)))
    .limit(500);

  for (const c of candidates) {
    if (!c.title) continue;
    if (source.jurisdictionTermId && c.jurisdiction && source.jurisdictionTermId !== c.jurisdiction) continue;
    const score = c.fingerprint === revision.fingerprint ? 0.95 : jaccard(tokens, titleTokens(c.title));
    if (score < CLUSTER_THRESHOLD) continue;

    const memberships = await tx
      .select()
      .from(clusterItems)
      .where(and(inArray(clusterItems.itemId, [itemId, c.itemId]), ne(clusterItems.decision, "rejected")));
    const mine = memberships.find((m) => m.itemId === itemId);
    const theirs = memberships.find((m) => m.itemId === c.itemId);
    if (mine && theirs) continue;
    let clusterId = mine?.clusterId ?? theirs?.clusterId;
    if (clusterId) {
      // Never pull a second jurisdiction into a cluster through a shared third item.
      const joining = mine ? c.jurisdiction : source.jurisdictionTermId;
      const members = await tx
        .select({ j: sources.jurisdictionTermId })
        .from(clusterItems)
        .innerJoin(sourceItems, eq(sourceItems.id, clusterItems.itemId))
        .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
        .where(and(eq(clusterItems.clusterId, clusterId), ne(clusterItems.decision, "rejected")));
      if (joining && members.some((m) => m.j && m.j !== joining)) continue;
    }
    if (!clusterId) {
      const [cluster] = await tx.insert(storyClusters).values({ label: revision.title, primaryItemId: c.itemId }).returning({ id: storyClusters.id });
      clusterId = cluster!.id;
    }
    const confidence = score.toFixed(3);
    if (!mine) await tx.insert(clusterItems).values({ clusterId, itemId, confidence }).onConflictDoNothing();
    if (!theirs) await tx.insert(clusterItems).values({ clusterId, itemId: c.itemId, confidence }).onConflictDoNothing();
  }
}

/** Editor decision on a cluster membership. Source rows are never touched (ING-02). */
export async function decideClusterItem(
  db: Db,
  actor: { personId: string },
  input: { clusterId: string; itemId: string; decision: "confirmed" | "rejected"; reason: string },
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(clusterItems)
      .values({ clusterId: input.clusterId, itemId: input.itemId, confidence: "1.000", origin: "human", decision: input.decision, reason: input.reason, decidedBy: actor.personId, decidedAt: now })
      .onConflictDoUpdate({
        target: [clusterItems.clusterId, clusterItems.itemId],
        set: { decision: input.decision, reason: input.reason, decidedBy: actor.personId, decidedAt: now },
      });
    await audit(tx, { actorType: "staff", actorId: actor.personId, action: `cluster.${input.decision}`, subjectType: "story_cluster", subjectId: input.clusterId, reason: input.reason, diff: { itemId: input.itemId } });
  });
}
