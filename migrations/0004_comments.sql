-- Comments on shared artifacts. Off by default per artifact (comments_enabled), so nothing that is already
-- shared starts showing a discussion to its viewers until the owner turns it on.

ALTER TABLE artifacts ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  -- The version that was latest when the comment was written.
  version INTEGER NOT NULL,
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL,
  -- staff: a signed-in PostHog user. guest: an invited viewer (see invited visibility).
  author_kind TEXT NOT NULL CHECK (author_kind IN ('staff', 'guest')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_comments_artifact ON comments (artifact_id, created_at);
