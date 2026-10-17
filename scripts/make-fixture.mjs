// Builds the small offline fixtures used by tests and the ?demo=1 mode from
// the raw RaceSense downloads (not committed). Usage:
//   node scripts/make-fixture.mjs <racesense-dir> [out.json] [--preset benelux|c31]
// Keeps only the race window, competitors at full rate within ±60 s of the
// gun and ~1 Hz elsewhere, marks every 20 s, and only the columns we use.
// Telemetry gaps in the source are kept as they are (never filled).
//   benelux (default): Benelux Sailing League Act III, J70 race 8 → tests/fixtures/benelux_r8.json
//   c31: C31 Gold Cup race 10, four boats, regatta races 9–10 only → tests/fixtures/c31_r10.json
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
const wind = JSON.parse(readFileSync(join(dir, preset.wind), 'utf8'));
const tele = JSON.parse(readFileSync(join(dir, preset.tele), 'utf8'));

const doc = regatta.revisions.at(-1).doc;
const div = doc.divisions[0];
const race = div.races.find((r) => r.raceNumber === RACE);
const gun = race.starts.at(-1).startTime;
const lastFinish = Math.max(...race.finishes.map((f) => Date.parse(f.finishingTime)));
const t0 = gun - 120_000;
const t1 = lastFinish + 30_000;
if (preset.races) div.races = div.races.filter((r) => preset.races.includes(r.raceNumber));

const keep = ['ts', 'sn', 'division', 'sail_number', 'race_number', 'role', 'latitude', 'longitude', 'heading', 'sog'];
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
  const step = isMark ? 20_000 : near ? 0 : 1_000;
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
