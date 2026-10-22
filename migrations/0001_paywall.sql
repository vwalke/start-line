-- Recall paywall, phase 1 (D1 database bound as AUTH_DB). Times are ms since the epoch.
-- Not applied anywhere yet: see README "Paywall (phase 1, behind PAYWALL_ENABLED)".

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,              -- lower-cased
  google_sub TEXT UNIQUE,
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX users_stripe_customer ON users (stripe_customer_id);

-- One row per signed-in browser; the cookie holds the token, this its SHA-256.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions (user_id, created_at);

-- Magic links: single use (used_at), 15 minutes; only the SHA-256 of the token is kept.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  return_to TEXT
);
CREATE INDEX login_tokens_expires ON login_tokens (expires_at);

-- Payments as the provider reported them. provider_ref (Checkout Session or invoice id) is
-- unique, so a webhook delivered twice records one purchase.
CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,                  -- 'stripe'
  provider_ref TEXT NOT NULL UNIQUE,
  product TEXT NOT NULL,                   -- 'regatta' | 'season' | 'coach'
  amount INTEGER,                          -- minor units
  currency TEXT,
  status TEXT NOT NULL,                    -- 'paid'
  email TEXT,                              -- lower-cased; Restore access looks purchases up by it
  created_at INTEGER NOT NULL
);
CREATE INDEX purchases_email ON purchases (email);
CREATE INDEX purchases_user ON purchases (user_id);

-- What unlocks races 2+. One entitlement per purchase and per subscription (both unique), so
-- replayed or reordered webhooks never grant twice.
CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  scope TEXT NOT NULL CHECK (scope IN ('regatta', 'season', 'coach')),
  event_id TEXT,                           -- regatta pass only
  starts_at INTEGER NOT NULL,
  expires_at INTEGER,                      -- null: no end
  purchase_id TEXT UNIQUE REFERENCES purchases (id),
  subscription_id TEXT UNIQUE,             -- Stripe subscription (season / coach)
  seats INTEGER,                           -- coach plan
  revoked_at INTEGER
);
CREATE INDEX entitlements_user ON entitlements (user_id);

-- Coach plan seats: team_id is the coach entitlement's id.
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES entitlements (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id);

-- Stripe event ids already handled (webhook idempotency).
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
