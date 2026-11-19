/**
 * Reconciliation (OPS-03). Run after a restore, and on a schedule, to find and
 * repair state that no longer agrees with the record of decisions:
 *
 *  - a public entry whose subject has an active suppression (a restore can
 *    bring back a feed row that was taken down after the backup was made);
 *  - a public story with no visible source;
 *  - a scheduled release with no job to run it;
 *  - publication events that were never delivered.
 *
 * Suppression decisions always win. Nothing here ever makes content public.
 */
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { articles, feedEntries, outbox } from "@/db/schema";
import { audit, emit, openTask } from "./audit";
import { enqueue } from "./jobs";

export interface ReconcileReport {
  suppressionsReapplied: number;
  storiesMissingSource: string[];
  scheduledJobsRestored: number;
  staleOutboxEvents: number;
  ineligibleSitemapEntries: number;
}

export async function reconcile(db: Db, now: Date): Promise<ReconcileReport> {
  return db.transaction(async (tx) => {
    // 1. Reapply withdrawal decisions to any entry that is active but should not be.
    const leaked = await tx.execute<{ id: string; article_id: string | null; source_item_id: string | null }>(sql`
      select fe.id, fe.article_id, fe.source_item_id from feed_entries fe
      where fe.status = 'active' and exists (
        select 1 from suppressions s where s.lifted_at is null and (
          (s.subject_type = 'article' and s.subject_id = fe.article_id) or
          (s.subject_type = 'source_item' and s.subject_id = fe.source_item_id)))
      for update of fe`);
    for (const row of leaked.rows) {
      await tx.update(feedEntries).set({ status: "suppressed" }).where(eq(feedEntries.id, row.id));
      const aggregateType = row.article_id ? "article" : "source_item";
      await emit(tx, { eventType: row.article_id ? "article.suppressed" : "source_card.removed", aggregateType, aggregateId: (row.article_id ?? row.source_item_id)!, payload: { kind: "reconcile" } });
    }
    // A removed or retracted story must not keep an indexable flag either.
    await tx.execute(sql`
      update articles a set is_indexable = false
      where a.is_indexable and exists (select 1 from suppressions s where s.lifted_at is null and s.subject_type = 'article' and s.subject_id = a.id)`);

    // 2. Public stories with no visible citation. Reported, not auto-fixed: an editor must decide.
    const orphans = await tx.execute<{ id: string; slug: string }>(sql`
      select a.id, a.slug from articles a
      where a.public_version_id is not null and a.status = 'published'
        and not exists (select 1 from article_citations c where c.version_id = a.public_version_id)`);
    for (const o of orphans.rows) {
      const open = await tx.execute(sql`select 1 from editorial_tasks where kind = 'story_missing_source' and subject_id = ${o.id} and status = 'open'`);
      if (open.rows.length === 0) await openTask(tx, { kind: "story_missing_source", subjectType: "article", subjectId: o.id, detail: `Public story /news/${o.slug} has no visible source.` });
    }

    // 3. Scheduled releases whose job is missing. The job key is deterministic, so this cannot duplicate one.
    const scheduled = await tx.select().from(articles).where(and(eq(articles.status, "scheduled")));
    let restored = 0;
    for (const a of scheduled) {
      if (!a.scheduledAt || !a.scheduledVersionId) continue;
      if (await enqueue(tx, { queue: "publish", kind: "article.publish", key: `publish:${a.id}:${a.scheduledVersionId}:${a.scheduledAt.getTime()}`, payload: { articleId: a.id, versionId: a.scheduledVersionId }, runAt: a.scheduledAt })) restored++;
    }

    // 4. Events that have waited more than ten minutes for delivery (OPS-02 alert threshold).
    const stale = await tx.select({ id: outbox.id }).from(outbox).where(and(isNull(outbox.processedAt), lt(outbox.createdAt, new Date(now.getTime() - 10 * 60_000))));

    // 5. Indexable flags on anything that is not an original, public story.
    const bad = await tx.execute<{ id: string }>(sql`
      update articles set is_indexable = false
      where is_indexable and (public_version_id is null or type in ('licensed_copy', 'press_material') or status in ('retracted', 'removed'))
      returning id`);

    const report: ReconcileReport = { suppressionsReapplied: leaked.rows.length, storiesMissingSource: orphans.rows.map((o) => o.slug), scheduledJobsRestored: restored, staleOutboxEvents: stale.length, ineligibleSitemapEntries: bad.rows.length };
    if (report.suppressionsReapplied || report.scheduledJobsRestored || report.ineligibleSitemapEntries || report.storiesMissingSource.length) {
      await audit(tx, { actorType: "system", action: "reconcile", subjectType: "system", subjectId: "reconcile", diff: { ...report } });
    }
    return report;
  });
}
