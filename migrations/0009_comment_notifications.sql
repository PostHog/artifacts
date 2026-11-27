-- Whether the owner wants a Slack message about new comments. On by default; it only matters while comments are on.

ALTER TABLE artifacts ADD COLUMN comment_notifications INTEGER NOT NULL DEFAULT 1;
