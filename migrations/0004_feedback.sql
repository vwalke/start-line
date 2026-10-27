-- Recall feedback: what the Feedback sheet sends (functions/_feedback.ts). Additive only.
-- Needs the owner's OK before it is applied anywhere; apply to Preview first, then production BEFORE
-- deploying this code (POST /api/feedback writes here and answers 503 without it). README "Feedback".

-- One row per submission. Who sent it (user_id, email, session_public_id) comes from the session
-- cookie when signed in, never from the page; a signed-out sender's email is the one they typed, if
-- any. ip_hash is a salted SHA-256 (never the raw IP). context_json is the page's own report (URL,
-- view, device, theme, app version, recent errors; at most 32 KB). Images live in R2 (VKX_BUCKET)
-- under feedback/<id>/: image_key for the upload, map_key for the course map; image_note says why
-- one was left out (no bucket bound). emailed_at / email_error: how the FEEDBACK_TO email went.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('bug', 'idea', 'data', 'other')),
  message TEXT NOT NULL,
  email TEXT,                      -- lower-cased
  user_id TEXT,
  session_public_id TEXT,
  ip_hash TEXT,
  country TEXT,
  colo TEXT,
  user_agent TEXT,
  url TEXT,
  event_id TEXT,
  division TEXT,
  race TEXT,
  app_commit TEXT,
  context_json TEXT NOT NULL,
  image_key TEXT,
  image_type TEXT,
  image_bytes INTEGER,
  map_key TEXT,
  image_note TEXT,
  emailed_at INTEGER,
  email_error TEXT
);
CREATE INDEX feedback_created_at ON feedback (created_at);
CREATE INDEX feedback_user_id ON feedback (user_id);
