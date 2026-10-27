-- Recall race emails: "Email me when races are posted" (functions/_alerts.ts, workers/race-alerts). Additive only.
-- Needs the owner's OK before it is applied anywhere; apply to Preview first, then production BEFORE
-- deploying this code (/api/alerts answers 503 without it) or the recall-race-alerts Worker. README "Race emails".

-- One row per event anyone has subscribed to: its title and dates (from the RaceSense document, kept
-- fresh by the Worker), so the account sheet and the Worker's date window need no upstream fetch.
-- baselined_at: when the races already posted were recorded in race_alert_seen without mailing
-- anyone (NULL: not yet; the Worker then baselines before it sends anything for the event).
CREATE TABLE race_alert_events (
  event_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  baselined_at INTEGER,
  checked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX race_alert_events_end ON race_alert_events (end_ms);

-- Who wants emails for which event. created_at: a race first seen at or before it is never mailed to them.
CREATE TABLE race_alert_subs (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX race_alert_subs_event ON race_alert_subs (event_id);

-- The posted races known per event. race_key: `<division>|<RaceSense race number>`.
CREATE TABLE race_alert_seen (
  event_id TEXT NOT NULL,
  race_key TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, race_key)
);

-- One row per email per user per race, written (INSERT OR IGNORE, status 'pending') before the send,
-- so a retry or a crash between the two never mails twice. status: pending | sent | failed.
CREATE TABLE race_alert_sent (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  race_key TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,
  PRIMARY KEY (user_id, event_id, race_key)
);
