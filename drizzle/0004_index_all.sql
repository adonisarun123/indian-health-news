-- Publisher decision, 19 Nov 2026: every published story page is indexable,
-- including partner copies and press material. A licensed copy still needs its
-- source item and grant; it no longer has to be noindex.
ALTER TABLE "articles" DROP CONSTRAINT "articles_licensed_ck";--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_licensed_ck" CHECK ("articles"."type" <> 'licensed_copy' or ("articles"."source_item_id" is not null and "articles"."grant_id" is not null));--> statement-breakpoint
UPDATE "articles" SET "is_indexable" = true WHERE "status" = 'published' AND "public_version_id" IS NOT NULL;
