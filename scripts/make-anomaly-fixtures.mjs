// Builds the small data-anomaly fixtures (adapter.ts liveTracker, dropReplayedFixes, dropSogSpikes) from the raw-feed
// anomaly scan (not committed): regatta/<event>.json and raw/<event>__<division>__<race>.json.gz, the gzipped array of
// telemetry pages Recall fetches for the race (gun − 130 s to the last finish + 30 s). Usage:
//   node scripts/make-anomaly-fixtures.mjs <scan-dir> [--preset stuck|replay|spike|m32]   (all four without --preset)
// Each keeps the division's one race, the sails named (sail numbers only: boat names dropped, the starting stats,
// finishes and check-in / OCS lists of those sails only), the course's mark trackers every 20 s, and ts, sn, sail_number, role, latitude,
// longitude, heading and sog exactly as the feed sent them (no rounding: the replay filter compares exact positions).
//   stuck: ILCA 6 Worlds Elimination, Silver, race 1: CZE 212985's two trackers (one idle ashore with the most rows)
//          at their own rate over the whole race, 5 boats across the results every 20 s → tests/fixtures/anom_stuck.json.
//   replay: ILCA 6 Worlds Elimination, Silver, race 3, gun + 19 to + 25 min: CHI 199268 (one held fix ~1 km off replayed
//          ~90 times a minute among ~45 live fixes) and CZE 212985's two trackers at their own rate, plus the earlier
//          first report of each position they repeat in the window and their last live fix before it; 4 boats every 2 s
//          → tests/fixtures/anom_replay.json.
//   spike: M15 Gulf Coast Championship, race 1, gun − 2 min to + 30 s and + 19:10 to + 21:10: 69 (one 6771 kn reading at
//          gun − 51 s) and 409 (one 1496 kn reading at + 20:11) at their own rate, 4 boats every 2 s → tests/fixtures/anom_spike.json.
//   m32: 2026 M32 World Championship, race 17, gun + 8:30 to + 10:00: the 6 fastest boats at their own rate, the fleet at
//          ~21 kn with readings to ~25 kn → tests/fixtures/anom_m32.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const MIN = 60_000;
const PRESETS = {
  stuck: {
    event: '6Oy9oEgYpzB5WUa51fsJ',
    division: 'Silver',
    race: 1,
    label: 'ILCA 6 Worlds Elimination',
    classLabel: 'ILCA 6',
    focus: ['CZE 212985'],
    // At their own rate: the idle tracker's row lead (the old pick) is the point.
    focusStep: 0,
    pick: 5,
    step: 20_000,
    note: "CZE 212985's two trackers at their own rate (one idle ashore, with the most rows), 5 boats across the results every 20 s",
  },
  replay: {
    event: '6Oy9oEgYpzB5WUa51fsJ',
    division: 'Silver',
    race: 3,
    label: 'ILCA 6 Worlds Elimination',
    classLabel: 'ILCA 6',
    windows: [[19 * MIN, 25 * MIN]],
    focus: ['CHI 199268', 'CZE 212985'],
    focusStep: 0,
    // The held fix was first sent (live) at + 9 min: keep that report, or its first replay in the window looks new; and
    // the live fix before the window, or the window's first replays look like a hold of that report.
    originals: true,
    pick: 4,
    step: 2_000,
    note: "gun + 19 to + 25 min: CHI 199268 (a held fix replayed among its live ones) and CZE 212985's two trackers at their own rate, 4 boats every 2 s",
  },
  spike: {
    event: 'ut6vhngUNMHBiizZ9QpU',
    division: 'M15',
    race: 1,
    label: 'M15 Gulf Coast Championship',
    classLabel: 'M15',
    windows: [
      [-2 * MIN, 30_000],
      [19 * MIN + 10_000, 21 * MIN + 10_000],
    ],
    focus: ['69', '409'],
    focusStep: 0,
    pick: 4,
    step: 2_000,
    note: 'gun − 2 min to + 30 s and + 19:10 to + 21:10: 69 and 409 (one SOG spike each at a good position) at their own rate, 4 boats every 2 s',
  },
  m32: {
    event: 'ur7YQHKFpn6Br0wRBFXZ',
    division: 'M32',
    race: 17,
    label: '2026 M32 World Championship',
    classLabel: 'M32',
    windows: [[8.5 * MIN, 10 * MIN]],
    // The six fastest there (each over 22 kn for 37–80 fixes of that minute).
    focus: ['60', '52', '69', '77', '44', '63'],
    focusStep: 0,
    pick: 0,
    step: 0,
    note: 'gun + 8:30 to + 10:00, the fleet at ~21 kn: the 6 fastest boats at their own rate',
  },
};

const args = process.argv.slice(2);
const pi = args.indexOf('--preset');
const names = pi >= 0 ? [args[pi + 1]] : Object.keys(PRESETS);
const dir = (pi >= 0 ? args.filter((_, i) => i !== pi && i !== pi + 1) : args)[0] ?? '/workspace/fb/anomaly-scan';
const FIELDS = ['ts', 'sn', 'sail_number', 'role', 'latitude', 'longitude', 'heading', 'sog'];

for (const name of names) {
  const p = PRESETS[name];
  if (!p) throw new Error(`Unknown preset ${name}; one of ${Object.keys(PRESETS).join(', ')}`);
  const regatta = JSON.parse(readFileSync(join(dir, 'regatta', `${p.event}.json`), 'utf8'));
  regatta.revisions = regatta.revisions.slice(-1);
  const doc = regatta.revisions[0].doc;
  doc.deviceSubs = [];
  doc.divisions = doc.divisions.filter((d) => d.name === p.division);
  const div = doc.divisions[0];
  div.races = div.races.filter((r) => r.raceNumber === p.race);
  const race = div.races[0];
  const st = race.starts.at(-1);
  const gun = st.startTime;
  const finishers = [...(race.finishes ?? [])].sort((a, b) => Date.parse(a.finishingTime) - Date.parse(b.finishingTime)).map((f) => f.sailNumber);
  // `pick` boats spread evenly over the finish order (the winner first), the focus sails aside.
  const order = finishers.filter((s) => !p.focus.includes(s));
  const n = Math.min(p.pick, order.length);
  const picked = [...new Set(Array.from({ length: n }, (_, k) => order[Math.round((k * (order.length - 1)) / Math.max(1, n - 1))]))];
  const sails = new Set([...p.focus, ...picked]);
  // Sail numbers only: no boat names; starting stats and finishes of the kept sails only.
  div.participants = div.participants.filter((x) => sails.has(x.sailNumber)).map(({ boatName: _boatName, ...x }) => x);
  for (const s of race.starts) {
    s.startingStats = (s.startingStats ?? []).filter((x) => sails.has(x.sailNumber));
    for (const k of ['checkedInParticipants', 'ocsParticipants', 'clearedOcs', 'exoneratedParticipants']) if (Array.isArray(s[k])) s[k] = s[k].filter((x) => sails.has(x));
  }
  race.finishes = (race.finishes ?? []).filter((f) => sails.has(f.sailNumber));
  const courseSns = new Set((div.courses ?? []).flatMap((c) => c.achievements.flatMap((a) => a.deviceRoles.map((d) => parseInt(d.sn.slice(-4), 16)))));

  const file = `${p.event}__${p.division.replace(/[/ ]/g, '_')}__${p.race}.json.gz`;
  const pages = JSON.parse(gunzipSync(readFileSync(join(dir, 'raw', file))).toString('utf8')).filter((pg) => pg?.Fields && pg.Rows);
  const rows = pages.flatMap((pg) => pg.Rows.map((r) => Object.fromEntries(pg.Fields.map((f, i) => [f, r[i]])))).sort((a, b) => a.ts - b.ts);
  const windows = (p.windows ?? [[-Infinity, Infinity]]).map(([a, b]) => [gun + a, gun + b]);
  const inWindow = (ts) => windows.some(([a, b]) => ts >= a && ts <= b);
  // `originals`: the earliest report of each position a focus tracker repeats in the window, when it is before it, and
  // the tracker's last live fix (a position's first report) before the window, where the live track was.
  const posKey = (r) => `${r.sn}|${r.latitude}|${r.longitude}`;
  const first = new Map();
  const originals = new Set();
  if (p.originals) {
    for (const r of rows) if (r.role === 'competitor' && p.focus.includes(r.sail_number) && !first.has(posKey(r))) first.set(posKey(r), r);
    for (const r of rows) {
      const o = r.role === 'competitor' && p.focus.includes(r.sail_number) && inWindow(r.ts) ? first.get(posKey(r)) : undefined;
      if (o && o !== r && !inWindow(o.ts)) originals.add(o);
    }
    const lastLive = new Map();
    for (const r of rows) if (r.ts < windows[0][0] && first.get(posKey(r)) === r) lastLive.set(r.sn, r);
    for (const r of lastLive.values()) originals.add(r);
  }
  const lastKept = new Map();
  const seenTs = new Set();
  const out = [];
  for (const r of rows) {
    if (!inWindow(r.ts) && !originals.has(r)) continue;
    const isMark = r.role === 'mark';
    if (isMark ? !courseSns.has(r.sn) : r.role !== 'competitor' || !sails.has(r.sail_number)) continue;
    const key = `${r.role}:${r.sn}`;
    // Pages overlap by 1 ms: one copy of a row.
    if (seenTs.has(`${key}:${r.ts}`)) continue;
    seenTs.add(`${key}:${r.ts}`);
    const step = isMark ? 20_000 : p.focus.includes(r.sail_number) ? p.focusStep : p.step;
    const prev = lastKept.get(key);
    if (prev !== undefined && r.ts - prev < step && !originals.has(r)) continue;
    lastKept.set(key, r.ts);
    out.push(FIELDS.map((f) => r[f] ?? null));
  }
  const fixture = {
    note: `Trimmed from public RaceSense data: ${p.label}, ${p.division}, race ${p.race} (${p.note}; course marks every 20 s; no IMU; no boat names). See scripts/make-anomaly-fixtures.mjs --preset ${name}.`,
    eventId: p.event,
    event: { eventId: p.event, title: doc.name, classLabel: p.classLabel, startMs: doc.startDate, endMs: doc.endDate },
    regatta,
    wind: null,
    telemetry: { Fields: FIELDS, Rows: out },
  };
  const outFile = `tests/fixtures/anom_${name}.json`;
  writeFileSync(outFile, JSON.stringify(fixture));
  console.log(`wrote ${outFile}: ${out.length} rows, ${(JSON.stringify(fixture).length / 1e6).toFixed(2)} MB, sails ${[...sails].join(', ')}`);
}
