/**
 * Scraper intake contract, schema version 1 (API-01, API-02).
 * Unknown fields are rejected. The server owns all rights and publication decisions.
 */
import { z } from "zod";

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_SKEW_SECONDS = 300;
export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

const isoWithOffset = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/, "must be ISO 8601 with an explicit offset")
  .refine((s) => !Number.isNaN(Date.parse(s)), "is not a real date");

const httpsUrl = z.string().max(2048).refine((s) => {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}, "must be an https URL");

const base = {
  schema_version: z.literal(1),
  event_id: z.uuid(),
  source_id: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase slug"),
  external_id: z.string().min(1).max(300),
  revision: z.number().int().positive().max(2_147_483_647),
  source_url: httpsUrl,
  observed_at: isoWithOffset,
};

const mediaCandidate = z.strictObject({
  url: httpsUrl,
  caption: z.string().max(500).optional(),
  credit: z.string().max(300).optional(),
});

export const upsertEvent = z
  .strictObject({
    ...base,
    event_type: z.literal("item.upsert"),
    source_title: z.string().min(1).max(500),
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "must be a BCP 47 language tag"),
    source_published_at: isoWithOffset.nullable(),
    source_published_at_reason: z.string().min(1).max(300).optional(),
    source_updated_at: isoWithOffset.optional(),
    source_author: z.string().max(300).optional(),
    excerpt: z.string().max(2000).optional(),
    document_url: httpsUrl.optional(),
    resolved_url: httpsUrl.optional(),
    canonical_url: httpsUrl.optional(),
    adapter_version: z.string().max(60).optional(),
    media_candidates: z.array(mediaCandidate).max(10).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.source_published_at === null && !v.source_published_at_reason) {
      ctx.addIssue({
        code: "custom",
        path: ["source_published_at_reason"],
        message: "is required when source_published_at is null",
      });
    }
  });

export const withdrawEvent = z.strictObject({
  ...base,
  event_type: z.literal("item.withdraw"),
  reason: z.string().min(1).max(1000),
  source_title: z.string().min(1).max(500).optional(),
  language: z.string().max(35).optional(),
  adapter_version: z.string().max(60).optional(),
});

export const ingestEvent = z.discriminatedUnion("event_type", [upsertEvent, withdrawEvent]);

export type UpsertEvent = z.infer<typeof upsertEvent>;
export type WithdrawEvent = z.infer<typeof withdrawEvent>;
export type IngestEvent = z.infer<typeof ingestEvent>;

export interface ApiError {
  code: string;
  message: string;
  field_errors?: { field: string; message: string }[];
}

export interface Receipt {
  event_id: string;
  status: "accepted" | "processing" | "held" | "applied" | "superseded" | "failed";
  status_url: string;
  reason_code?: string;
  retryable?: boolean;
}
