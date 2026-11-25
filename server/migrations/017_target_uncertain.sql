-- 017: a platform whose post may have gone out (no answer, or interrupted mid-send) is marked "uncertain".
-- "Try again" leaves those alone until a person says whether the post is there, so nothing is posted twice.
ALTER TABLE post_targets ADD COLUMN IF NOT EXISTS uncertain BOOLEAN NOT NULL DEFAULT false;
UPDATE post_targets SET uncertain = true
WHERE status = 'failed' AND (last_error ILIKE '%may have been posted%' OR last_error ILIKE '%Interrupted%' OR last_error ILIKE '%before retrying%');
