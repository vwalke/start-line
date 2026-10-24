-- Recall sign-in, phase 1: the visible 3-device cap and shared sign-in rate limits. Additive only.
-- Needs the owner's OK before it is applied anywhere; apply to Preview first, then production BEFORE
-- deploying this code (the code reads these columns on every signed-in request). README "Paywall".

-- Each session gets a public id (the device list and the revoke routes name sessions by it, never
-- by the token hash), when it was last used, how it signed in, and why it ended when it was signed
-- out from elsewhere. A revoked row stays (for the "you were signed out" note) until 30 days on.
ALTER TABLE sessions ADD COLUMN public_id TEXT;
UPDATE sessions SET public_id = lower(hex(randomblob(12))) WHERE public_id IS NULL;
CREATE UNIQUE INDEX sessions_public_id ON sessions (public_id);

ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL;

ALTER TABLE sessions ADD COLUMN method TEXT;               -- 'email' | 'google'; NULL for older rows
ALTER TABLE sessions ADD COLUMN revoked_at INTEGER;
ALTER TABLE sessions ADD COLUMN revoked_reason TEXT;       -- 'device_limit' | 'remote' | 'admin'
ALTER TABLE sessions ADD COLUMN revoked_by TEXT;           -- public_id of the session whose sign-in bumped it

-- The admin's per-user device cap (scripts/sessions.mjs set-cap); NULL means the default (3).
ALTER TABLE users ADD COLUMN max_sessions INTEGER;

-- Sign-in email limits, shared by every isolate: fixed one-hour windows. key is
-- 'email:<sha256 hex of the normalized address>' or 'ip:<sha256 hex of the IP>' (never the raw value).
CREATE TABLE auth_rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
