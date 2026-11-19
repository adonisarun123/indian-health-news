/**
 * India Health News — PostgreSQL schema (SRS DB-01..DB-03).
 *
 * Conventions: UUID keys, timestamptz everywhere, UTC stored, IST rendered.
 * Source records are kept separate from published work. Editorial versions
 * are immutable (enforced by trigger in the custom migration).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/* ───────────── enums ───────────── */

export const sourceStatus = pgEnum("source_status", ["proposed", "under_review", "enabled", "paused", "revoked"]);
export const sourceFamily = pgEnum("source_family", [
  "national_authority",
  "state_local",
  "research_professional",
  "independent_commercial",
]);
export const riskRoute = pgEnum("risk_route", ["routine", "clinical", "sensitive"]);
export const grantBasis = pgEnum("grant_basis", [
  "unknown",
  "link_only",
  "public_terms",
  "written_permission",
  "licence",
  "fair_dealing_reviewed",
]);
export const publicFormat = pgEnum("public_format", ["source_card", "licensed_copy"]);
export const ingestStatus = pgEnum("ingest_status", ["accepted", "processing", "held", "applied", "superseded", "failed"]);
export const itemStatus = pgEnum("item_status", ["active", "withdrawn"]);
export const revisionKind = pgEnum("revision_kind", ["upsert", "withdraw"]);
export const clusterOrigin = pgEnum("cluster_origin", ["suggested", "human"]);
export const clusterDecision = pgEnum("cluster_decision", ["pending", "confirmed", "rejected"]);
export const personStatus = pgEnum("person_status", ["invited", "active", "disabled"]);
export const staffRole = pgEnum("staff_role", [
  "source_operator",
  "reporter",
  "medical_reviewer",
  "editor",
  "managing_editor",
  "administrator",
  "auditor",
]);
export const articleType = pgEnum("article_type", [
  "original_brief",
  "original_report",
  "analysis",
  "press_material",
  "licensed_copy",
]);
export const articleStatus = pgEnum("article_status", [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "retracted",
  "removed",
]);
export const contributionType = pgEnum("contribution_type", [
  "prior_notice_comparison",
  "on_record_interview",
  "local_reporting",
  "dataset_analysis",
]);
export const approvalKind = pgEnum("approval_kind", ["editorial", "medical"]);
export const approvalDecision = pgEnum("approval_decision", ["approved", "returned"]);
export const termKind = pgEnum("term_kind", ["section", "state", "topic"]);
export const feedKind = pgEnum("feed_kind", ["source_card", "article"]);
export const feedStatus = pgEnum("feed_status", ["active", "replaced", "withdrawn", "suppressed"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "dead"]);
export const deliveryState = pgEnum("delivery_state", ["pending", "delivered", "dropped", "failed"]);
export const suppressionSubject = pgEnum("suppression_subject", ["article", "source_item", "asset", "source"]);
export const suppressionKind = pgEnum("suppression_kind", [
  "retraction",
  "removal_410",
  "removal_451",
  "rights_expiry",
  "rights_revocation",
  "source_withdrawal",
  "risk_hold",
]);
export const taskStatus = pgEnum("task_status", ["open", "done", "dismissed"]);
export const caseStatus = pgEnum("case_status", ["open", "in_progress", "resolved", "rejected"]);

/* ───────────── people and roles ───────────── */

export const people = pgTable("people", {
  id: id(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull().unique(),
  bio: text("bio"),
  credentials: text("credentials"),
  conflicts: text("conflicts"),
  hasPublicProfile: boolean("has_public_profile").notNull().default(false),
  status: personStatus("status").notNull().default("invited"),
  createdAt: createdAt(),
});

export const desks = pgTable("desks", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    personId: uuid("person_id").notNull().references(() => people.id),
    role: staffRole("role").notNull(),
    deskId: uuid("desk_id").references(() => desks.id),
    grantedBy: uuid("granted_by").references(() => people.id),
    grantedAt: ts("granted_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("memberships_active_uq").on(t.personId, t.role).where(sql`${t.revokedAt} is null`)],
);

/** Credential evidence for medical reviewers. Access is restricted (ADM-01, DB-01). */
export const reviewerCredentials = pgTable("reviewer_credentials", {
  id: id(),
  personId: uuid("person_id").notNull().references(() => people.id),
  specialty: text("specialty").notNull(),
  evidenceUri: text("evidence_uri").notNull(),
  conflicts: text("conflicts"),
  verifiedBy: uuid("verified_by").references(() => people.id),
  verifiedAt: ts("verified_at"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
});

/* ───────────── taxonomy ───────────── */

export const terms = pgTable(
  "terms",
  {
    id: id(),
    kind: termKind("kind").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    intro: text("intro"),
    isHubApproved: boolean("is_hub_approved").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("terms_kind_slug_uq").on(t.kind, t.slug)],
);

export const termAliases = pgTable(
  "term_aliases",
  {
    id: id(),
    termId: uuid("term_id").notNull().references(() => terms.id),
    alias: text("alias").notNull(),
  },
  (t) => [uniqueIndex("term_aliases_alias_uq").on(sql`lower(${t.alias})`)],
);

/* ───────────── sources and rights (SRC-01, SRC-02) ───────────── */

export const sources = pgTable(
  "sources",
  {
    id: id(),
    /** Stable public identifier used as `source_id` in the ingest contract. */
    slug: text("slug").notNull().unique(),
    legalName: text("legal_name").notNull(),
    displayName: text("display_name").notNull(),
    /** Approved neutral label used on a card when the headline is not a permitted field. */
    neutralLabel: text("neutral_label"),
    homepageUrl: text("homepage_url").notNull(),
    discoveryEndpoint: text("discovery_endpoint"),
    adapter: text("adapter"),
    language: text("language").notNull().default("en"),
    family: sourceFamily("family").notNull(),
    jurisdictionTermId: uuid("jurisdiction_term_id").references(() => terms.id),
    contact: text("contact"),
    feedCadenceSeconds: integer("feed_cadence_seconds"),
    maxConcurrency: integer("max_concurrency").notNull().default(1),
    minIntervalMs: integer("min_interval_ms").notNull().default(5000),
    ownerPersonId: uuid("owner_person_id").references(() => people.id),
    trustTier: integer("trust_tier").notNull().default(3),
    defaultRiskRoute: riskRoute("default_risk_route").notNull().default("routine"),
    /** Section for automatically republished partner copies. Without it a copy waits for an editor. */
    defaultSectionSlug: text("default_section_slug"),
    status: sourceStatus("status").notNull().default("proposed"),
    policyVersion: integer("policy_version").notNull().default(1),
    nextPollAt: ts("next_poll_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("sources_status_poll_idx").on(t.status, t.nextPollAt)],
);

export const sourceHosts = pgTable(
  "source_hosts",
  {
    id: id(),
    sourceId: uuid("source_id").notNull().references(() => sources.id),
    host: text("host").notNull(),
    pathPrefix: text("path_prefix").notNull().default("/"),
  },
  (t) => [
    uniqueIndex("source_hosts_uq").on(t.sourceId, t.host, t.pathPrefix),
    check("source_hosts_lower_ck", sql`${t.host} = lower(${t.host})`),
  ],
);

/**
 * Rights register. Each row is an immutable grant version; the current grant is
 * the highest version that is effective, unexpired and unrevoked at use time.
 * Full text, images and feed redistribution each have their own allowance.
 */
export const sourceGrants = pgTable(
  "source_grants",
  {
    id: id(),
    sourceId: uuid("source_id").notNull().references(() => sources.id),
    version: integer("version").notNull(),
    basis: grantBasis("basis").notNull().default("unknown"),
    evidenceUri: text("evidence_uri"),
    termsUrl: text("terms_url"),
    allowHeadline: boolean("allow_headline").notNull().default(false),
    allowExcerpt: boolean("allow_excerpt").notNull().default(false),
    excerptMaxChars: integer("excerpt_max_chars").notNull().default(0),
    allowFullText: boolean("allow_full_text").notNull().default(false),
    allowImages: boolean("allow_images").notNull().default(false),
    allowTranslation: boolean("allow_translation").notNull().default(false),
    allowCaching: boolean("allow_caching").notNull().default(false),
    /** Distribution channels: web, rss, social. */
    channels: text("channels").array().notNull().default(sql`'{}'::text[]`),
    territory: text("territory").notNull().default("IN"),
    attributionText: text("attribution_text"),
    embargoRule: text("embargo_rule"),
    effectiveAt: ts("effective_at").notNull().defaultNow(),
    expiresAt: ts("expires_at"),
    reviewAt: ts("review_at"),
    revokedAt: ts("revoked_at"),
    revokedReason: text("revoked_reason"),
    createdBy: uuid("created_by").references(() => people.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("source_grants_version_uq").on(t.sourceId, t.version),
    index("source_grants_expiry_idx").on(t.expiresAt).where(sql`${t.revokedAt} is null`),
  ],
);

/** Per-source, per-format automation switch (PUB-01). History lives in audit_entries. */
export const sourceAutomation = pgTable(
  "source_automation",
  {
    sourceId: uuid("source_id").notNull().references(() => sources.id),
    format: publicFormat("format").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    updatedBy: uuid("updated_by").references(() => people.id),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.format] })],
);

/** Global rollout controls: auto_publish, source_cards, licensed_feeds, indexing. */
export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull(),
  updatedBy: uuid("updated_by").references(() => people.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/* ───────────── producers (scraper service principals) ───────────── */

export const producers = pgTable("producers", {
  id: id(),
  /** Value of the X-Producer-Key header. Not a secret. */
  keyId: text("key_id").notNull().unique(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  ratePerMinute: integer("rate_per_minute").notNull().default(600),
  createdAt: createdAt(),
});

/** HMAC secrets, encrypted at rest. Overlapping validity windows support rotation (SEC-02). */
export const producerSecrets = pgTable("producer_secrets", {
  id: id(),
  producerId: uuid("producer_id").notNull().references(() => producers.id),
  secretCiphertext: text("secret_ciphertext").notNull(),
  validFrom: ts("valid_from").notNull().defaultNow(),
  validUntil: ts("valid_until"),
  createdAt: createdAt(),
});

export const producerSources = pgTable(
  "producer_sources",
  {
    producerId: uuid("producer_id").notNull().references(() => producers.id),
    sourceId: uuid("source_id").notNull().references(() => sources.id),
  },
  (t) => [primaryKey({ columns: [t.producerId, t.sourceId] })],
);

export const producerRateWindows = pgTable(
  "producer_rate_windows",
  {
    producerId: uuid("producer_id").notNull().references(() => producers.id),
    windowStart: ts("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.producerId, t.windowStart] })],
);

/* ───────────── intake (API-01..03, ING-01..02) ───────────── */

export const ingestEvents = pgTable(
  "ingest_events",
  {
    id: id(),
    producerId: uuid("producer_id").notNull().references(() => producers.id),
    /** Producer-assigned event ID; equals the Idempotency-Key header. */
    eventId: uuid("event_id").notNull(),
    sourceId: uuid("source_id").notNull().references(() => sources.id),
    externalId: text("external_id").notNull(),
    revision: integer("revision").notNull(),
    eventType: text("event_type").notNull(),
    /** SHA-256 of the exact request bytes: detects a byte-identical replay. */
    payloadDigest: text("payload_digest").notNull(),
    /** SHA-256 of the canonical content, excluding event_id and observed_at. */
    contentDigest: text("content_digest").notNull(),
    payload: jsonb("payload").notNull(),
    status: ingestStatus("status").notNull().default("accepted"),
    reasonCode: text("reason_code"),
    retryable: boolean("retryable").notNull().default(false),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [
    uniqueIndex("ingest_events_producer_event_uq").on(t.producerId, t.eventId),
    index("ingest_events_item_rev_idx").on(t.sourceId, t.externalId, t.revision),
    check("ingest_events_revision_ck", sql`${t.revision} > 0`),
  ],
);

export const sourceItems = pgTable(
  "source_items",
  {
    id: id(),
    sourceId: uuid("source_id").notNull().references(() => sources.id),
    externalId: text("external_id").notNull(),
    highestRevision: integer("highest_revision").notNull().default(0),
    currentRevisionId: uuid("current_revision_id"),
    status: itemStatus("status").notNull().default("active"),
    embargoUntil: ts("embargo_until"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("source_items_external_uq").on(t.sourceId, t.externalId)],
);

/** Canonical URL aliases that map to one source item (ING-02). */
export const sourceItemUrls = pgTable(
  "source_item_urls",
  {
    id: id(),
    sourceId: uuid("source_id").notNull().references(() => sources.id),
    itemId: uuid("item_id").notNull().references(() => sourceItems.id),
    normalizedUrl: text("normalized_url").notNull(),
  },
  (t) => [uniqueIndex("source_item_urls_uq").on(t.sourceId, t.normalizedUrl)],
);

export const sourceRevisions = pgTable(
  "source_revisions",
  {
    id: id(),
    itemId: uuid("item_id").notNull().references(() => sourceItems.id),
    revision: integer("revision").notNull(),
    kind: revisionKind("kind").notNull(),
    ingestEventId: uuid("ingest_event_id").notNull().references(() => ingestEvents.id),
    submittedUrl: text("submitted_url").notNull(),
    resolvedUrl: text("resolved_url"),
    declaredCanonicalUrl: text("declared_canonical_url"),
    normalizedUrl: text("normalized_url").notNull(),
    title: text("title"),
    language: text("language"),
    detectedScript: text("detected_script"),
    sourceAuthor: text("source_author"),
    excerpt: text("excerpt"),
    /** Full text, stored only when the grant in force at intake covers full text. */
    bodyText: text("body_text"),
    documentUrl: text("document_url"),
    mediaCandidates: jsonb("media_candidates"),
    sourcePublishedAt: ts("source_published_at"),
    sourcePublishedAtReason: text("source_published_at_reason"),
    sourceUpdatedAt: ts("source_updated_at"),
    observedAt: ts("observed_at").notNull(),
    checksum: text("checksum").notNull(),
    /** Normalized title fingerprint used for alias matching and cluster suggestions. */
    fingerprint: text("fingerprint"),
    adapterVersion: text("adapter_version"),
    withdrawReason: text("withdraw_reason"),
    riskRoute: riskRoute("risk_route").notNull().default("routine"),
    riskFlags: text("risk_flags").array().notNull().default(sql`'{}'::text[]`),
    holdReasons: text("hold_reasons").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("source_revisions_item_rev_uq").on(t.itemId, t.revision),
    index("source_revisions_fingerprint_idx").on(t.fingerprint),
  ],
);

export const storyClusters = pgTable("story_clusters", {
  id: id(),
  label: text("label").notNull(),
  primaryItemId: uuid("primary_item_id").references(() => sourceItems.id),
  createdAt: createdAt(),
});

export const clusterItems = pgTable(
  "cluster_items",
  {
    clusterId: uuid("cluster_id").notNull().references(() => storyClusters.id),
    itemId: uuid("item_id").notNull().references(() => sourceItems.id),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    origin: clusterOrigin("origin").notNull().default("suggested"),
    decision: clusterDecision("decision").notNull().default("pending"),
    reason: text("reason"),
    decidedBy: uuid("decided_by").references(() => people.id),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.clusterId, t.itemId] }), index("cluster_items_item_idx").on(t.itemId)],
);

/* ───────────── editorial work ───────────── */

export const articles = pgTable(
  "articles",
  {
    id: id(),
    locale: text("locale").notNull().default("en-IN"),
    slug: text("slug").notNull(),
    type: articleType("type").notNull(),
    status: articleStatus("status").notNull().default("draft"),
    riskRoute: riskRoute("risk_route").notNull().default("routine"),
    /** Optimistic lock. Every accepted write increments it; a stale write returns 409. */
    lockVersion: integer("lock_version").notNull().default(1),
    draftVersionId: uuid("draft_version_id"),
    publicVersionId: uuid("public_version_id"),
    /** First local publication time. Set once and never changed (SD-02, AT-11). */
    firstPublishedAt: ts("first_published_at"),
    /** Genuine modification time, set only by a published correction. */
    modifiedAt: ts("modified_at"),
    scheduledAt: ts("scheduled_at"),
    scheduledVersionId: uuid("scheduled_version_id"),
    embargoUntil: ts("embargo_until"),
    /** Licensed copies: the item and the exact grant the copy relies on. */
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id),
    grantId: uuid("grant_id").references(() => sourceGrants.id),
    isIndexable: boolean("is_indexable").notNull().default(false),
    /**
     * Verbatim republication of an official release: the original's address.
     * The page names it as canonical and stays out of our sitemaps (publisher decision, 20 Nov 2026).
     */
    canonicalUrl: text("canonical_url"),
    /** Editorial importance for the homepage lead (WEB-01). Higher wins; null means not a lead candidate. */
    /** Released by source automation rather than a named editor (PUB table, licensed republication). */
    autoPublished: boolean("auto_published").notNull().default(false),
    leadRank: integer("lead_rank"),
    leadUntil: ts("lead_until"),
    createdBy: uuid("created_by").references(() => people.id),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("articles_locale_slug_uq").on(t.locale, t.slug),
    index("articles_published_idx").on(t.firstPublishedAt, t.id).where(sql`${t.publicVersionId} is not null`),
    index("articles_schedule_idx").on(t.scheduledAt).where(sql`${t.status} = 'scheduled'`),
    check(
      "articles_licensed_ck",
      sql`${t.type} <> 'licensed_copy' or (${t.sourceItemId} is not null and ${t.grantId} is not null)`,
    ),
  ],
);

/** Immutable editorial revisions. UPDATE and DELETE are rejected by trigger. */
export const articleVersions = pgTable(
  "article_versions",
  {
    id: id(),
    articleId: uuid("article_id").notNull().references(() => articles.id),
    version: integer("version").notNull(),
    headline: text("headline").notNull(),
    standfirst: text("standfirst").notNull().default(""),
    /** Structured body: array of allowlisted content blocks. */
    body: jsonb("body").notNull(),
    bodyText: text("body_text").notNull().default(""),
    language: text("language").notNull().default("en"),
    authorPersonId: uuid("author_person_id").references(() => people.id),
    deskId: uuid("desk_id").references(() => desks.id),
    /** Licensed copies carry the original author and publisher as labels. */
    sourceAuthorLabel: text("source_author_label"),
    contribution: contributionType("contribution"),
    contributionNote: text("contribution_note"),
    correctionNote: text("correction_note"),
    /** Cleared lead image. Null means a text-led layout. */
    leadAssetId: uuid("lead_asset_id"),
    assistModel: text("assist_model"),
    /** Hash of the fields that count as a material edit. */
    contentHash: text("content_hash").notNull(),
    /** Headline ranks above standfirst, which ranks above body (WEB-04). */
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', headline), 'A') || setweight(to_tsvector('english', standfirst), 'B') || setweight(to_tsvector('english', body_text), 'C')`,
    ),
    createdBy: uuid("created_by").references(() => people.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("article_versions_uq").on(t.articleId, t.version), index("article_versions_search_idx").using("gin", t.searchTsv)],
);

export const articleCitations = pgTable(
  "article_citations",
  {
    id: id(),
    versionId: uuid("version_id").notNull().references(() => articleVersions.id),
    position: integer("position").notNull(),
    sourceRevisionId: uuid("source_revision_id").references(() => sourceRevisions.id),
    url: text("url").notNull(),
    label: text("label").notNull(),
    publisherName: text("publisher_name").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [
    uniqueIndex("article_citations_pos_uq").on(t.versionId, t.position),
    index("article_citations_rev_idx").on(t.sourceRevisionId),
    check("article_citations_https_ck", sql`${t.url} like 'https://%'`),
  ],
);

export const articleTerms = pgTable(
  "article_terms",
  {
    articleId: uuid("article_id").notNull().references(() => articles.id),
    termId: uuid("term_id").notNull().references(() => terms.id),
    isPrimarySection: boolean("is_primary_section").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.articleId, t.termId] }),
    uniqueIndex("article_terms_primary_uq").on(t.articleId).where(sql`${t.isPrimarySection}`),
    index("article_terms_term_idx").on(t.termId),
  ],
);

/** Sign-offs are bound to an exact version and reviewer role (ED-04). */
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    articleId: uuid("article_id").notNull().references(() => articles.id),
    versionId: uuid("version_id").notNull().references(() => articleVersions.id),
    kind: approvalKind("kind").notNull(),
    decision: approvalDecision("decision").notNull(),
    reviewerPersonId: uuid("reviewer_person_id").notNull().references(() => people.id),
    specialty: text("specialty"),
    evidence: text("evidence"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("approvals_version_kind_uq").on(t.versionId, t.kind).where(sql`${t.decision} = 'approved'`),
  ],
);

export const mediaAssets = pgTable("media_assets", {
  id: id(),
  ownerName: text("owner_name").notNull(),
  grantId: uuid("grant_id").references(() => sourceGrants.id),
  storageKey: text("storage_key").notNull(),
  credit: text("credit").notNull(),
  altText: text("alt_text").notNull(),
  channels: text("channels").array().notNull().default(sql`'{}'::text[]`),
  expiresAt: ts("expires_at"),
  withdrawnAt: ts("withdrawn_at"),
  createdAt: createdAt(),
});

export const assetVariants = pgTable(
  "asset_variants",
  {
    id: id(),
    assetId: uuid("asset_id").notNull().references(() => mediaAssets.id),
    rendition: text("rendition").notNull(),
    storageKey: text("storage_key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
  },
  (t) => [uniqueIndex("asset_variants_uq").on(t.assetId, t.rendition)],
);

/* ───────────── public feed ───────────── */

/**
 * One row per public appearance. Points to exactly one source revision
 * (external source card) or one local article. One active entry per public identity.
 */
export const feedEntries = pgTable(
  "feed_entries",
  {
    id: id(),
    kind: feedKind("kind").notNull(),
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id),
    sourceRevisionId: uuid("source_revision_id").references(() => sourceRevisions.id),
    articleId: uuid("article_id").references(() => articles.id),
    displayTitle: text("display_title").notNull(),
    publisherName: text("publisher_name").notNull(),
    targetUrl: text("target_url").notNull(),
    visibleFrom: ts("visible_from").notNull(),
    /** Channels this entry may be distributed on, derived from the grant. */
    scope: text("scope").array().notNull().default(sql`'{web}'::text[]`),
    grantId: uuid("grant_id").references(() => sourceGrants.id),
    status: feedStatus("status").notNull().default("active"),
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', display_title), 'A') || setweight(to_tsvector('english', publisher_name), 'B')`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    index("feed_entries_search_idx").using("gin", t.searchTsv),
    check(
      "feed_entries_target_ck",
      sql`(${t.kind} = 'source_card' and ${t.sourceItemId} is not null and ${t.sourceRevisionId} is not null and ${t.articleId} is null)
       or (${t.kind} = 'article' and ${t.articleId} is not null and ${t.sourceRevisionId} is null and ${t.sourceItemId} is null)`,
    ),
    uniqueIndex("feed_entries_active_item_uq").on(t.sourceItemId).where(sql`${t.status} = 'active' and ${t.kind} = 'source_card'`),
    uniqueIndex("feed_entries_active_article_uq").on(t.articleId).where(sql`${t.status} = 'active' and ${t.kind} = 'article'`),
    index("feed_entries_latest_idx").on(t.visibleFrom, t.id).where(sql`${t.status} = 'active'`),
  ],
);

/* ───────────── jobs, outbox, suppression ───────────── */

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    /** Isolation unit. One failing source queue does not block the others (ING-04). */
    queue: text("queue").notNull(),
    kind: text("kind").notNull(),
    /** Business key. Replays reuse it, so they cannot create duplicates. */
    key: text("key").notNull().unique(),
    payload: jsonb("payload").notNull(),
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: ts("run_at").notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: ts("lease_expires_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("jobs_claim_idx").on(t.runAt).where(sql`${t.status} in ('queued','running')`)],
);

export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    /** Monotonic per aggregate. A consumer drops outdated versions (DB-03). */
    aggregateVersion: integer("aggregate_version").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
    processedAt: ts("processed_at"),
  },
  (t) => [
    index("outbox_pending_idx").on(t.createdAt).where(sql`${t.processedAt} is null`),
    uniqueIndex("outbox_aggregate_version_uq").on(t.aggregateType, t.aggregateId, t.aggregateVersion),
  ],
);

export const deliveries = pgTable(
  "deliveries",
  {
    id: id(),
    outboxId: uuid("outbox_id").notNull().references(() => outbox.id),
    target: text("target").notNull(),
    state: deliveryState("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    detail: text("detail"),
    deliveredAt: ts("delivered_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("deliveries_event_target_uq").on(t.outboxId, t.target)],
);

/** Tombstones. An active suppression always wins over stale work. */
export const suppressions = pgTable(
  "suppressions",
  {
    id: id(),
    subjectType: suppressionSubject("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    kind: suppressionKind("kind").notNull(),
    reason: text("reason").notNull(),
    publicNote: text("public_note"),
    decidedBy: uuid("decided_by").references(() => people.id),
    createdAt: createdAt(),
    liftedAt: ts("lifted_at"),
    liftedReason: text("lifted_reason"),
  },
  (t) => [index("suppressions_subject_idx").on(t.subjectType, t.subjectId).where(sql`${t.liftedAt} is null`)],
);

/* ───────────── newsroom work, cases, redirects, audit ───────────── */

export const editorialTasks = pgTable(
  "editorial_tasks",
  {
    id: id(),
    kind: text("kind").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    detail: text("detail").notNull(),
    status: taskStatus("status").notNull().default("open"),
    assigneeId: uuid("assignee_id").references(() => people.id),
    dueAt: ts("due_at"),
    createdAt: createdAt(),
    closedAt: ts("closed_at"),
  },
  (t) => [index("editorial_tasks_open_idx").on(t.kind, t.createdAt).where(sql`${t.status} = 'open'`)],
);

export const cases = pgTable("cases", {
  id: id(),
  caseNumber: text("case_number").notNull().unique(),
  reason: text("reason").notNull(),
  articleId: uuid("article_id").references(() => articles.id),
  description: text("description").notNull(),
  /** Private. Never rendered publicly, logged or sent to analytics (SEC-03). */
  reporterContact: text("reporter_contact"),
  isUrgent: boolean("is_urgent").notNull().default(false),
  ownerId: uuid("owner_id").references(() => people.id),
  status: caseStatus("status").notNull().default("open"),
  decision: text("decision"),
  response: text("response"),
  createdAt: createdAt(),
  resolvedAt: ts("resolved_at"),
});

/** Former slugs. The target is an article, so every redirect is a single hop. */
export const redirects = pgTable(
  "redirects",
  {
    id: id(),
    locale: text("locale").notNull().default("en-IN"),
    fromSlug: text("from_slug").notNull(),
    articleId: uuid("article_id").notNull().references(() => articles.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("redirects_from_uq").on(t.locale, t.fromSlug)],
);

/** Append-only. UPDATE and DELETE are rejected by trigger. */
export const auditEntries = pgTable(
  "audit_entries",
  {
    id: id(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    reason: text("reason"),
    diff: jsonb("diff"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_entries_subject_idx").on(t.subjectType, t.subjectId, t.createdAt)],
);

/** Idempotency record for staff state changes (ADM-02). */
export const commandLog = pgTable("command_log", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  actorId: uuid("actor_id").notNull().references(() => people.id),
  articleId: uuid("article_id").notNull().references(() => articles.id),
  action: text("action").notNull(),
  result: jsonb("result").notNull(),
  createdAt: createdAt(),
});

/* ───────────── reader site (phase 2) ───────────── */

/** Configurable breaking strip: needs an owner, an expiry and a verified story link (WEB-01). */
export const breakingStrips = pgTable("breaking_strips", {
  id: id(),
  text: text("text").notNull(),
  articleId: uuid("article_id").notNull().references(() => articles.id),
  ownerPersonId: uuid("owner_person_id").notNull().references(() => people.id),
  startsAt: ts("starts_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

/** Spelling and renamed-place equivalents applied to search queries, e.g. Bangalore and Bengaluru (WEB-02). */
export const searchSynonyms = pgTable(
  "search_synonyms",
  {
    term: text("term").notNull(),
    synonym: text("synonym").notNull(),
  },
  (t) => [primaryKey({ columns: [t.term, t.synonym] }), check("search_synonyms_lower_ck", sql`${t.term} = lower(${t.term}) and ${t.synonym} = lower(${t.synonym})`)],
);

/* ───────────── staff sign-in (phase 3, SEC-02, ADM-01) ───────────── */

export const staffCredentials = pgTable("staff_credentials", {
  personId: uuid("person_id").primaryKey().references(() => people.id),
  passwordHash: text("password_hash"),
  /** TOTP secret, encrypted at rest. Sign-in is refused until it is confirmed. */
  totpSecretEnc: text("totp_secret_enc"),
  totpConfirmedAt: ts("totp_confirmed_at"),
  /** Last accepted time step, so a code cannot be replayed. */
  lastTotpStep: integer("last_totp_step").notNull().default(0),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: ts("locked_until"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const staffSessions = pgTable(
  "staff_sessions",
  {
    id: id(),
    personId: uuid("person_id").notNull().references(() => people.id),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("staff_sessions_person_idx").on(t.personId)],
);

export const staffInvites = pgTable("staff_invites", {
  id: id(),
  personId: uuid("person_id").notNull().references(() => people.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdBy: uuid("created_by").references(() => people.id),
  createdAt: createdAt(),
});

/** Fixed-window counters for sign-in attempts and reader reports. */
export const rateWindows = pgTable(
  "rate_windows",
  {
    bucket: text("bucket").notNull(),
    windowStart: ts("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] })],
);

/* ───────────── publisher settings and policy pages (GOV-01, GOV-02) ───────────── */

/** Publisher facts: legal name, contacts, grievance officer. Changes are audited. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: uuid("updated_by").references(() => people.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Versioned policy documents, so staff can show which policy applied on a given date. */
export const sitePages = pgTable(
  "site_pages",
  {
    id: id(),
    slug: text("slug").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    body: jsonb("body").notNull(),
    /** Set once a qualified person has reviewed this version. Unreviewed pages stay out of the index. */
    reviewedBy: text("reviewed_by"),
    changeNote: text("change_note"),
    createdBy: uuid("created_by").references(() => people.id),
    effectiveAt: ts("effective_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("site_pages_slug_version_uq").on(t.slug, t.version)],
);

/** Verification record for a cited link (COR-02). Citations themselves are immutable. */
export const linkChecks = pgTable(
  "link_checks",
  {
    id: id(),
    url: text("url").notNull(),
    status: text("status").notNull(),
    replacementUrl: text("replacement_url"),
    note: text("note"),
    checkedBy: uuid("checked_by").references(() => people.id),
    createdAt: createdAt(),
  },
  (t) => [index("link_checks_url_idx").on(t.url, t.createdAt), check("link_checks_status_ck", sql`${t.status} in ('reported_broken', 'broken', 'replaced', 'ok')`)],
);
