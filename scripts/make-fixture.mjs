// Builds the small offline fixtures used by tests from
// the raw RaceSense downloads (not committed). Usage:
//   node scripts/make-fixture.mjs <racesense-dir> [out.json] [--preset benelux|c31|m24|j88]
// Keeps only the race window, competitors at full rate within ±60 s of the
// gun and ~1 Hz elsewhere, marks every 20 s, and only the columns we use.
// Telemetry gaps in the source are kept as they are (never filled).
//   benelux (default): Benelux Sailing League Act III, J70 race 8 → tests/fixtures/benelux_r8.json
//   c31: C31 Gold Cup race 10, four boats, regatta races 9–10 only → tests/fixtures/c31_r10.json
//   m24: Melges 24 Worlds race 4 (only the Gate is tracked), 12 boats spread over the results,
//        competitors every 2 s away from the gun, plus coaches 03/07/10, SPARE 1 and 619 Hot Water
//        (SPARE 1 is a second tracker on 619 in this race) every 4 s; the other races keep only
//        their finishes (for the event-wide results) → tests/fixtures/m24_r4.json
//   j88: J/88 North Americans race 5 (no mark trackers), 8 boats, every 3 s away from the gun → tests/fixtures/j88_r5.json
// m24 and j88 read the survey downloads (regatta_<event>.json, tele_<event>_<div>_<race>.json
// as an array of telemetry pages, wind_<event>_<YYYY-MM-DD>.json), e.g. from /workspace/legsplit-data.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PRESETS = {
  benelux: {
    event: 'fDHdPcEOM6mcMRkdXNnj',
    race: 8,
    tele: 'tele_benelux_r8_full.json',
    wind: 'wind_benelux.json',
    out: 'tests/fixtures/benelux_r8.json',
    note: 'Trimmed from public RaceSense data: Benelux Sailing League Act III, J70, race 8. See scripts/make-fixture.mjs.',
    event_: (doc) => ({ classLabel: 'J/70', venue: 'Muiden (IJmeer), NL', startMs: doc.startDate, endMs: doc.endDate }),
  },
  c31: {
    event: 'J7KXCe6mx9jQpv3Li0Ae',
    race: 10,
    tele: 'tele_c31_r10_full.json',
    wind: 'wind_c31.json',
    out: 'tests/fixtures/c31_r10.json',
    note: 'Trimmed from public RaceSense data: C31 Gold Cup, race 10 (four boats; regatta races 9 and 10 only). See scripts/make-fixture.mjs --preset c31.',
    event_: (doc) => ({ classLabel: 'C31', startMs: doc.startDate, endMs: doc.endDate }),
    // Black Pearl (stale row), Milkwave (mask 5), Stella Maris (no distance), Outrage (clean).
    sails: ['GER42', 'ITA 78', 'AUT 3165', 'FRA 901'],
    races: [9, 10],
  },
  m24: {
    event: 'i6WfokvPgVWlOVwyaaer',
    division: 'M24',
    race: 4,
    tele: 'tele_i6WfokvPgVWlOVwyaaer_M24_4.json',
    wind: (gun) => `wind_i6WfokvPgVWlOVwyaaer_${new Date(gun).toISOString().slice(0, 10)}.json`,
    out: 'tests/fixtures/m24_r4.json',
    note: 'Trimmed from public RaceSense data: Melges 24 Worlds, race 4 (12 boats across the results, plus three coaches, SPARE 1 and 619; other races reduced to their finishes). See scripts/make-fixture.mjs --preset m24.',
    event_: (doc) => ({ classLabel: 'Melges 24', startMs: doc.startDate, endMs: doc.endDate }),
    pick: 12,
    // Non-competitors (coach motorboats, a spare tracker) and the boat that spare rode on in race 4.
    extra: ['03', '07', '10', 'SPARE 1', '619'],
    extraStep: 4_000,
    slimOthers: true,
    step: 2_000,
    lastRevision: true,
  },
  j88: {
    event: 'd0MCbOz3yXpYdrI9yZH2',
    division: 'J88',
    race: 5,
    tele: 'tele_d0MCbOz3yXpYdrI9yZH2_J88_5.json',
    wind: (gun) => `wind_d0MCbOz3yXpYdrI9yZH2_${new Date(gun).toISOString().slice(0, 10)}.json`,
    out: 'tests/fixtures/j88_r5.json',
    note: 'Trimmed from public RaceSense data: J/88 North American Championship, race 5 (no mark trackers; 8 boats across the results; regatta race 5 only). See scripts/make-fixture.mjs --preset j88.',
    event_: (doc) => ({ classLabel: 'J/88', startMs: doc.startDate, endMs: doc.endDate }),
    pick: 8,
    races: [5],
    // 3 s keeps it under 1 MB; the turns are minutes apart.
    step: 3_000,
    lastRevision: true,
  },
};

const args = process.argv.slice(2);
const pi = args.indexOf('--preset');
const preset = PRESETS[pi >= 0 ? args[pi + 1] : 'benelux'];
if (!preset) throw new Error(`Unknown preset; one of ${Object.keys(PRESETS).join(', ')}`);
const pos = pi >= 0 ? args.filter((_, i) => i !== pi && i !== pi + 1) : args;
const dir = pos[0] ?? '../racesense';
const out = pos[1] ?? preset.out;
const EVENT = preset.event;
const RACE = preset.race;

const regatta = JSON.parse(readFileSync(join(dir, `regatta_${EVENT}.json`), 'utf8'));
if (preset.lastRevision) regatta.revisions = regatta.revisions.slice(-1);

const doc = regatta.revisions.at(-1).doc;
if (preset.division) doc.divisions = doc.divisions.filter((d) => d.name === preset.division);
const div = doc.divisions[0];
const race = div.races.find((r) => r.raceNumber === RACE);
const gun = race.starts.at(-1).startTime;
const lastFinish = Math.max(...race.finishes.map((f) => Date.parse(f.finishingTime)));
const t0 = gun - 120_000;
const t1 = lastFinish + 30_000;
if (preset.races) div.races = div.races.filter((r) => preset.races.includes(r.raceNumber));
// Other races: just enough for the event-wide results (who finished, how far, how fast).
const FINISH_KEEP = ['sailNumber', 'serialNumber', 'finishingTime', 'distanceTraveled', 'maxSpeed', 'raceNumber'];
if (preset.slimOthers) {
  div.races = div.races.map((r) =>
    r.raceNumber === RACE
      ? r
      : {
          raceNumber: r.raceNumber,
          isPractice: r.isPractice,
          starts: [],
          finishes: (r.finishes ?? []).map((f) => Object.fromEntries(FINISH_KEEP.filter((k) => k in f).map((k) => [k, f[k]]))),
        },
  );
}

const wind = JSON.parse(readFileSync(join(dir, typeof preset.wind === 'function' ? preset.wind(gun) : preset.wind), 'utf8'));
// A single telemetry page, or the array of pages fetchTelemetry returns (null pages skipped).
const rawTele = JSON.parse(readFileSync(join(dir, preset.tele), 'utf8'));
let tele = rawTele;
if (Array.isArray(rawTele)) {
  const pages = rawTele.filter((p) => p?.Fields && p.Rows);
  const Fields = pages[0].Fields;
  tele = { Fields, Rows: pages.flatMap((p) => p.Rows.map((r) => Fields.map((f) => r[p.Fields.indexOf(f)]))) };
}

// `pick` boats spread evenly over the finish order (the winner first).
if (preset.pick) {
  const order = [...race.finishes].sort((a, b) => Date.parse(a.finishingTime) - Date.parse(b.finishingTime)).map((f) => f.sailNumber);
  const n = Math.min(preset.pick, order.length);
  preset.sails = [...new Set(Array.from({ length: n }, (_, k) => order[Math.round((k * (order.length - 1)) / Math.max(1, n - 1))]))];
}
const extra = new Set((preset.extra ?? []).filter((s) => !preset.sails?.includes(s)));
if (preset.sails) preset.sails = [...preset.sails, ...extra];
const STEP = preset.step ?? 1_000;

// roll (heel) and pitch (trim) are kept where the source has them.
const keep = ['ts', 'sn', 'division', 'sail_number', 'race_number', 'role', 'latitude', 'longitude', 'heading', 'sog', 'roll', 'pitch'].filter(
  (f) => tele.Fields.includes(f),
);
const idx = Object.fromEntries(tele.Fields.map((f, i) => [f, i]));
const rows = [...tele.Rows].sort((a, b) => a[idx.ts] - b[idx.ts]);
const lastKept = new Map();
const outRows = [];
for (const r of rows) {
  const ts = r[idx.ts];
  if (ts < t0 || ts > t1) continue;
  const isMark = r[idx.role] === 'mark';
  if (preset.sails && !isMark && !preset.sails.includes(r[idx.sail_number])) continue;
  const near = Math.abs(ts - gun) <= 60_000;
  const step = isMark ? 20_000 : near ? 0 : extra.has(r[idx.sail_number]) ? (preset.extraStep ?? STEP) : STEP;
  const key = `${r[idx.role]}:${r[idx.sn]}`;
  const prev = lastKept.get(key);
  if (prev !== undefined && ts - prev < step) continue;
  if (prev !== undefined && ts === prev) continue;
  lastKept.set(key, ts);
  outRows.push(keep.map((f) => r[idx[f]]));
}

const fixture = {
  note: preset.note,
  eventId: EVENT,
  event: { eventId: EVENT, title: doc.name, ...preset.event_(doc) },
  regatta,
  wind,
  telemetry: { Fields: keep, Rows: outRows },
};
writeFileSync(out, JSON.stringify(fixture));
console.log(`wrote ${out}: ${outRows.length} rows, ${(JSON.stringify(fixture).length / 1e6).toFixed(2)} MB`);
