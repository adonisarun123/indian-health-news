/**
 * Candidate items to v1 intake events. Every event is checked against the
 * platform's own schema (src/core/ingest/contract.ts) before it is stored, so
 * the scraper cannot drift from the contract without a failing test.
 */
import { createHash } from "node:crypto";
import { type UpsertEvent, upsertEvent } from "../../src/core/ingest/contract";

export const ADAPTER_VERSIONS = {
  rss: "rss@1.0.0",
  news_sitemap: "news-sitemap@1.0.0",
} as const;

export interface Candidate {
  sourceId: string;
  externalId: string;
  sourceUrl: string;
  resolvedUrl?: string;
  title: string;
  /** ISO 8601 with offset, or null with `publishedReason`. */
  publishedAt: string | null;
  publishedReason?: string;
  updatedAt?: string;
  author?: string;
  excerpt?: string;
  adapterVersion: string;
}

/** What makes a new revision: any change the platform would show or match on. */
export function contentHash(c: Candidate): string {
  const fields = [c.sourceUrl, c.resolvedUrl ?? null, c.title, c.excerpt ?? null, c.publishedAt, c.updatedAt ?? null, c.author ?? null];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export type Built = { ok: true; event: UpsertEvent; body: string } | { ok: false; errors: string[] };

export function buildEvent(c: Candidate, revision: number, eventId: string, observedAt: Date): Built {
  const draft = {
    schema_version: 1,
    event_id: eventId,
    source_id: c.sourceId,
    external_id: c.externalId,
    revision,
    event_type: "item.upsert",
    source_url: c.sourceUrl,
    ...(c.resolvedUrl && c.resolvedUrl !== c.sourceUrl ? { resolved_url: c.resolvedUrl } : {}),
    source_title: c.title,
    language: "en",
    source_published_at: c.publishedAt,
    ...(c.publishedAt === null ? { source_published_at_reason: c.publishedReason ?? "feed gives no publication time" } : {}),
    ...(c.updatedAt ? { source_updated_at: c.updatedAt } : {}),
    ...(c.author ? { source_author: c.author } : {}),
    ...(c.excerpt ? { excerpt: c.excerpt } : {}),
    adapter_version: c.adapterVersion,
    observed_at: observedAt.toISOString(),
  };
  const parsed = upsertEvent.safeParse(draft);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(event)"}: ${i.message}`) };
  return { ok: true, event: parsed.data, body: JSON.stringify(draft) };
}
