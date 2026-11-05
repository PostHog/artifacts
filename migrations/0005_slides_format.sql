-- Adds the 'slides' format: HTML in which each <section> in <body> is a slide.
-- SQLite can't alter a CHECK constraint, so versions is rebuilt. No table references versions,
-- so dropping it cascades nothing (unlike artifacts, see 0002).

CREATE TABLE versions_new (
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('html', 'slides', 'markdown')),
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, version)
);
INSERT INTO versions_new (artifact_id, version, format, size, sha256, object_key, note, created_at)
  SELECT artifact_id, version, format, size, sha256, object_key, note, created_at FROM versions;
DROP TABLE versions;
ALTER TABLE versions_new RENAME TO versions;
