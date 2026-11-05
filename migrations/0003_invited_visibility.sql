-- Adds 'invited' visibility: people on a per-artifact email allowlist can view the latest version
-- after proving they own the address with a one-time code. Allowlist entries are exact emails or '@domain'.
-- SQLite can't alter a CHECK constraint, so the artifacts table is rebuilt exactly as in 0002.

CREATE TABLE artifacts_new (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  owner_name TEXT,
  title TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team', 'invited', 'public')),
  latest_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO artifacts_new (id, owner_email, owner_name, title, description, visibility, latest_version, created_at, updated_at)
  SELECT id, owner_email, owner_name, title, description, visibility, latest_version, created_at, updated_at FROM artifacts;

CREATE TABLE versions_parked (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  format TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO versions_parked SELECT artifact_id, version, format, size, sha256, object_key, note, created_at FROM versions;
DROP TABLE versions;
DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;
CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts (owner_email, updated_at DESC);

CREATE TABLE versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('html', 'markdown')),
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, version)
);
INSERT INTO versions (artifact_id, version, format, size, sha256, object_key, note, created_at)
  SELECT artifact_id, version, format, size, sha256, object_key, note, created_at FROM versions_parked;
DROP TABLE versions_parked;

CREATE TABLE artifact_invites (
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, pattern)
);
