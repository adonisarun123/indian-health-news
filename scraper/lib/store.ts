/**
 * Durable scraper state in SQLite (node:sqlite, no extra dependency).
 *
 * - items:  the last revision sent for each source item and the hash of its content.
 * - outbox: every event exactly as first serialised. A retry resends these bytes, so
 *           intake sees an idempotent replay, never EVENT_ID_REUSED.
 * - feeds:  conditional-GET validators, failures and backoff per source.
 * - alerts: what needs a person, de-duplicated per source and kind for a day.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Candidate, contentHash } from "./event";

const SCHEMA = `
create table if not exists items (
  source_id text not null,
  external_id text not null,
  revision integer not null,
  content_hash text not null,
  source_url text not null,
  resolved_url text,
  first_seen_at text not null,
  last_seen_at text not null,
  primary key (source_id, external_id)
);
create table if not exists outbox (
  event_id text primary key,
  source_id text not null,
  external_id text not null,
  revision integer not null,
  body text not null,
  state text not null check (state in ('pending', 'sent', 'parked', 'dropped')),
  attempts integer not null default 0,
  next_attempt_at text not null,
  http_status integer,
  receipt_status text,
  reason_code text,
  last_error text,
  created_at text not null,
  sent_at text,
  receipt_checked_at text,
  unique (source_id, external_id, revision)
);
create index if not exists outbox_due on outbox (state, next_attempt_at);
create table if not exists feeds (
  source_id text primary key,
  etag text,
  last_modified text,
  last_fetch_at text,
  last_ok_at text,
  last_outcome text,
  last_status integer,
  last_item_count integer,
  newest_item_at text,
  failures integer not null default 0,
  backoff_until text
);
create table if not exists alerts (
  id integer primary key autoincrement,
  at text not null,
  source_id text,
  kind text not null,
  message text not null
);
`;

export interface OutboxRow {
  event_id: string;
  source_id: string;
  external_id: string;
  revision: number;
  body: string;
  state: "pending" | "sent" | "parked" | "dropped";
  attempts: number;
  next_attempt_at: string;
  http_status: number | null;
  receipt_status: string | null;
  reason_code: string | null;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  receipt_checked_at: string | null;
}

export interface FeedRow {
  source_id: string;
  etag: string | null;
  last_modified: string | null;
  last_fetch_at: string | null;
  last_ok_at: string | null;
  last_outcome: string | null;
  last_status: number | null;
  last_item_count: number | null;
  newest_item_at: string | null;
  failures: number;
  backoff_until: string | null;
}

export type StageResult = "new" | "revised" | "unchanged" | "invalid";

const iso = (d: Date) => d.toISOString();

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000; pragma foreign_keys = on;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  /* ───────────── feeds ───────────── */

  feed(sourceId: string): FeedRow | undefined {
    return this.db.prepare("select * from feeds where source_id = ?").get(sourceId) as FeedRow | undefined;
  }

  saveFeed(sourceId: string, patch: Partial<Omit<FeedRow, "source_id">>) {
    const cur = this.feed(sourceId);
    const next: FeedRow = {
      source_id: sourceId,
      etag: null, last_modified: null, last_fetch_at: null, last_ok_at: null, last_outcome: null, last_status: null,
      last_item_count: null, newest_item_at: null, failures: 0, backoff_until: null,
      ...cur,
      ...patch,
    };
    this.db
      .prepare(
        `insert into feeds (source_id, etag, last_modified, last_fetch_at, last_ok_at, last_outcome, last_status, last_item_count, newest_item_at, failures, backoff_until)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (source_id) do update set etag = excluded.etag, last_modified = excluded.last_modified, last_fetch_at = excluded.last_fetch_at,
           last_ok_at = excluded.last_ok_at, last_outcome = excluded.last_outcome, last_status = excluded.last_status, last_item_count = excluded.last_item_count,
           newest_item_at = excluded.newest_item_at, failures = excluded.failures, backoff_until = excluded.backoff_until`,
      )
      .run(next.source_id, next.etag, next.last_modified, next.last_fetch_at, next.last_ok_at, next.last_outcome, next.last_status, next.last_item_count, next.newest_item_at, next.failures, next.backoff_until);
  }

  /* ───────────── items and outbox ───────────── */

  resolvedFor(sourceId: string, externalId: string): string | null | undefined {
    const row = this.db.prepare("select resolved_url from items where source_id = ? and external_id = ?").get(sourceId, externalId) as { resolved_url: string | null } | undefined;
    return row ? row.resolved_url : undefined;
  }

  /**
   * Record a candidate. A first sighting becomes revision 1; changed content gets
   * the next revision and drops any older event for the item that has not gone out.
   * `build` turns (revision, event_id) into the exact body, or null when invalid.
   */
  stage(c: Candidate, now: Date, build: (revision: number, eventId: string) => string | null): StageResult {
    const hash = contentHash(c);
    return this.tx(() => {
      const row = this.db.prepare("select revision, content_hash from items where source_id = ? and external_id = ?").get(c.sourceId, c.externalId) as
        | { revision: number; content_hash: string }
        | undefined;
      if (row && row.content_hash === hash) {
        this.db.prepare("update items set last_seen_at = ? where source_id = ? and external_id = ?").run(iso(now), c.sourceId, c.externalId);
        return "unchanged";
      }
      const revision = row ? row.revision + 1 : 1;
      const eventId = randomUUID();
      const body = build(revision, eventId);
      if (body === null) return "invalid";
      if (row) {
        this.db
          .prepare("update items set revision = ?, content_hash = ?, source_url = ?, resolved_url = ?, last_seen_at = ? where source_id = ? and external_id = ?")
          .run(revision, hash, c.sourceUrl, c.resolvedUrl ?? null, iso(now), c.sourceId, c.externalId);
        this.db
          .prepare("update outbox set state = 'dropped', last_error = ? where source_id = ? and external_id = ? and state = 'pending' and revision < ?")
          .run(`superseded locally by revision ${revision}`, c.sourceId, c.externalId, revision);
      } else {
        this.db
          .prepare("insert into items (source_id, external_id, revision, content_hash, source_url, resolved_url, first_seen_at, last_seen_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(c.sourceId, c.externalId, revision, hash, c.sourceUrl, c.resolvedUrl ?? null, iso(now), iso(now));
      }
      this.db
        .prepare("insert into outbox (event_id, source_id, external_id, revision, body, state, next_attempt_at, created_at) values (?, ?, ?, ?, ?, 'pending', ?, ?)")
        .run(eventId, c.sourceId, c.externalId, revision, body, iso(now), iso(now));
      return row ? "revised" : "new";
    });
  }

  due(now: Date, limit: number): OutboxRow[] {
    return this.db.prepare("select * from outbox where state = 'pending' and next_attempt_at <= ? order by created_at, rowid limit ?").all(iso(now), limit) as unknown as OutboxRow[];
  }

  markSent(eventId: string, now: Date, httpStatus: number, receiptStatus: string, reasonCode: string | null) {
    this.db
      .prepare("update outbox set state = 'sent', attempts = attempts + 1, http_status = ?, receipt_status = ?, reason_code = ?, last_error = null, sent_at = ?, receipt_checked_at = ? where event_id = ?")
      .run(httpStatus, receiptStatus, reasonCode, iso(now), iso(now), eventId);
  }

  markRetry(eventId: string, nextAt: Date, error: string, countAttempt = true) {
    this.db
      .prepare(`update outbox set attempts = attempts + ?, next_attempt_at = ?, last_error = ? where event_id = ?`)
      .run(countAttempt ? 1 : 0, iso(nextAt), error, eventId);
  }

  markParked(eventId: string, httpStatus: number | null, error: string) {
    this.db.prepare("update outbox set state = 'parked', attempts = attempts + 1, http_status = ?, last_error = ? where event_id = ?").run(httpStatus, error, eventId);
  }

  /**
   * Intake already holds this revision with other content (for example after a
   * lost local database). Re-issue the same content as the next revision.
   */
  reissue(row: OutboxRow, now: Date): string {
    return this.tx(() => {
      const item = this.db.prepare("select revision from items where source_id = ? and external_id = ?").get(row.source_id, row.external_id) as { revision: number } | undefined;
      const revision = Math.max(item?.revision ?? 0, row.revision) + 1;
      const eventId = randomUUID();
      const body = JSON.stringify({ ...(JSON.parse(row.body) as Record<string, unknown>), event_id: eventId, revision });
      this.db.prepare("update outbox set state = 'dropped', last_error = 'REVISION_CONFLICT: re-issued as revision ' || ? where event_id = ?").run(revision, row.event_id);
      this.db.prepare("update items set revision = ? where source_id = ? and external_id = ?").run(revision, row.source_id, row.external_id);
      this.db
        .prepare("insert into outbox (event_id, source_id, external_id, revision, body, state, next_attempt_at, created_at) values (?, ?, ?, ?, ?, 'pending', ?, ?)")
        .run(eventId, row.source_id, row.external_id, revision, body, iso(now), iso(now));
      return eventId;
    });
  }

  /** Sent events whose receipt is still accepted or processing, not checked in the last minute, sent in the last day. */
  receiptsDue(now: Date, limit = 200): OutboxRow[] {
    const minuteAgo = iso(new Date(now.getTime() - 60_000));
    const dayAgo = iso(new Date(now.getTime() - 86_400_000));
    return this.db
      .prepare("select * from outbox where state = 'sent' and receipt_status in ('accepted', 'processing') and receipt_checked_at <= ? and sent_at >= ? order by sent_at limit ?")
      .all(minuteAgo, dayAgo, limit) as unknown as OutboxRow[];
  }

  setReceipt(eventId: string, now: Date, status: string, reasonCode: string | null) {
    this.db.prepare("update outbox set receipt_status = ?, reason_code = ?, receipt_checked_at = ? where event_id = ?").run(status, reasonCode, iso(now), eventId);
  }

  outbox(eventId: string): OutboxRow | undefined {
    return this.db.prepare("select * from outbox where event_id = ?").get(eventId) as OutboxRow | undefined;
  }

  /* ───────────── alerts and status ───────────── */

  /** Record an alert. Returns false when the same source and kind was raised in the last 24 hours. */
  alert(sourceId: string | null, kind: string, message: string, now: Date): boolean {
    const since = iso(new Date(now.getTime() - 86_400_000));
    const dup = this.db.prepare("select 1 from alerts where coalesce(source_id, '') = coalesce(?, '') and kind = ? and at >= ?").get(sourceId, kind, since);
    if (dup) return false;
    this.db.prepare("insert into alerts (at, source_id, kind, message) values (?, ?, ?, ?)").run(iso(now), sourceId, kind, message);
    return true;
  }

  recentAlerts(limit = 20): { at: string; source_id: string | null; kind: string; message: string }[] {
    return this.db.prepare("select at, source_id, kind, message from alerts order by id desc limit ?").all(limit) as unknown as { at: string; source_id: string | null; kind: string; message: string }[];
  }

  feeds(): FeedRow[] {
    return this.db.prepare("select * from feeds order by source_id").all() as unknown as FeedRow[];
  }

  outboxCounts(): { source_id: string; state: string; receipt_status: string | null; n: number }[] {
    return this.db.prepare("select source_id, state, receipt_status, count(*) as n from outbox group by source_id, state, receipt_status order by source_id").all() as unknown as {
      source_id: string;
      state: string;
      receipt_status: string | null;
      n: number;
    }[];
  }
}
