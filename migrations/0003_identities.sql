-- Recall sign-in: Microsoft and Apple (the identities table). Additive only.
-- DO NOT APPLY WITHOUT THE OWNER'S OK. Apply it (Preview first, then production) BEFORE any
-- MICROSOFT_* or APPLE_* key is set: those sign-ins read and write this table only. The code may be
-- deployed before it: Google keeps using users.google_sub (its extra identities row is best effort)
-- and Microsoft / Apple stay hidden until their keys exist. README "Paywall".

-- One row per provider account that signs in a user. Google rows are a copy of users.google_sub
-- (kept in step on each Google sign-in); sessions.method may now also be 'microsoft' or 'apple'.
CREATE TABLE identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft', 'apple')),
  subject TEXT NOT NULL,                   -- the ID token's sub
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email TEXT,                              -- lower-cased, as the provider gave it when linked
  email_verified INTEGER NOT NULL DEFAULT 0,
  tenant TEXT,                             -- Microsoft's tid
  is_private_relay INTEGER NOT NULL DEFAULT 0, -- an Apple Hide My Email address
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities (user_id);
INSERT OR IGNORE INTO identities (provider, subject, user_id, email, email_verified, created_at)
  SELECT 'google', google_sub, id, email, 1, created_at FROM users WHERE google_sub IS NOT NULL;
