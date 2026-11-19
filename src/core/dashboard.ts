/**
 * Operational dashboard for the newsroom landing page (ED-01, ADM-04).
 * Private read model: counts only, built from records the platform already keeps.
 * It holds no traffic or readership figures, because no analytics are collected (OPS-04).
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { sourceGrants, sources } from "@/db/schema";
import { getFlags } from "./audit";
import { currentGrant, type GrantView } from "./policy";

const DAY = 86_400_000;
/** Days of publishing history shown in the chart. */
export const DASHBOARD_DAYS = 14;
/** A grant that ends or falls due for review inside this window is listed. */
export const GRANT_WINDOW_DAYS = 30;

export interface DashboardDay {
  /** IST calendar day, YYYY-MM-DD. */
  day: string;
  reports: number;
  cards: number;
}

export interface GrantNotice {
  sourceId: string;
  publisher: string;
  /** "missing": an enabled source with no grant in force. */
  kind: "missing" | "expires" | "review";
  at: Date | null;
}

export interface Dashboard {
  generatedAt: Date;
  autoPublish: boolean;
  days: DashboardDay[];
  live: { reports: number; cards: number };
  waiting: { total: number; reasons: { reason: string; n: number }[] };
  stories: { byStatus: Record<string, number>; needEditor: number; needMedical: number; nextScheduledAt: Date | null };
  tasks: { total: number; urgent: number; byKind: { kind: string; n: number }[]; oldestAt: Date | null };
  cases: { open: number; inProgress: number; urgent: number; oldestAt: Date | null };
  sources: { byStatus: Record<string, number>; notices: GrantNotice[] };
  pipeline: { events24h: Record<string, number>; lastEventAt: Date | null; failedEvents: number; deadJobs: number; overdueJobs: number; pendingOutbox: number; failedDeliveries: number };
}

const num = (v: unknown) => Number(v ?? 0);
const date = (v: unknown) => (v ? new Date(v as string) : null);

export async function getDashboard(db: Db, now: Date): Promise<Dashboard> {
  const at = now.toISOString();

  const days = await db.execute<{ day: string; reports: number; cards: number }>(sql`
    with bounds as (select (${at}::timestamptz at time zone 'Asia/Kolkata')::date as today),
         days as (select generate_series(today - ${DASHBOARD_DAYS - 1}::int, today, interval '1 day')::date as day from bounds)
    select to_char(d.day, 'YYYY-MM-DD') as day,
           count(fe.id) filter (where fe.kind = 'article')::int as reports,
           count(fe.id) filter (where fe.kind = 'source_card')::int as cards
    from days d
    left join feed_entries fe
      on fe.status = 'active'
     and fe.visible_from <= ${at}::timestamptz
     and (fe.visible_from at time zone 'Asia/Kolkata')::date = d.day
    group by d.day
    order by d.day`);

  const live = await db.execute<{ reports: number; cards: number }>(sql`
    select count(*) filter (where kind = 'article')::int as reports,
           count(*) filter (where kind = 'source_card')::int as cards
    from feed_entries
    where status = 'active' and visible_from <= ${at}::timestamptz`);

  // Same definition of "waiting" as the queue (listQueue in desk.ts).
  const waiting = await db.execute<{ reason: string | null; n: number; total: number }>(sql`
    with q as (
      select si.id, sr.hold_reasons
      from source_items si
      join source_revisions sr on sr.id = si.current_revision_id
      where sr.kind = 'upsert'
        and not exists (select 1 from feed_entries fe where fe.source_item_id = si.id and fe.status = 'active')
        and not exists (select 1 from articles a where a.source_item_id = si.id and a.public_version_id is not null)
    )
    select r.reason, count(*)::int as n, (select count(*)::int from q) as total
    from q left join lateral unnest(q.hold_reasons) as r(reason) on true
    group by r.reason
    order by n desc, r.reason`);

  const stories = await db.execute<{ status: string; n: number }>(sql`select status::text as status, count(*)::int as n from articles group by status`);
  const review = await db.execute<{ need_editor: number; need_medical: number; next_scheduled: string | null }>(sql`
    select
      count(*) filter (where a.status = 'in_review' and not exists (
        select 1 from approvals p where p.version_id = a.draft_version_id and p.kind = 'editorial' and p.decision = 'approved'))::int as need_editor,
      count(*) filter (where a.status = 'in_review' and a.risk_route <> 'routine' and not exists (
        select 1 from approvals p where p.version_id = a.draft_version_id and p.kind = 'medical' and p.decision = 'approved'))::int as need_medical,
      min(a.scheduled_at) filter (where a.status = 'scheduled') as next_scheduled
    from articles a`);

  const tasks = await db.execute<{ kind: string; n: number; oldest: string }>(sql`
    select kind, count(*)::int as n, min(created_at) as oldest from editorial_tasks where status = 'open' group by kind order by n desc, kind`);

  const cases = await db.execute<{ open: number; in_progress: number; urgent: number; oldest: string | null }>(sql`
    select count(*) filter (where status = 'open')::int as open,
           count(*) filter (where status = 'in_progress')::int as in_progress,
           count(*) filter (where is_urgent)::int as urgent,
           min(created_at) as oldest
    from cases where status in ('open', 'in_progress')`);

  const sourceRows = await db.select({ id: sources.id, displayName: sources.displayName, status: sources.status }).from(sources).orderBy(sources.displayName);
  const grantRows = await db.select().from(sourceGrants);
  const byStatus: Record<string, number> = {};
  const notices: GrantNotice[] = [];
  const horizon = new Date(now.getTime() + GRANT_WINDOW_DAYS * DAY);
  for (const s of sourceRows) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    if (s.status !== "enabled") continue;
    const grant = currentGrant(grantRows.filter((g) => g.sourceId === s.id) as ((typeof grantRows)[number] & GrantView)[], now);
    if (!grant) notices.push({ sourceId: s.id, publisher: s.displayName, kind: "missing", at: null });
    else if (grant.expiresAt && grant.expiresAt <= horizon) notices.push({ sourceId: s.id, publisher: s.displayName, kind: "expires", at: grant.expiresAt });
    else if (grant.reviewAt && grant.reviewAt <= horizon) notices.push({ sourceId: s.id, publisher: s.displayName, kind: "review", at: grant.reviewAt });
  }

  const events = await db.execute<{ status: string; n: number }>(sql`
    select status::text as status, count(*)::int as n from ingest_events
    where received_at > ${at}::timestamptz - interval '24 hours' group by status`);
  const health = await db.execute<{ last_event: string | null; failed_events: number; dead_jobs: number; overdue_jobs: number; pending_outbox: number; failed_deliveries: number }>(sql`
    select (select max(received_at) from ingest_events) as last_event,
           (select count(*)::int from ingest_events where status = 'failed') as failed_events,
           (select count(*)::int from jobs where status = 'dead') as dead_jobs,
           (select count(*)::int from jobs where status = 'queued' and run_at < ${at}::timestamptz - interval '15 minutes') as overdue_jobs,
           (select count(*)::int from outbox where processed_at is null) as pending_outbox,
           (select count(*)::int from deliveries where state = 'failed') as failed_deliveries`);

  const flags = await getFlags(db);
  const taskRows = tasks.rows;
  const h = health.rows[0];
  const r = review.rows[0];
  const c = cases.rows[0];
  return {
    generatedAt: now,
    autoPublish: Boolean(flags.auto_publish),
    days: days.rows.map((d) => ({ day: d.day, reports: num(d.reports), cards: num(d.cards) })),
    live: { reports: num(live.rows[0]?.reports), cards: num(live.rows[0]?.cards) },
    waiting: {
      total: num(waiting.rows[0]?.total),
      reasons: waiting.rows.filter((w) => num(w.total) > 0).map((w) => ({ reason: w.reason ?? "NOT_RELEASED", n: num(w.n) })),
    },
    stories: {
      byStatus: Object.fromEntries(stories.rows.map((s) => [s.status, num(s.n)])),
      needEditor: num(r?.need_editor),
      needMedical: num(r?.need_medical),
      nextScheduledAt: date(r?.next_scheduled),
    },
    tasks: {
      total: taskRows.reduce((a, t) => a + num(t.n), 0),
      urgent: taskRows.filter((t) => t.kind.startsWith("urgent")).reduce((a, t) => a + num(t.n), 0),
      byKind: taskRows.map((t) => ({ kind: t.kind, n: num(t.n) })),
      oldestAt: taskRows.reduce<Date | null>((a, t) => { const d = date(t.oldest); return d && (!a || d < a) ? d : a; }, null),
    },
    cases: { open: num(c?.open), inProgress: num(c?.in_progress), urgent: num(c?.urgent), oldestAt: date(c?.oldest) },
    sources: { byStatus, notices },
    pipeline: {
      events24h: Object.fromEntries(events.rows.map((e) => [e.status, num(e.n)])),
      lastEventAt: date(h?.last_event),
      failedEvents: num(h?.failed_events),
      deadJobs: num(h?.dead_jobs),
      overdueJobs: num(h?.overdue_jobs),
      pendingOutbox: num(h?.pending_outbox),
      failedDeliveries: num(h?.failed_deliveries),
    },
  };
}

export interface Attention {
  tone: "warn" | "info";
  text: string;
  href: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The short list at the top of the page: what a person should act on, most serious first. */
export function attention(d: Dashboard): Attention[] {
  const out: Attention[] = [];
  const warn = (text: string, href: string) => out.push({ tone: "warn", text, href });
  const info = (text: string, href: string) => out.push({ tone: "info", text, href });
  if (!d.autoPublish) warn("Automatic publishing is stopped. Incoming items wait in the queue.", "/newsroom/settings");
  if (d.cases.urgent) warn(`${plural(d.cases.urgent, "urgent reader case")} open.`, "/newsroom/cases");
  if (d.tasks.urgent) warn(`${plural(d.tasks.urgent, "urgent task")} open.`, "/newsroom/queue");
  if (d.pipeline.failedEvents) warn(`${plural(d.pipeline.failedEvents, "ingest event")} failed.`, "/newsroom/sources");
  if (d.pipeline.deadJobs) warn(`${plural(d.pipeline.deadJobs, "background job")} gave up after repeated failures.`, "/newsroom/sources");
  if (d.pipeline.overdueJobs) warn(`${plural(d.pipeline.overdueJobs, "background job")} overdue by more than 15 minutes. The scheduler may not be running.`, "/newsroom/settings");
  const missing = d.sources.notices.filter((n) => n.kind === "missing").length;
  if (missing) warn(`${plural(missing, "enabled source")} with no rights grant in force.`, "/newsroom/sources");
  const ending = d.sources.notices.filter((n) => n.kind !== "missing").length;
  if (ending) info(`${plural(ending, "rights grant")} ending or due for review within ${GRANT_WINDOW_DAYS} days.`, "/newsroom/sources");
  if (d.stories.needEditor) info(`${plural(d.stories.needEditor, "story", "stories")} waiting for an editor.`, "/newsroom/stories?status=in_review");
  if (d.stories.needMedical) info(`${plural(d.stories.needMedical, "story", "stories")} waiting for medical review.`, "/newsroom/stories?status=in_review");
  if (d.stories.byStatus.approved) info(`${plural(d.stories.byStatus.approved, "approved story", "approved stories")} not yet published.`, "/newsroom/stories?status=approved");
  if (d.waiting.total) info(`${plural(d.waiting.total, "source item")} waiting in the queue.`, "/newsroom/queue");
  return out;
}
