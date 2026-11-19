/**
 * Intake boundary (API-01..03).
 *
 * `receiveEvent` authenticates, validates and durably queues one event. The
 * event row and its work item are written in one transaction before any
 * success reply, so a 202 always means the work survives a crash.
 */
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  ingestEvents,
  producerRateWindows,
  producers,
  producerSecrets,
  producerSources,
  sourceHosts,
  sources,
} from "@/db/schema";
import { canonicalJson, decryptSecret, safeEqualHex, sha256Hex, signRequest } from "../crypto";
import { enqueue } from "../jobs";
import { checkSourceUrl } from "../urls";
import { type ApiError, ingestEvent, MAX_BODY_BYTES, MAX_SKEW_SECONDS, type Receipt } from "./contract";

export interface HttpResult {
  status: number;
  body: Receipt | ApiError;
  headers?: Record<string, string>;
}

export interface RequestHeaders {
  producerKey: string | null;
  timestamp: string | null;
  signature: string | null;
  idempotencyKey: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const err = (status: number, code: string, message: string, extra: Partial<ApiError> = {}, headers?: Record<string, string>): HttpResult => ({
  status,
  body: { code, message, ...extra },
  headers,
});

export function statusUrl(eventId: string): string {
  return `/api/v1/ingest/events/${eventId}`;
}

type Producer = typeof producers.$inferSelect;

/** Shared by POST and GET: producer lookup, clock skew and HMAC check. */
async function authenticate(
  db: Db,
  h: RequestHeaders,
  eventId: string,
  rawBody: Buffer,
  now: Date,
): Promise<{ producer: Producer } | { error: HttpResult }> {
  const unauth = (code: string, message: string) => ({ error: err(401, code, message) });
  if (!h.producerKey || !h.timestamp || !h.signature) return unauth("AUTH_HEADERS_MISSING", "X-Producer-Key, X-Timestamp and X-Signature are required.");
  if (!/^\d{1,12}$/.test(h.timestamp)) return unauth("TIMESTAMP_INVALID", "X-Timestamp must be Unix seconds.");
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(h.timestamp));
  if (skew > MAX_SKEW_SECONDS) return unauth("TIMESTAMP_SKEW", "X-Timestamp is outside the five-minute window. Sign again with a fresh timestamp.");

  const [producer] = await db.select().from(producers).where(eq(producers.keyId, h.producerKey));
  if (!producer || !producer.isActive) return unauth("SIGNATURE_INVALID", "Signature check failed.");

  const secrets = await db
    .select()
    .from(producerSecrets)
    .where(
      and(
        eq(producerSecrets.producerId, producer.id),
        lte(producerSecrets.validFrom, now),
        or(isNull(producerSecrets.validUntil), gt(producerSecrets.validUntil, now)),
      ),
    );
  const ok = secrets.some((s) => safeEqualHex(h.signature!, signRequest(decryptSecret(s.secretCiphertext), h.timestamp!, eventId, rawBody)));
  if (!ok) return unauth("SIGNATURE_INVALID", "Signature check failed.");
  return { producer };
}

async function overRateLimit(db: Db, producer: Producer, now: Date): Promise<number | null> {
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const [row] = await db
    .insert(producerRateWindows)
    .values({ producerId: producer.id, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [producerRateWindows.producerId, producerRateWindows.windowStart],
      set: { count: sql`${producerRateWindows.count} + 1` },
    })
    .returning({ count: producerRateWindows.count });
  if ((row?.count ?? 0) <= producer.ratePerMinute) return null;
  return Math.max(1, Math.ceil((windowStart.getTime() + 60_000 - now.getTime()) / 1000));
}

function receiptOf(row: typeof ingestEvents.$inferSelect): Receipt {
  return {
    event_id: row.eventId,
    status: row.status,
    status_url: statusUrl(row.eventId),
    ...(row.reasonCode ? { reason_code: row.reasonCode } : {}),
    ...(row.status === "failed" ? { retryable: row.retryable } : {}),
  };
}

export async function receiveEvent(db: Db, h: RequestHeaders, rawBody: Buffer, now: Date): Promise<HttpResult> {
  if (rawBody.length > MAX_BODY_BYTES) return err(413, "BODY_TOO_LARGE", "Request body exceeds 256 KiB.");
  if (!h.idempotencyKey || !UUID.test(h.idempotencyKey)) return err(400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be the event_id UUID.");
  const eventId = h.idempotencyKey.toLowerCase();

  const auth = await authenticate(db, h, eventId, rawBody, now);
  if ("error" in auth) return auth.error;
  const { producer } = auth;

  const retryAfter = await overRateLimit(db, producer, now);
  if (retryAfter !== null) return err(429, "RATE_LIMITED", "Too many requests. Retry the same bytes and ID later.", {}, { "Retry-After": String(retryAfter) });

  const payloadDigest = sha256Hex(rawBody);

  // A retry after a lost response: identical bytes return the original receipt.
  const replay = async (): Promise<HttpResult | null> => {
    const [existing] = await db
      .select()
      .from(ingestEvents)
      .where(and(eq(ingestEvents.producerId, producer.id), eq(ingestEvents.eventId, eventId)));
    if (!existing) return null;
    if (existing.payloadDigest === payloadDigest) return { status: 200, body: receiptOf(existing) };
    return err(409, "EVENT_ID_REUSED", "This event_id was already used with different content. Use a new event ID for a changed revision.");
  };
  const replayed = await replay();
  if (replayed) return replayed;

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return err(400, "MALFORMED_JSON", "Body is not valid UTF-8 JSON.");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return err(400, "MALFORMED_JSON", "Body must be a JSON object.");

  const version = (json as Record<string, unknown>).schema_version;
  if (version !== 1) {
    return err(422, "SCHEMA_VERSION_UNSUPPORTED", "Only schema_version 1 is supported.", {
      field_errors: [{ field: "schema_version", message: "must be 1" }],
    });
  }

  const parsed = ingestEvent.safeParse(json);
  if (!parsed.success) {
    return err(422, "VALIDATION_FAILED", "One or more fields are invalid.", {
      field_errors: parsed.error.issues.map((i) => ({ field: i.path.join(".") || "(body)", message: i.message })),
    });
  }
  const event = parsed.data;
  if (event.event_id.toLowerCase() !== eventId) {
    return err(422, "VALIDATION_FAILED", "Idempotency-Key must equal event_id.", {
      field_errors: [{ field: "event_id", message: "does not match the Idempotency-Key header" }],
    });
  }

  // Source ownership. An unknown source and an unassigned source look the same to the caller.
  const [owned] = await db
    .select({ source: sources })
    .from(sources)
    .innerJoin(producerSources, and(eq(producerSources.sourceId, sources.id), eq(producerSources.producerId, producer.id)))
    .where(eq(sources.slug, event.source_id));
  if (!owned) return err(403, "SOURCE_NOT_AUTHORIZED", "This producer is not assigned to that source.");
  const source = owned.source;
  if (source.status === "revoked") return err(403, "SOURCE_REVOKED", "This source has been revoked. Intake is closed.");
  if (source.status === "paused") return err(403, "SOURCE_PAUSED", "This source is paused. Intake resumes when it is enabled again.");

  const hosts = await db.select().from(sourceHosts).where(eq(sourceHosts.sourceId, source.id));
  const urlFields: [string, string | undefined][] = [["source_url", event.source_url]];
  if (event.event_type === "item.upsert") {
    urlFields.push(["document_url", event.document_url], ["resolved_url", event.resolved_url], ["canonical_url", event.canonical_url]);
  }
  const urlErrors = urlFields.flatMap(([field, value]) => {
    if (!value) return [];
    const c = checkSourceUrl(value, hosts);
    return c.ok ? [] : [{ field, message: c.reason }];
  });
  if (urlErrors.length > 0) return err(422, "URL_NOT_ALLOWED", "A URL is outside the approved hosts for this source.", { field_errors: urlErrors });

  const { event_id: _e, observed_at: _o, ...content } = event;
  const contentDigest = sha256Hex(canonicalJson(content));

  // Same source item and revision submitted under a new event ID with different content.
  const sameRevision = await db
    .select({ contentDigest: ingestEvents.contentDigest })
    .from(ingestEvents)
    .where(and(eq(ingestEvents.sourceId, source.id), eq(ingestEvents.externalId, event.external_id), eq(ingestEvents.revision, event.revision)));
  if (sameRevision.some((r) => r.contentDigest !== contentDigest)) {
    return err(409, "REVISION_CONFLICT", "This revision number already exists with different content. Increment the revision for a changed item.");
  }

  try {
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(ingestEvents)
        .values({
          producerId: producer.id,
          eventId,
          sourceId: source.id,
          externalId: event.external_id,
          revision: event.revision,
          eventType: event.event_type,
          payloadDigest,
          contentDigest,
          payload: event,
          receivedAt: now,
        })
        .returning();
      await enqueue(tx, {
        queue: `source:${source.id}`,
        kind: "ingest.process",
        key: `ingest:${inserted!.id}`,
        payload: { ingestEventId: inserted!.id },
        runAt: now,
      });
      return inserted!;
    });
    return { status: 202, body: receiptOf(row) };
  } catch (e) {
    // Two identical requests raced. The loser reads the winner's receipt.
    if ((e as { code?: string; cause?: { code?: string } }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") {
      const again = await replay();
      if (again) return again;
    }
    throw e;
  }
}

/** Receipt status, readable only by the producer that submitted the event (API-03, ADM-04). */
export async function getReceipt(db: Db, h: Omit<RequestHeaders, "idempotencyKey">, eventIdRaw: string, now: Date): Promise<HttpResult> {
  if (!UUID.test(eventIdRaw)) return err(404, "NOT_FOUND", "No such event.");
  const eventId = eventIdRaw.toLowerCase();
  const auth = await authenticate(db, { ...h, idempotencyKey: null }, eventId, Buffer.alloc(0), now);
  if ("error" in auth) return auth.error;
  const [row] = await db
    .select()
    .from(ingestEvents)
    .where(and(eq(ingestEvents.producerId, auth.producer.id), eq(ingestEvents.eventId, eventId)));
  // Another producer's event is indistinguishable from a missing one.
  if (!row) return err(404, "NOT_FOUND", "No such event.");
  return { status: 200, body: { ...receiptOf(row), retryable: row.retryable } };
}
