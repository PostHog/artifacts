ALTER TABLE artifacts ADD COLUMN folder TEXT COLLATE NOCASE;
CREATE INDEX idx_artifacts_owner_folder ON artifacts (owner_email, folder, updated_at DESC);
