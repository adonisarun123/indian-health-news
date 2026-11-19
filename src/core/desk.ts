/** Read models for the newsroom (ED-01, ADM-04). Private: never used by public pages. */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { articles, articleVersions, auditEntries, editorialTasks, memberships, people, sourceAutomation, sourceGrants, sourceItems, sourceRevisions, sources, terms } from "@/db/schema";
import { loadCurrentGrant } from "./cards";

/** Source items that are not public as a card or copy, newest first, with the reason and next action. */
export async function listQueue(db: Db, limit = 100) {
  const res = await db.execute<{ id: string; external_id: string; title: string | null; url: string; publisher: string; source_slug: string; reasons: string[]; risk_route: string; risk_flags: string[]; revision: number; observed_at: string; has_body: boolean; status: string }>(sql`
    select si.id, si.external_id, sr.title, sr.submitted_url as url, s.display_name as publisher, s.slug as source_slug,
           sr.hold_reasons as reasons, sr.risk_route, sr.risk_flags, sr.revision, sr.observed_at, sr.body_text is not null as has_body, si.status
    from source_items si
    join source_revisions sr on sr.id = si.current_revision_id
    join sources s on s.id = si.source_id
    where sr.kind = 'upsert'
      and not exists (select 1 from feed_entries fe where fe.source_item_id = si.id and fe.status = 'active')
      and not exists (select 1 from articles a where a.source_item_id = si.id and a.public_version_id is not null)
    order by sr.observed_at desc
    limit ${limit}`);
  return res.rows;
}

export async function listTasks(db: Db, limit = 100) {
  return db.select().from(editorialTasks).where(eq(editorialTasks.status, "open")).orderBy(desc(editorialTasks.createdAt)).limit(limit);
}

export async function closeTask(db: Db, taskId: string, status: "done" | "dismissed", now: Date): Promise<void> {
  await db.update(editorialTasks).set({ status, closedAt: now }).where(eq(editorialTasks.id, taskId));
}

export async function getItem(db: Db, itemId: string) {
  const [row] = await db.select({ item: sourceItems, source: sources }).from(sourceItems).innerJoin(sources, eq(sources.id, sourceItems.sourceId)).where(eq(sourceItems.id, itemId));
  if (!row) return null;
  const revisions = await db.select().from(sourceRevisions).where(eq(sourceRevisions.itemId, itemId)).orderBy(desc(sourceRevisions.revision));
  const grant = await loadCurrentGrant(db, row.source.id, new Date());
  const clusters = await db.execute<{ cluster_id: string; item_id: string; title: string | null; publisher: string; confidence: string; decision: string }>(sql`
    select ci.cluster_id, o.item_id, sr.title, s.display_name as publisher, o.confidence, o.decision
    from cluster_items ci
    join cluster_items o on o.cluster_id = ci.cluster_id and o.item_id <> ci.item_id
    join source_items si on si.id = o.item_id
    join source_revisions sr on sr.id = si.current_revision_id
    join sources s on s.id = si.source_id
    where ci.item_id = ${itemId}`);
  return { ...row, revisions, grant, matches: clusters.rows };
}

export async function listStories(db: Db, opts: { status?: string; createdBy?: string } = {}) {
  return db
    .select({ id: articles.id, slug: articles.slug, type: articles.type, status: articles.status, riskRoute: articles.riskRoute, updatedAt: articles.updatedAt, headline: articleVersions.headline, isPublic: sql<boolean>`${articles.publicVersionId} is not null`, pending: sql<boolean>`${articles.draftVersionId} is distinct from ${articles.publicVersionId}`, author: people.displayName })
    .from(articles)
    .innerJoin(articleVersions, eq(articleVersions.id, articles.draftVersionId))
    .leftJoin(people, eq(people.id, articleVersions.authorPersonId))
    .where(and(opts.status ? sql`${articles.status} = ${opts.status}` : undefined, opts.createdBy ? eq(articles.createdBy, opts.createdBy) : undefined))
    .orderBy(desc(articles.updatedAt))
    .limit(200);
}

export async function listSourcesAdmin(db: Db) {
  const rows = await db.select().from(sources).orderBy(sources.displayName);
  const now = new Date();
  const out = [];
  for (const s of rows) {
    const grant = await loadCurrentGrant(db, s.id, now);
    const automation = await db.select().from(sourceAutomation).where(eq(sourceAutomation.sourceId, s.id));
    out.push({ source: s, grant, automation: Object.fromEntries(automation.map((a) => [a.format, a.enabled])) as Record<string, boolean> });
  }
  return out;
}

export async function getSourceAdmin(db: Db, id: string) {
  const [source] = await db.select().from(sources).where(eq(sources.id, id));
  if (!source) return null;
  const grants = await db.select().from(sourceGrants).where(eq(sourceGrants.sourceId, id)).orderBy(desc(sourceGrants.version));
  const automation = await db.select().from(sourceAutomation).where(eq(sourceAutomation.sourceId, id));
  const hosts = await db.execute<{ host: string }>(sql`select host from source_hosts where source_id = ${id} order by host`);
  const counts = await db.execute<{ status: string; n: string }>(sql`select status, count(*) as n from ingest_events where source_id = ${id} group by status`);
  const dead = await db.execute<{ n: string }>(sql`select count(*) as n from jobs where queue = ${`source:${id}`} and status = 'dead'`);
  return { source, grants, current: await loadCurrentGrant(db, id, new Date()), automation: Object.fromEntries(automation.map((a) => [a.format, a.enabled])) as Record<string, boolean>, hosts: hosts.rows.map((h) => h.host), events: Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)])), deadJobs: Number(dead.rows[0]?.n ?? 0) };
}

export async function listStaff(db: Db) {
  const rows = await db.select().from(people).orderBy(people.displayName);
  const roles = await db.select().from(memberships).where(isNull(memberships.revokedAt));
  return rows.map((p) => ({ ...p, roles: roles.filter((r) => r.personId === p.id).map((r) => r.role) }));
}

export async function listAudit(db: Db, limit = 200) {
  return db.select().from(auditEntries).orderBy(desc(auditEntries.createdAt)).limit(limit);
}

export async function listStateTerms(db: Db) {
  return db.select({ id: terms.id, slug: terms.slug, name: terms.name }).from(terms).where(eq(terms.kind, "state")).orderBy(terms.name);
}

/** Source census (SRC-04): counts by state of the register, so gaps are visible. */
export async function sourceCensus(db: Db) {
  const res = await db.execute<{ status: string; n: string }>(sql`select status, count(*) as n from sources group by status`);
  return Object.fromEntries(res.rows.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
}
