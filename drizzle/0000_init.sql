CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'returned');--> statement-breakpoint
CREATE TYPE "public"."approval_kind" AS ENUM('editorial', 'medical');--> statement-breakpoint
CREATE TYPE "public"."article_status" AS ENUM('draft', 'in_review', 'approved', 'scheduled', 'published', 'retracted', 'removed');--> statement-breakpoint
CREATE TYPE "public"."article_type" AS ENUM('original_brief', 'original_report', 'analysis', 'press_material', 'licensed_copy');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('open', 'in_progress', 'resolved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."cluster_decision" AS ENUM('pending', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."cluster_origin" AS ENUM('suggested', 'human');--> statement-breakpoint
CREATE TYPE "public"."contribution_type" AS ENUM('prior_notice_comparison', 'on_record_interview', 'local_reporting', 'dataset_analysis');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('pending', 'delivered', 'dropped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."feed_kind" AS ENUM('source_card', 'article');--> statement-breakpoint
CREATE TYPE "public"."feed_status" AS ENUM('active', 'replaced', 'withdrawn', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."grant_basis" AS ENUM('unknown', 'link_only', 'public_terms', 'written_permission', 'licence', 'fair_dealing_reviewed');--> statement-breakpoint
CREATE TYPE "public"."ingest_status" AS ENUM('accepted', 'processing', 'held', 'applied', 'superseded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."item_status" AS ENUM('active', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'dead');--> statement-breakpoint
CREATE TYPE "public"."person_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."public_format" AS ENUM('source_card', 'licensed_copy');--> statement-breakpoint
CREATE TYPE "public"."revision_kind" AS ENUM('upsert', 'withdraw');--> statement-breakpoint
CREATE TYPE "public"."risk_route" AS ENUM('routine', 'clinical', 'sensitive');--> statement-breakpoint
CREATE TYPE "public"."source_family" AS ENUM('national_authority', 'state_local', 'research_professional', 'independent_commercial');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('proposed', 'under_review', 'enabled', 'paused', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('source_operator', 'reporter', 'medical_reviewer', 'editor', 'managing_editor', 'administrator', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."suppression_kind" AS ENUM('retraction', 'removal_410', 'removal_451', 'rights_expiry', 'rights_revocation', 'source_withdrawal', 'risk_hold');--> statement-breakpoint
CREATE TYPE "public"."suppression_subject" AS ENUM('article', 'source_item', 'asset', 'source');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'done', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."term_kind" AS ENUM('section', 'state', 'topic');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"kind" "approval_kind" NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"reviewer_person_id" uuid NOT NULL,
	"specialty" text,
	"evidence" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"source_revision_id" uuid,
	"url" text NOT NULL,
	"label" text NOT NULL,
	"publisher_name" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "article_citations_https_ck" CHECK ("article_citations"."url" like 'https://%')
);
--> statement-breakpoint
CREATE TABLE "article_terms" (
	"article_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"is_primary_section" boolean DEFAULT false NOT NULL,
	CONSTRAINT "article_terms_article_id_term_id_pk" PRIMARY KEY("article_id","term_id")
);
--> statement-breakpoint
CREATE TABLE "article_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"headline" text NOT NULL,
	"standfirst" text DEFAULT '' NOT NULL,
	"body" jsonb NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"author_person_id" uuid,
	"desk_id" uuid,
	"source_author_label" text,
	"contribution" "contribution_type",
	"contribution_note" text,
	"correction_note" text,
	"lead_asset_id" uuid,
	"assist_model" text,
	"content_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"locale" text DEFAULT 'en-IN' NOT NULL,
	"slug" text NOT NULL,
	"type" "article_type" NOT NULL,
	"status" "article_status" DEFAULT 'draft' NOT NULL,
	"risk_route" "risk_route" DEFAULT 'routine' NOT NULL,
	"lock_version" integer DEFAULT 1 NOT NULL,
	"draft_version_id" uuid,
	"public_version_id" uuid,
	"first_published_at" timestamp with time zone,
	"modified_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"scheduled_version_id" uuid,
	"embargo_until" timestamp with time zone,
	"source_item_id" uuid,
	"grant_id" uuid,
	"is_indexable" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "articles_licensed_ck" CHECK ("articles"."type" <> 'licensed_copy' or ("articles"."source_item_id" is not null and "articles"."grant_id" is not null and "articles"."is_indexable" = false))
);
--> statement-breakpoint
CREATE TABLE "asset_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"rendition" text NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"reason" text,
	"diff" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_number" text NOT NULL,
	"reason" text NOT NULL,
	"article_id" uuid,
	"description" text NOT NULL,
	"reporter_contact" text,
	"is_urgent" boolean DEFAULT false NOT NULL,
	"owner_id" uuid,
	"status" "case_status" DEFAULT 'open' NOT NULL,
	"decision" text,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "cases_case_number_unique" UNIQUE("case_number")
);
--> statement-breakpoint
CREATE TABLE "cluster_items" (
	"cluster_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"origin" "cluster_origin" DEFAULT 'suggested' NOT NULL,
	"decision" "cluster_decision" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cluster_items_cluster_id_item_id_pk" PRIMARY KEY("cluster_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "command_log" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"action" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_id" uuid NOT NULL,
	"target" text NOT NULL,
	"state" "delivery_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "desks_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "editorial_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"detail" text NOT NULL,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"assignee_id" uuid,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "feed_kind" NOT NULL,
	"source_item_id" uuid,
	"source_revision_id" uuid,
	"article_id" uuid,
	"display_title" text NOT NULL,
	"publisher_name" text NOT NULL,
	"target_url" text NOT NULL,
	"visible_from" timestamp with time zone NOT NULL,
	"scope" text[] DEFAULT '{web}'::text[] NOT NULL,
	"grant_id" uuid,
	"status" "feed_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_entries_target_ck" CHECK (("feed_entries"."kind" = 'source_card' and "feed_entries"."source_item_id" is not null and "feed_entries"."source_revision_id" is not null and "feed_entries"."article_id" is null)
       or ("feed_entries"."kind" = 'article' and "feed_entries"."article_id" is not null and "feed_entries"."source_revision_id" is null and "feed_entries"."source_item_id" is null))
);
--> statement-breakpoint
CREATE TABLE "ingest_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producer_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"revision" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload_digest" text NOT NULL,
	"content_digest" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "ingest_status" DEFAULT 'accepted' NOT NULL,
	"reason_code" text,
	"retryable" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "ingest_events_revision_ck" CHECK ("ingest_events"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_name" text NOT NULL,
	"grant_id" uuid,
	"storage_key" text NOT NULL,
	"credit" text NOT NULL,
	"alt_text" text NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "staff_role" NOT NULL,
	"desk_id" uuid,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"bio" text,
	"credentials" text,
	"conflicts" text,
	"has_public_profile" boolean DEFAULT false NOT NULL,
	"status" "person_status" DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_slug_unique" UNIQUE("slug"),
	CONSTRAINT "people_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "producer_rate_windows" (
	"producer_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "producer_rate_windows_producer_id_window_start_pk" PRIMARY KEY("producer_id","window_start")
);
--> statement-breakpoint
CREATE TABLE "producer_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producer_id" uuid NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "producer_sources" (
	"producer_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "producer_sources_producer_id_source_id_pk" PRIMARY KEY("producer_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "producers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"rate_per_minute" integer DEFAULT 600 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "producers_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
CREATE TABLE "redirects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"locale" text DEFAULT 'en-IN' NOT NULL,
	"from_slug" text NOT NULL,
	"article_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"specialty" text NOT NULL,
	"evidence_uri" text NOT NULL,
	"conflicts" text,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_automation" (
	"source_id" uuid NOT NULL,
	"format" "public_format" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_automation_source_id_format_pk" PRIMARY KEY("source_id","format")
);
--> statement-breakpoint
CREATE TABLE "source_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"basis" "grant_basis" DEFAULT 'unknown' NOT NULL,
	"evidence_uri" text,
	"terms_url" text,
	"allow_headline" boolean DEFAULT false NOT NULL,
	"allow_excerpt" boolean DEFAULT false NOT NULL,
	"excerpt_max_chars" integer DEFAULT 0 NOT NULL,
	"allow_full_text" boolean DEFAULT false NOT NULL,
	"allow_images" boolean DEFAULT false NOT NULL,
	"allow_translation" boolean DEFAULT false NOT NULL,
	"allow_caching" boolean DEFAULT false NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"territory" text DEFAULT 'IN' NOT NULL,
	"attribution_text" text,
	"embargo_rule" text,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"review_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"host" text NOT NULL,
	"path_prefix" text DEFAULT '/' NOT NULL,
	CONSTRAINT "source_hosts_lower_ck" CHECK ("source_hosts"."host" = lower("source_hosts"."host"))
);
--> statement-breakpoint
CREATE TABLE "source_item_urls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"normalized_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"highest_revision" integer DEFAULT 0 NOT NULL,
	"current_revision_id" uuid,
	"status" "item_status" DEFAULT 'active' NOT NULL,
	"embargo_until" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" "revision_kind" NOT NULL,
	"ingest_event_id" uuid NOT NULL,
	"submitted_url" text NOT NULL,
	"resolved_url" text,
	"declared_canonical_url" text,
	"normalized_url" text NOT NULL,
	"title" text,
	"language" text,
	"detected_script" text,
	"source_author" text,
	"excerpt" text,
	"document_url" text,
	"media_candidates" jsonb,
	"source_published_at" timestamp with time zone,
	"source_published_at_reason" text,
	"source_updated_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"checksum" text NOT NULL,
	"fingerprint" text,
	"adapter_version" text,
	"withdraw_reason" text,
	"risk_route" "risk_route" DEFAULT 'routine' NOT NULL,
	"risk_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"hold_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"neutral_label" text,
	"homepage_url" text NOT NULL,
	"discovery_endpoint" text,
	"adapter" text,
	"language" text DEFAULT 'en' NOT NULL,
	"family" "source_family" NOT NULL,
	"jurisdiction_term_id" uuid,
	"contact" text,
	"feed_cadence_seconds" integer,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"min_interval_ms" integer DEFAULT 5000 NOT NULL,
	"owner_person_id" uuid,
	"trust_tier" integer DEFAULT 3 NOT NULL,
	"default_risk_route" "risk_route" DEFAULT 'routine' NOT NULL,
	"status" "source_status" DEFAULT 'proposed' NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"next_poll_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "story_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"primary_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "suppression_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" "suppression_kind" NOT NULL,
	"reason" text NOT NULL,
	"public_note" text,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_reason" text
);
--> statement-breakpoint
CREATE TABLE "term_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" uuid NOT NULL,
	"alias" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "term_kind" NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"intro" text,
	"is_hub_approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_version_id_article_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."article_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_reviewer_person_id_people_id_fk" FOREIGN KEY ("reviewer_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_citations" ADD CONSTRAINT "article_citations_version_id_article_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."article_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_citations" ADD CONSTRAINT "article_citations_source_revision_id_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."source_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_terms" ADD CONSTRAINT "article_terms_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_terms" ADD CONSTRAINT "article_terms_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_author_person_id_people_id_fk" FOREIGN KEY ("author_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_desk_id_desks_id_fk" FOREIGN KEY ("desk_id") REFERENCES "public"."desks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_grant_id_source_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."source_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_variants" ADD CONSTRAINT "asset_variants_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_owner_id_people_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_items" ADD CONSTRAINT "cluster_items_cluster_id_story_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."story_clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_items" ADD CONSTRAINT "cluster_items_item_id_source_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_items" ADD CONSTRAINT "cluster_items_decided_by_people_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_log" ADD CONSTRAINT "command_log_actor_id_people_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_log" ADD CONSTRAINT "command_log_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_outbox_id_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_tasks" ADD CONSTRAINT "editorial_tasks_assignee_id_people_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_source_revision_id_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."source_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_grant_id_source_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."source_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_events" ADD CONSTRAINT "ingest_events_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_events" ADD CONSTRAINT "ingest_events_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_grant_id_source_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."source_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_desk_id_desks_id_fk" FOREIGN KEY ("desk_id") REFERENCES "public"."desks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_granted_by_people_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producer_rate_windows" ADD CONSTRAINT "producer_rate_windows_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producer_secrets" ADD CONSTRAINT "producer_secrets_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producer_sources" ADD CONSTRAINT "producer_sources_producer_id_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."producers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producer_sources" ADD CONSTRAINT "producer_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_credentials" ADD CONSTRAINT "reviewer_credentials_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_credentials" ADD CONSTRAINT "reviewer_credentials_verified_by_people_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_automation" ADD CONSTRAINT "source_automation_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_automation" ADD CONSTRAINT "source_automation_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_grants" ADD CONSTRAINT "source_grants_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_grants" ADD CONSTRAINT "source_grants_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_hosts" ADD CONSTRAINT "source_hosts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_urls" ADD CONSTRAINT "source_item_urls_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_item_urls" ADD CONSTRAINT "source_item_urls_item_id_source_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_item_id_source_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_ingest_event_id_ingest_events_id_fk" FOREIGN KEY ("ingest_event_id") REFERENCES "public"."ingest_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_jurisdiction_term_id_terms_id_fk" FOREIGN KEY ("jurisdiction_term_id") REFERENCES "public"."terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_clusters" ADD CONSTRAINT "story_clusters_primary_item_id_source_items_id_fk" FOREIGN KEY ("primary_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_decided_by_people_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_aliases" ADD CONSTRAINT "term_aliases_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_version_kind_uq" ON "approvals" USING btree ("version_id","kind") WHERE "approvals"."decision" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "article_citations_pos_uq" ON "article_citations" USING btree ("version_id","position");--> statement-breakpoint
CREATE INDEX "article_citations_rev_idx" ON "article_citations" USING btree ("source_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "article_terms_primary_uq" ON "article_terms" USING btree ("article_id") WHERE "article_terms"."is_primary_section";--> statement-breakpoint
CREATE INDEX "article_terms_term_idx" ON "article_terms" USING btree ("term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "article_versions_uq" ON "article_versions" USING btree ("article_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_locale_slug_uq" ON "articles" USING btree ("locale","slug");--> statement-breakpoint
CREATE INDEX "articles_published_idx" ON "articles" USING btree ("first_published_at","id") WHERE "articles"."public_version_id" is not null;--> statement-breakpoint
CREATE INDEX "articles_schedule_idx" ON "articles" USING btree ("scheduled_at") WHERE "articles"."status" = 'scheduled';--> statement-breakpoint
CREATE UNIQUE INDEX "asset_variants_uq" ON "asset_variants" USING btree ("asset_id","rendition");--> statement-breakpoint
CREATE INDEX "audit_entries_subject_idx" ON "audit_entries" USING btree ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "cluster_items_item_idx" ON "cluster_items" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_event_target_uq" ON "deliveries" USING btree ("outbox_id","target");--> statement-breakpoint
CREATE INDEX "editorial_tasks_open_idx" ON "editorial_tasks" USING btree ("kind","created_at") WHERE "editorial_tasks"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "feed_entries_active_item_uq" ON "feed_entries" USING btree ("source_item_id") WHERE "feed_entries"."status" = 'active' and "feed_entries"."kind" = 'source_card';--> statement-breakpoint
CREATE UNIQUE INDEX "feed_entries_active_article_uq" ON "feed_entries" USING btree ("article_id") WHERE "feed_entries"."status" = 'active' and "feed_entries"."kind" = 'article';--> statement-breakpoint
CREATE INDEX "feed_entries_latest_idx" ON "feed_entries" USING btree ("visible_from","id") WHERE "feed_entries"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_events_producer_event_uq" ON "ingest_events" USING btree ("producer_id","event_id");--> statement-breakpoint
CREATE INDEX "ingest_events_item_rev_idx" ON "ingest_events" USING btree ("source_id","external_id","revision");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."status" in ('queued','running');--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_active_uq" ON "memberships" USING btree ("person_id","role") WHERE "memberships"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_aggregate_version_uq" ON "outbox" USING btree ("aggregate_type","aggregate_id","aggregate_version");--> statement-breakpoint
CREATE UNIQUE INDEX "redirects_from_uq" ON "redirects" USING btree ("locale","from_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "source_grants_version_uq" ON "source_grants" USING btree ("source_id","version");--> statement-breakpoint
CREATE INDEX "source_grants_expiry_idx" ON "source_grants" USING btree ("expires_at") WHERE "source_grants"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "source_hosts_uq" ON "source_hosts" USING btree ("source_id","host","path_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "source_item_urls_uq" ON "source_item_urls" USING btree ("source_id","normalized_url");--> statement-breakpoint
CREATE UNIQUE INDEX "source_items_external_uq" ON "source_items" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_revisions_item_rev_uq" ON "source_revisions" USING btree ("item_id","revision");--> statement-breakpoint
CREATE INDEX "source_revisions_fingerprint_idx" ON "source_revisions" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "sources_status_poll_idx" ON "sources" USING btree ("status","next_poll_at");--> statement-breakpoint
CREATE INDEX "suppressions_subject_idx" ON "suppressions" USING btree ("subject_type","subject_id") WHERE "suppressions"."lifted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "term_aliases_alias_uq" ON "term_aliases" USING btree (lower("alias"));--> statement-breakpoint
CREATE UNIQUE INDEX "terms_kind_slug_uq" ON "terms" USING btree ("kind","slug");