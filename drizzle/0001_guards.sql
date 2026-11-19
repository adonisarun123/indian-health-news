-- Guards that Drizzle cannot express: immutability, append-only audit,
-- circular foreign keys and the fixed first-publication time.

CREATE FUNCTION ihn_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER article_versions_immutable BEFORE UPDATE OR DELETE ON article_versions
  FOR EACH ROW EXECUTE FUNCTION ihn_reject_change();
--> statement-breakpoint
CREATE TRIGGER article_citations_immutable BEFORE UPDATE OR DELETE ON article_citations
  FOR EACH ROW EXECUTE FUNCTION ihn_reject_change();
--> statement-breakpoint
CREATE TRIGGER approvals_immutable BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION ihn_reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_entries_append_only BEFORE UPDATE OR DELETE ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION ihn_reject_change();
--> statement-breakpoint
CREATE FUNCTION ihn_keep_first_published() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_published_at IS NOT NULL AND NEW.first_published_at IS DISTINCT FROM OLD.first_published_at THEN
    RAISE EXCEPTION 'first_published_at is fixed once set' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER articles_keep_first_published BEFORE UPDATE ON articles
  FOR EACH ROW EXECUTE FUNCTION ihn_keep_first_published();
--> statement-breakpoint
ALTER TABLE source_items ADD CONSTRAINT source_items_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES source_revisions(id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE articles ADD CONSTRAINT articles_draft_version_fk
  FOREIGN KEY (draft_version_id) REFERENCES article_versions(id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE articles ADD CONSTRAINT articles_public_version_fk
  FOREIGN KEY (public_version_id) REFERENCES article_versions(id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE articles ADD CONSTRAINT articles_scheduled_version_fk
  FOREIGN KEY (scheduled_version_id) REFERENCES article_versions(id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
INSERT INTO feature_flags (key, enabled) VALUES
  ('auto_publish', true),
  ('source_cards', true),
  ('licensed_feeds', false),
  ('indexing', false)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
ALTER TABLE article_versions ADD CONSTRAINT article_versions_lead_asset_fk
  FOREIGN KEY (lead_asset_id) REFERENCES media_assets(id);
