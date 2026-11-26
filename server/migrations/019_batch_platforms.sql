-- 019: the platforms a bot batch's posts go to. NULL = the default platforms (Settings → Social accounts).
ALTER TABLE bot_batches ADD COLUMN IF NOT EXISTS platforms TEXT[];
