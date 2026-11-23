-- 006: posts and publishing fixes
-- Who last changed a post's content (title, message, hashtags, media, link). Used so that the person
-- who wrote or rewrote a post can't also approve it.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS last_edited_by INT REFERENCES users(id) ON DELETE SET NULL;

-- Existing posts: the author is the last known content editor.
UPDATE posts SET last_edited_by = created_by WHERE last_edited_by IS NULL AND created_by IS NOT NULL;

-- Per-post lookups on the post page.
CREATE INDEX IF NOT EXISTS publish_logs_post_idx ON publish_logs (post_id);
CREATE INDEX IF NOT EXISTS post_reviews_post_idx ON post_reviews (post_id);
