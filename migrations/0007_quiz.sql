-- Adds the 'quiz' format and the attempts people make at one.
-- SQLite can't alter a CHECK constraint, so versions is rebuilt, the same way 0005 did it. No table references
-- versions, so dropping it cascades nothing.

CREATE TABLE versions_new (
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('html', 'slides', 'markdown', 'quiz')),
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

-- One row per submission. The answers are kept so the owner can see which options people picked.
-- taker_id is the lowercased email for staff and guests, and the anonymous browser ID for signed-out takers.
-- preview is 1 for the owner trying their own quiz: shown the score, but never counted or limited.
CREATE TABLE quiz_attempts (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  taker_kind TEXT NOT NULL CHECK (taker_kind IN ('staff', 'guest', 'anonymous')),
  taker_id TEXT NOT NULL,
  taker_name TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  points INTEGER NOT NULL,
  max_points INTEGER NOT NULL,
  percent INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  answers TEXT NOT NULL,
  preview INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  -- Two submissions racing for the same attempt number: one wins, so an attempts limit can't be beaten by double-clicking.
  UNIQUE (artifact_id, version, taker_kind, taker_id, attempt_no)
);
CREATE INDEX idx_quiz_attempts_artifact ON quiz_attempts (artifact_id, created_at DESC);
