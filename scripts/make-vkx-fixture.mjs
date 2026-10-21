// Builds the offline boat-log (.vkx upload) fixtures in tests/fixtures/vkx/ from
// RO's (Relative Obscurity, USA 833) own log of Fri Sep 11 2026, J/70 Worlds Cascais.
// Usage:
//   node scripts/make-vkx-fixture.mjs <ro-usa833-2026-09-11.vkx> <regatta.json> [--ro-feed ro_feed.json]
// Writes:
//   ro-trim.vkx   The log's page header + config row, every timer event, and every row
//                 (positions, pings, declination, internal rows, page headers) recorded
//                 12:01–12:08Z (R7 gun 12:05Z) and 13:51–13:58Z (R8 gun 13:55Z). ~0.6 MB.
//   feed.json     teleapi rows (columns we use) as one TelemetryPage: USA 833 (sn 12364)
//                 11:55–15:25Z, and the 4 boats nearest it at the R7 gun over the two
//                 trimmed windows. RO's rows come from --ro-feed (the rows the vkx
//                 investigation saved, as a JSON array of row objects) or, without it,
//                 from teleapi (≈ 200 pages of the whole fleet: heavy; prefer --ro-feed).
//   regatta.json  The regatta document trimmed to the Open division's races (starts without
//                 startingStats, finishes of the kept boats only) and the kept participants.
// Network: 2 teleapi requests (the two 7-minute windows, whole fleet), 1 s apart,
// UA "StartLine/1 (+https://walkeforward.com)".
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const UA = 'StartLine/1 (+https://walkeforward.com)';
const EVENT = 'oRkxbTpSZPbSkrmKrbj2';
const DIVISION = 'Open';
const RO_SN = 12364;
const OUT = 'tests/fixtures/vkx';
const Z = (hhmmss) => Date.parse(`2026-09-11T${hhmmss}Z`);
const TRIM = [
  [Z('12:01:00'), Z('12:08:00')],
  [Z('13:51:00'), Z('13:58:00')],
];
const RO_SPAN = [Z('11:55:00'), Z('15:25:00')];
const R7_GUN = Z('12:05:00');
const KEEP_FIELDS = ['ts', 'sn', 'division', 'sail_number', 'race_number', 'race_stage', 'role', 'latitude', 'longitude', 'pitch', 'roll', 'heading', 'sog'];

const SIZE = { 1: 32, 2: 44, 3: 20, 4: 13, 5: 17, 6: 18, 7: 12, 8: 13, 10: 16, 11: 16, 12: 12, 14: 16, 15: 16, 16: 12, 32: 13, 33: 52, 254: 2, 255: 7 };

const args = process.argv.slice(2);
const [vkxPath, regattaPath] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--ro-feed');
const roFeedPath = args.includes('--ro-feed') ? args[args.indexOf('--ro-feed') + 1] : null;
if (!vkxPath || !regattaPath) {
  console.error('usage: node scripts/make-vkx-fixture.mjs <log.vkx> <regatta.json> [--ro-feed rows.json]');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

// ---- the trimmed log
const src = readFileSync(vkxPath);
const parts = [];
let i = 0;
let cur = 0; // time of the last row with a timestamp
let headerKept = false;
const inTrim = (t) => TRIM.some(([a, b]) => t >= a && t < b);
while (i < src.length) {
  const k = src[i];
  const size = SIZE[k];
  if (size === undefined || i + 1 + size > src.length) break;
  const row = src.subarray(i, i + 1 + size);
  if ([2, 3, 4, 5, 6].includes(k)) cur = Number(src.readBigUInt64LE(i + 1));
  const keep = (k === 255 && !headerKept) || k === 8 || k === 4 || inTrim(cur);
  if (k === 255) headerKept = true;
  if (keep) parts.push(row);
  i += 1 + size;
}
const trimmed = Buffer.concat(parts);
writeFileSync(`${OUT}/ro-trim.vkx`, trimmed);
console.log('ro-trim.vkx', trimmed.length, 'bytes');

// ---- feed rows
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function page(after, before) {
  const u = `https://teleapi.regatta.app/telemetry/event/${EVENT}?after=${after}&before=${before}&limit=100000&division=${encodeURIComponent(DIVISION)}`;
  const res = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} for ${u}`);
  return res.json();
}
const rowsOf = (p) => (p.Rows ?? []).map((r) => Object.fromEntries(p.Fields.map((f, j) => [f, r[j]])));

const windows = [];
for (const [a, b] of TRIM) {
  windows.push(...rowsOf(await page(a, b)));
  await sleep(1000);
}
// The 4 competitors nearest RO at the R7 gun (the hardest wrong answers for the matcher).
const near = (sn) => windows.filter((r) => r.sn === sn && Math.abs(r.ts - R7_GUN) < 20_000).sort((x, y) => Math.abs(x.ts - R7_GUN) - Math.abs(y.ts - R7_GUN))[0];
const ro = near(RO_SN);
const dist = (r) => Math.hypot((r.latitude - ro.latitude) * 111_320, (r.longitude - ro.longitude) * 111_320 * Math.cos((ro.latitude * Math.PI) / 180));
const others = [...new Set(windows.filter((r) => r.role === 'competitor' && r.sn !== RO_SN).map((r) => r.sn))]
  .map((sn) => ({ sn, r: near(sn) }))
  .filter((x) => x.r)
  .sort((x, y) => dist(x.r) - dist(y.r))
  .slice(0, 4)
  .map((x) => x.sn);
console.log('nearest boats', others.map((sn) => `${sn} ${near(sn).sail_number} ${dist(near(sn)).toFixed(0)} m`));

let roRows;
if (roFeedPath) {
  roRows = JSON.parse(readFileSync(roFeedPath, 'utf8'));
} else {
  roRows = [];
  for (let a = RO_SPAN[0]; a < RO_SPAN[1]; ) {
    const p = await page(a, RO_SPAN[1]);
    const rs = rowsOf(p);
    roRows.push(...rs.filter((r) => r.sn === RO_SN));
    if (rs.length < 100_000) break;
    a = rs[rs.length - 1].ts - 1;
    await sleep(1000);
  }
}
roRows = roRows.filter((r) => r.sn === RO_SN && r.ts >= RO_SPAN[0] && r.ts <= RO_SPAN[1]);
const fleetRows = windows.filter((r) => others.includes(r.sn));
const seen = new Set();
const all = [...roRows, ...fleetRows]
  .filter((r) => {
    const key = `${r.sn}|${r.ts}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })
  .sort((a, b) => a.ts - b.ts || a.sn - b.sn);
const feed = {
  note: 'teleapi rows, J/70 Worlds Cascais (event oRkxbTpSZPbSkrmKrbj2), Fri 2026-09-11: USA 833 (sn 12364) 11:55–15:25Z, and the 4 boats nearest it at the R7 gun over 12:01–12:08Z and 13:51–13:58Z. See scripts/make-vkx-fixture.mjs.',
  eventId: EVENT,
  division: DIVISION,
  Fields: KEEP_FIELDS,
  Rows: all.map((r) => KEEP_FIELDS.map((f) => r[f] ?? null)),
};
writeFileSync(`${OUT}/feed.json`, JSON.stringify(feed));
console.log('feed.json', all.length, 'rows,', roRows.length, 'RO');

// ---- the regatta document, trimmed
const reg = JSON.parse(readFileSync(regattaPath, 'utf8'));
const doc = reg.revisions.at(-1).doc;
const div = doc.divisions.find((d) => d.name === DIVISION);
const sails = new Set(all.map((r) => r.sail_number));
const trimmedDoc = {
  name: doc.name,
  startDate: doc.startDate,
  endDate: doc.endDate,
  divisions: [
    {
      name: div.name,
      boatClass: div.boatClass,
      offsetOverrideCm: div.offsetOverrideCm,
      courses: div.courses,
      participants: div.participants.filter((p) => sails.has(p.sailNumber)),
      races: div.races.map((r) => ({
        raceNumber: r.raceNumber,
        isPractice: r.isPractice,
        endTime: r.endTime,
        timezoneOffset: r.timezoneOffset,
        starts: r.starts.map((s) => ({
          startNumber: s.startNumber,
          startTime: s.startTime,
          startLine: s.startLine,
          stopReason: s.stopReason,
          ocsParticipants: (s.ocsParticipants ?? []).filter((x) => sails.has(x)),
          clearedOcs: (s.clearedOcs ?? []).filter((x) => sails.has(x)),
          startingStats: [],
        })),
        finishes: (r.finishes ?? []).filter((f) => sails.has(f.sailNumber)),
      })),
    },
  ],
};
writeFileSync(
  `${OUT}/regatta.json`,
  JSON.stringify({ note: 'Trimmed J/70 Worlds Cascais regatta document (Open division). See scripts/make-vkx-fixture.mjs.', eventId: EVENT, revisions: [{ validFrom: null, doc: trimmedDoc }] }),
);
console.log('regatta.json kept', trimmedDoc.divisions[0].participants.map((p) => p.sailNumber));
