/**
 * Usage events: the names and limits shared by the page's tracker (src/ui/track.ts) and the endpoint that
 * stores them (functions/_track.ts, POST /api/track). Nothing here identifies a person: no IP, email,
 * name, user id or cookie is ever sent or stored (README "Usage tracking").
 *
 * The batch the page sends (text/plain JSON, at most BODY_MAX bytes, 1 to BATCH_MAX events):
 *
 *   { sid, dev, th, auth, ev: [{ n, p, e?, r?, d?, f?, s, t }, …] }
 *
 *   sid   the session: a random UUID kept in sessionStorage (one tab, gone when it closes)
 *   dev   'mobile' | 'tablet' | 'desktop'
 *   th    'light' | 'dark' (the theme drawn)
 *   auth  'yes' | 'no' | 'unknown' (signed in to Recall; 'unknown' until /api/auth/me answers or with the paywall off)
 *   n     the event (TRACK_EVENTS)
 *   p     the page's path (normalized to TRACK_PATHS on the server; never the query string)
 *   e     a RaceSense event id; r: the race, `<division>|<race number>`; d: a detail (a tab's name, a provider, …)
 *   f     the referrer's host, on the session's first event only
 *   s     the event's number in the session (1, 2, …); t: ms since the session began
 *
 * One Workers Analytics Engine data point per event, in the RECALL_EVENTS dataset (recall_events):
 *
 *   index1   session id
 *   blob1    event name            blob6   device class
 *   blob2    path (view)           blob7   referrer host (first event of the session only, else '')
 *   blob3    event id              blob8   theme
 *   blob4    race id               blob9   detail
 *   blob5    signed in yes/no/unknown       blob10  country (Cloudflare's two letters, else '')
 *   double1  seq in session        double2 ms since session start
 *
 * scripts/usage-report.mjs queries these columns by position: keep the two in step.
 */

export const TRACK_EVENTS = [
  // the landing page
  'landing_view',
  'live_card_click',
  'upcoming_card_click',
  // the app
  'app_open',
  'regatta_open',
  'race_open',
  'tab',
  'report_open',
  'coach_view',
  'coach_ask',
  'table_sort',
  'full_screen',
  'replay_play',
  'replay_scrub',
  'replay_boat',
  'boat_select',
  // accounts and passes
  'signin_prompt',
  'signin_start',
  'signin_done',
  'account_open',
  'paywall_shown',
  'checkout_start',
  'notify_on',
  // anywhere
  'feedback_open',
  'feedback_sent',
  'theme',
] as const;
export type TrackEvent = (typeof TRACK_EVENTS)[number];

/** The paths the app shows (src/ui/nav.ts) and the landing page's; anything else is stored as 'other'. */
export const TRACK_PATHS = ['/', '/regattas', '/regattas/start', '/regattas/race', '/regattas/coach', '/regattas/report'] as const;

export const DEVICES = ['mobile', 'tablet', 'desktop'] as const;
export type Device = (typeof DEVICES)[number];
export const THEMES = ['light', 'dark'] as const;
export const AUTH = ['yes', 'no', 'unknown'] as const;
export type Auth = (typeof AUTH)[number];

export const BATCH_MAX = 20;
export const BODY_MAX = 4_096;
/** The most events one session sends (the page stops counting there); the server refuses a higher `s`. */
export const SESSION_MAX = 300;
/** A day: `t` beyond it is refused (a tab left open longer starts no new session, but its events stop counting). */
export const SESSION_MS_MAX = 86_400_000;

export const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** As ui/lastView.ts's event ids, with room. */
export const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** `<division>|<race number>`: a division's printable name, a bar, digits. */
export const RACE_ID_RE = /^[^\p{Cc}<>|]{1,48}\|\d{1,12}$/u;
export const DETAIL_RE = /^[a-z0-9_-]{1,32}$/;
export const HOST_RE = /^[a-z0-9.-]{1,253}$/;
export const PATH_RE = /^\/[A-Za-z0-9/._-]{0,127}$/;
