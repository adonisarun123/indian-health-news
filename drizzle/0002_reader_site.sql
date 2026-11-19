CREATE TABLE "breaking_strips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text NOT NULL,
	"article_id" uuid NOT NULL,
	"owner_person_id" uuid NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_synonyms" (
	"term" text NOT NULL,
	"synonym" text NOT NULL,
	CONSTRAINT "search_synonyms_term_synonym_pk" PRIMARY KEY("term","synonym"),
	CONSTRAINT "search_synonyms_lower_ck" CHECK ("search_synonyms"."term" = lower("search_synonyms"."term") and "search_synonyms"."synonym" = lower("search_synonyms"."synonym"))
);
--> statement-breakpoint
ALTER TABLE "article_versions" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', headline), 'A') || setweight(to_tsvector('english', standfirst), 'B') || setweight(to_tsvector('english', body_text), 'C')) STORED;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "lead_rank" integer;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "lead_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', display_title), 'A') || setweight(to_tsvector('english', publisher_name), 'B')) STORED;--> statement-breakpoint
ALTER TABLE "breaking_strips" ADD CONSTRAINT "breaking_strips_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breaking_strips" ADD CONSTRAINT "breaking_strips_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_versions_search_idx" ON "article_versions" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "feed_entries_search_idx" ON "feed_entries" USING gin ("search_tsv");