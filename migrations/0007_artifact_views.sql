-- Who has viewed an artifact, for the owner's view counter. One row per viewer per artifact. The owner's own
-- views are never recorded.

CREATE TABLE artifact_views (
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  -- A signed-in viewer's lowercased email (staff, or an invited guest), or 'anon:<cookie id>' for a signed-out
  -- browser. Keying staff and guests by email means a colleague let in through an invite list counts once.
  -- 'anon:overflow' collects signed-out views once an artifact has reached its cap of signed-out rows.
  viewer_key TEXT NOT NULL,
  -- staff: a PostHog staff email. guest: an invited customer. anonymous: a signed-out viewer of a public link.
  viewer_kind TEXT NOT NULL CHECK (viewer_kind IN ('staff', 'guest', 'anonymous')),
  -- Shown to the owner. NULL for anonymous viewers.
  email TEXT,
  name TEXT,
  views INTEGER NOT NULL DEFAULT 1,
  first_viewed_at INTEGER NOT NULL,
  last_viewed_at INTEGER NOT NULL,
  -- The version they saw last. Non-owners only ever see the latest, so this shows who hasn't seen an update.
  last_version INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, viewer_key)
);
CREATE INDEX idx_artifact_views_recent ON artifact_views (artifact_id, last_viewed_at);
-- Counting an artifact's signed-out rows, for the cap on them (see recordView).
CREATE INDEX idx_artifact_views_kind ON artifact_views (artifact_id, viewer_kind);
