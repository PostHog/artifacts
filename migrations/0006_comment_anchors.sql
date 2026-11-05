-- A comment can point at a passage of the artifact: the quoted text plus a little text either side, so it can be
-- found again. NULL means the comment is about the artifact as a whole, as before.

ALTER TABLE comments ADD COLUMN anchor_exact TEXT;
ALTER TABLE comments ADD COLUMN anchor_prefix TEXT;
ALTER TABLE comments ADD COLUMN anchor_suffix TEXT;
