// Builds the small offline fixture used by tests and the ?demo=1 mode from
// the raw RaceSense downloads (not committed). Usage:
//   node scripts/make-fixture.mjs <racesense-dir> [out.json]
// Keeps only the race-8 window, competitors at full rate within ±60 s of the
// gun and ~1 Hz elsewhere, marks every 20 s, and only the columns we use.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '../racesense';
const out = process.argv[3] ?? 'tests/fixtures/benelux_r8.json';
const EVENT = 'fDHdPcEOM6mcMRkdXNnj';
const RACE = 8;

const regatta = JSON.parse(readFileSync(join(dir, `regatta_${EVENT}.json`), 'utf8'));
const wind = JSON.parse(readFileSync(join(dir, 'wind_benelux.json'), 'utf8'));
const tele = JSON.parse(readFileSync(join(dir, 'tele_benelux_r8_full.json'), 'utf8'));

const doc = regatta.revisions.at(-1).doc;
const div = doc.divisions[0];
const race = div.races.find((r) => r.raceNumber === RACE);
const gun = race.starts.at(-1).startTime;
const lastFinish = Math.max(...race.finishes.map((f) => Date.parse(f.finishingTime)));
const t0 = gun - 120_000;
const t1 = lastFinish + 30_000;

const keep = ['ts', 'sn', 'division', 'sail_number', 'race_number', 'role', 'latitude', 'longitude', 'heading', 'sog'];
const idx = Object.fromEntries(tele.Fields.map((f, i) => [f, i]));
const rows = [...tele.Rows].sort((a, b) => a[idx.ts] - b[idx.ts]);
const lastKept = new Map();
const outRows = [];
for (const r of rows) {
  const ts = r[idx.ts];
  if (ts < t0 || ts > t1) continue;
  const isMark = r[idx.role] === 'mark';
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
  note: 'Trimmed from public RaceSense data: Benelux Sailing League Act III, J70, race 8. See scripts/make-fixture.mjs.',
  eventId: EVENT,
  event: { eventId: EVENT, title: doc.name, classLabel: 'J/70', venue: 'Muiden (IJmeer), NL', startMs: doc.startDate, endMs: doc.endDate },
  regatta,
  wind,
  telemetry: { Fields: keep, Rows: outRows },
};
writeFileSync(out, JSON.stringify(fixture));
console.log(`wrote ${out}: ${outRows.length} rows, ${(JSON.stringify(fixture).length / 1e6).toFixed(2)} MB`);
