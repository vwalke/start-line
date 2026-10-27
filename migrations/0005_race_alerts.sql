-- Recall race emails: "Email me when races are posted" (functions/_alerts.ts, workers/race-alerts). Additive only.
-- Needs the owner's OK before it is applied anywhere; apply to Preview first, then production BEFORE
-- deploying this code (/api/alerts answers 503 without it) or the recall-race-alerts Worker. README "Race emails".

-- One row per event anyone has subscribed to: its title and dates (from the RaceSense document, kept
-- fresh by the Worker), so the account sheet and the Worker's date window need no upstream fetch.
-- checked_at: the Worker's last try at the document (it looks at the least recently tried first).
-- synced_at: the Worker's last good read of it. When that is NULL or over an hour old (the event just came
-- into its window, or after an outage) the Worker records the posted races without mailing anyone, and
-- sets baselined_at: a race first seen at or before baselined_at is never mailed.
CREATE TABLE race_alert_events (
  event_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  baselined_at INTEGER,
  checked_at INTEGER,
  synced_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX race_alert_events_end ON race_alert_events (end_ms);

-- Who wants emails for which event. created_at: the subscription's version (the unsubscribe link names it,
-- so an old email can't turn off a later subscription); a race first seen, or started, at or before it is
-- never mailed to them.
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

-- One row per user per race mailed, claimed (INSERT OR IGNORE, status 'pending') before the email that
-- lists it is sent, so a second run or a crash between the two never mails it twice. status: pending | sent
-- | failed. A failed send is claimed again by a later run (attempts + 1) until attempts reaches 3; a
-- 'pending' row left by a crash is never retried.
CREATE TABLE race_alert_sent (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  race_key TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  PRIMARY KEY (user_id, event_id, race_key)
);
