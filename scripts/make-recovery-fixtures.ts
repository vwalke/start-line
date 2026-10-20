/**
 * Builds the offline fixtures for race recovery + official results (tests/fixtures/recovery/).
 * Needs the network once (gently: ≤ 1 request/s, UA StartLine/1, responses cached on disk), then never:
 *
 *   npx vite-node scripts/make-recovery-fixtures.ts -- <cache-dir>
 *
 * It runs the app's own code (src/data/…) against live data and saves what the tests replay:
 *   - ys/*.json: the Yachtscoring responses the linker asks for (owner/crew fields stripped,
 *     as the proxy does) for J/105 CBC (50575), AYC Fall Series (50574) and the J/70 Worlds
 *     date window (no event there);
 *   - j70_probes.json / ayc_probes.json: every telemetry probe the orphan discovery makes, each
 *     trimmed to the first row per device and stage (all the stage rule reads) plus the
 *     start-line trackers;
 *   - j70_or<N>.json (official races 3, 4, 7, 8): the finishing band of every boat whose track
 *     crosses the finish line, ±60 s around its crossing at ≤ 1 Hz, its first `in_progress` and
 *     first `finishing` rows, and the finish-line trackers every 5 s; or8 also has 8 boats
 *     every 2 s around the gun (to analyse the rebuilt race), or4 5 boats plus the three scored DNC
 *     that sat 4.9 km from the line;
 *   - ayc_j105_r1.json: AYC J105 race 1, all 19 boats every 2 s around the gun and ±2 min of
 *     their official finish, every 30 s in between, the line trackers every 5 s.
 * The RaceSense regatta documents (rs_*.json) are the operator's saved copies.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripPersonal } from '../functions/_lib';
import { crossings, feedRaceNumber, fleetOnsetFloor, lineFrom, trackerFinish, type MarkSeries } from '../src/data/finishes';
import { linkOfficial } from '../src/data/official/link';
import type { YsSource } from '../src/data/official/yachtscoring';
import { discoverOrphans, type FetchRows, type ProbeRow } from '../src/data/orphans';
import { buildRaceList } from '../src/data/raceList';
import { currentDoc, nextGunMs, parseTelemetry, snFromHex } from '../src/data/racesense/adapter';
import type { RegattaResponse, TelemetryPage } from '../src/data/racesense/types';
import { linkRequest, orphanContexts } from '../src/data/recovery';

const UA = 'StartLine/1 (+https://walkeforward.com)';
const CACHE = process.argv.slice(2).find((a) => a !== '--') ?? '../scratch/feed-node';
const OUT = 'tests/fixtures/recovery';
const FIELDS = ['ts', 'sn', 'sail_number', 'role', 'latitude', 'longitude', 'sog', 'heading', 'race_number', 'race_stage'];
mkdirSync(CACHE, { recursive: true });
mkdirSync(join(OUT, 'ys'), { recursive: true });

let last = 0;
async function getJson<T>(url: string): Promise<T> {
  const file = join(CACHE, createHash('sha1').update(url).digest('hex').slice(0, 20) + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as T;
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  last = Date.now();
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const text = await res.text();
  writeFileSync(file, text);
  return JSON.parse(text) as T;
}

/** The YS key the tests' fixture source uses for a path. */
export const ysFile = (path: string): string => path.replace(/[^A-Za-z0-9._-]+/g, '_') + '.json';

function recordingYs(): YsSource {
  const get = async <T>(path: string): Promise<T> => {
    const body = stripPersonal(await getJson(`https://api.yachtscoring.com/v1/public/${path}`)) as T;
    writeFileSync(join(OUT, 'ys', ysFile(path)), JSON.stringify(body));
    return body;
  };
  return {
    searchDates: async (gte, lte) => (await get<{ rows?: never[] }>(`event?startDate_gte=${gte}&startDate_lte=${lte}&sort=startDate.desc&size=100`)).rows ?? [],
    searchName: async (q) => (await get<{ rows?: never[] }>(`event?name_contains=${encodeURIComponent(q)}&sort=startDate.desc&size=40`)).rows ?? [],
    event: (id) => get(`event/${id}`),
    races: async (id) => (await get<{ rows?: never[] }>(`event/${id}/races?size=200`)).rows ?? [],
    results: (id, n) => get(`event/${id}/result-detail-report?raceNumber=${n}`),
  };
}

async function tele(ev: string, a: number, b: number, division: string | null): Promise<TelemetryPage[]> {
  const pages: TelemetryPage[] = [];
  let cur = Math.floor(a);
  for (let n = 0; n < 12; n++) {
    const u = `https://teleapi.regatta.app/telemetry/event/${ev}?after=${cur}&before=${Math.floor(b)}&limit=100000${division ? `&division=${encodeURIComponent(division)}` : ''}`;
    const p = await getJson<TelemetryPage>(u);
    pages.push(p);
    if (!p.Fields || !p.Rows || p.Rows.length < 100_000) break;
    const ts = p.Fields.indexOf('ts');
    const lastTs = Number(p.Rows[p.Rows.length - 1][ts]);
    if (!(lastTs > cur + 1)) break;
    cur = lastTs - 1;
  }
  return pages;
}

type Raw = (string | number | null)[];
/** Pages → one page of the kept columns. */
function slim(pages: TelemetryPage[], keep: (r: Record<string, unknown>) => boolean): TelemetryPage {
  const rows: Raw[] = [];
  for (const p of pages) {
    if (!p.Fields || !p.Rows) continue;
    const ix = FIELDS.map((f) => p.Fields!.indexOf(f));
    for (const r of p.Rows) {
      const o = Object.fromEntries(p.Fields.map((f, i) => [f, r[i]]));
      if (!keep(o)) continue;
      rows.push(ix.map((i) => (i < 0 ? null : r[i])));
    }
  }
  rows.sort((x, y) => Number(x[0]) - Number(y[0]));
  return { Fields: FIELDS, Rows: rows };
}

/** One page from rows already filtered by identity (sn|role|ts). */
function pageOf(pages: TelemetryPage[], ids: Set<string>): TelemetryPage {
  return slim(pages, (o) => ids.has(`${o.sn}|${o.role}|${o.ts}`));
}

/** A probe trimmed: the first and last row per device, race and stage (all the stage rule and the "boats moving" check read), plus the given trackers. */
function trimProbe(pages: TelemetryPage[], marks: Set<number>): TelemetryPage {
  const first = new Map<string, number>();
  const lastTs = new Map<string, number>();
  for (const p of pages) {
    if (!p.Fields || !p.Rows) continue;
    const [sn, role, rn, st, ts] = ['sn', 'role', 'race_number', 'race_stage', 'ts'].map((f) => p.Fields!.indexOf(f));
    for (const r of p.Rows) {
      if (r[role] !== 'competitor') continue;
      const k = `${r[sn]}|${r[rn]}|${r[st]}`;
      const t = Number(r[ts]);
      if (!(first.get(k)! <= t)) first.set(k, t);
      if (!(lastTs.get(k)! >= t)) lastTs.set(k, t);
    }
  }
  return slim(pages, (o) => {
    if (o.role === 'mark') return marks.has(Number(o.sn));
    if (o.role !== 'competitor') return false;
    const k = `${o.sn}|${o.race_number}|${o.race_stage}`;
    return first.get(k) === Number(o.ts) || lastTs.get(k) === Number(o.ts);
  });
}

function recordingProbes(ev: string, marks: Set<number>, store: Record<string, TelemetryPage>): FetchRows {
  return async (a, b, division) => {
    const pages = await tele(ev, a, b, division);
    const t = trimProbe(pages, marks);
    store[`${a}|${b}|${division ?? ''}`] = t;
    return parseTelemetry([t]);
  };
}

const doc = (f: string): RegattaResponse => JSON.parse(readFileSync(join(OUT, f), 'utf8')) as RegattaResponse;
const save = (f: string, x: unknown): void => {
  writeFileSync(join(OUT, f), JSON.stringify(x));
  console.log(f, (JSON.stringify(x).length / 1024).toFixed(0), 'KB');
};

/** Device series from parsed rows. */
function series(rows: ProbeRow[], hex: string): MarkSeries {
  const sn = snFromHex(hex);
  const s: MarkSeries = { t: [], lat: [], lon: [] };
  for (const r of rows) {
    if (r.role !== 'mark' || r.sn !== sn) continue;
    s.t.push(r.ts);
    s.lat.push(r.lat);
    s.lon.push(r.lon);
  }
  return s;
}

const OR4_AWAY = ['GBR 1591', 'TUR 442', 'POL 1588'];
async function j70(): Promise<void> {
  const EV = 'oRkxbTpSZPbSkrmKrbj2';
  const resp = doc('rs_j70.json');
  const d = currentDoc(resp);
  // No Yachtscoring event: the linker's search, for the record.
  const outcome = await linkOfficial(recordingYs(), linkRequest(d, { venue: 'Cascais, Portugal', startMs: d.startDate ?? 0, endMs: d.endDate ?? 0 }));
  console.log('J/70 link:', outcome.status);
  const list = buildRaceList(d);
  const [ctx] = orphanContexts(d, list, null);
  const startMarks = new Set([snFromHex('0238004DAB'), snFromHex('0238006457')]);
  const store: Record<string, TelemetryPage> = {};
  const res = await discoverOrphans(ctx, recordingProbes(EV, startMarks, store));
  console.log('J/70 orphans', res.found.map((f) => [f.key, new Date(f.trueGunMs).toISOString(), f.feedRaceNumber]), 'used', res.used);
  save('j70_probes.json', { note: 'Recorded probes of the orphan discovery (scripts/make-recovery-fixtures.ts).', probes: store, found: res.found });

  const races: [string, number, number][] = [
    ['or3', d.divisions[0].races.find((r) => r.raceNumber === 4)!.starts.at(-1)!.startTime!, 3],
    ['or7', d.divisions[0].races.find((r) => r.raceNumber === 7)!.starts.at(-1)!.startTime!, 7],
    ...res.found.map((f): [string, number, number] => [new Date(f.gunMs).getUTCDate() === 9 ? 'or4' : 'or8', f.gunMs, new Date(f.gunMs).getUTCDate() === 9 ? 4 : 8]),
  ];
  const guns = d.divisions[0].races.map((r) => r.starts.at(-1)?.startTime ?? 0).concat(res.found.map((f) => f.gunMs));
  for (const [label, gun, official] of races) {
    const next = Math.min(...guns.filter((g) => g > gun + 60_000), Infinity);
    const end = Math.min(gun + 2 * 3_600_000, next - 60_000);
    const early = await tele(EV, gun + 5 * 60_000, gun + 5 * 60_000 + 10_000, 'Open');
    const band = await tele(EV, gun + 40 * 60_000, end, 'Open');
    const atGun = label === 'or8' || label === 'or4' ? await tele(EV, gun - 130_000, gun + 120_000, 'Open') : [];
    const rows = parseTelemetry([...early, ...band]);
    const finish = lineFrom(series(rows, '0238006457'), series(rows, '0238006427'));
    const bySn = new Map<number, ProbeRow[]>();
    for (const r of rows) if (r.role === 'competitor') (bySn.get(r.sn) ?? bySn.set(r.sn, []).get(r.sn)!).push(r);
    const rn = feedRaceNumber(bySn.values(), gun);
    const floor = fleetOnsetFloor(bySn.values(), gun, rn);
    const keep = new Set<string>();
    let first = Infinity;
    let lastX = -Infinity;
    const crossedSns: number[] = [];
    for (const [sn, fx] of bySn) {
      const t = trackerFinish(fx, finish, gun, end, rn, floor);
      if (t == null) continue;
      crossedSns.push(sn);
      first = Math.min(first, t);
      lastX = Math.max(lastX, t);
      const ip = fx.find((f) => f.stage === 'in_progress' && f.ts >= gun);
      const onset = fx.find((f) => f.ts >= gun && (f.stage === 'finishing' || f.stage === 'finished') && (rn == null || f.rn === rn));
      for (const f of [ip, onset]) if (f) keep.add(`${sn}|competitor|${f.ts}`);
      let lastKept = -Infinity;
      for (const f of fx) {
        if (Math.abs(f.ts - t) > 60_000 || f.ts - lastKept < 1000) continue;
        keep.add(`${sn}|competitor|${f.ts}`);
        lastKept = f.ts;
      }
    }
    const markLast = new Map<number, number>();
    for (const r of rows) {
      if (r.role !== 'mark' || ![snFromHex('0238006457'), snFromHex('0238006427')].includes(r.sn) || r.ts < first - 120_000 || r.ts > lastX + 120_000) continue;
      if (r.ts - (markLast.get(r.sn) ?? -Infinity) < 5000) continue;
      markLast.set(r.sn, r.ts);
      keep.add(`${r.sn}|mark|${r.ts}`);
    }
    const page = pageOf([...early, ...band], keep);
    let gunPage: TelemetryPage | null = null;
    if (atGun.length) {
      const g = parseTelemetry(atGun);
      // or4: also the three boats scored DNC that sat 4.9 km from the line (not in the race).
      const away = new Set(g.filter((r) => label === 'or4' && OR4_AWAY.includes(r.sail)).map((r) => r.sn));
      const pick = new Set([...crossedSns.slice(0, label === 'or4' ? 5 : 8), ...away]);
      const ids = new Set<string>();
      const lastBy = new Map<string, number>();
      for (const r of g) {
        const k = `${r.sn}|${r.role}`;
        const ok = r.role === 'competitor' ? pick.has(r.sn) : startMarks.has(r.sn) || [snFromHex('0238006427')].includes(r.sn);
        if (!ok || r.ts - (lastBy.get(k) ?? -Infinity) < 2000) continue;
        lastBy.set(k, r.ts);
        ids.add(`${r.sn}|${r.role}|${r.ts}`);
      }
      gunPage = pageOf(atGun, ids);
    }
    save(`j70_${label}.json`, { note: `J/70 Worlds official race ${official}: finishing band (scripts/make-recovery-fixtures.ts).`, official, gunMs: gun, endMs: end, feedRaceNumber: rn, onsetFloorMs: floor, telemetry: page, ...(gunPage ? { atGun: gunPage } : {}) });
  }
}

async function ayc(): Promise<void> {
  const EV = 'sxuoKnv1CVM8Swq8L3gZ';
  const resp = doc('rs_aycfs.json');
  const d = currentDoc(resp);
  const outcome = await linkOfficial(recordingYs(), linkRequest(d, { venue: 'Annapolis, MD', startMs: d.startDate ?? 0, endMs: d.endDate ?? 0 }));
  console.log('AYC link:', outcome.status, outcome.status === 'linked' ? outcome.divisions.map((x) => [x.division, x.cls.key, x.races]) : outcome);
  const list = buildRaceList(d, {});
  const store: Record<string, TelemetryPage> = {};
  const marks = new Set([snFromHex('0238007080'), snFromHex('023800705A')]);
  for (const ctx of orphanContexts(d, list, outcome)) {
    const res = await discoverOrphans(ctx, recordingProbes(EV, marks, store));
    console.log('AYC orphans', ctx.division, res.found, 'used', res.used);
  }
  save('ayc_probes.json', { note: 'Recorded probes of the orphan discovery, linked to Yachtscoring 50574 (scripts/make-recovery-fixtures.ts).', probes: store });

  // J105 race 1 with the official finishes.
  const r1 = d.divisions.find((x) => x.name === 'J105')!.races.find((r) => r.raceNumber === 1)!;
  const gun = r1.starts.at(-1)!.startTime!;
  const end = nextGunMs(d, { division: 'J105', raceNumber: 1 })! - 60_000;
  const pages = await tele(EV, gun - 130_000, end, 'J105');
  const rows = parseTelemetry(pages);
  const off = outcome.status === 'linked' ? outcome.divisions.find((x) => x.division === 'J105')!.results[1] : [];
  const tz = outcome.status === 'linked' ? outcome.tzOffsetMs : -4 * 3_600_000;
  const finBySail = new Map(off.filter((o) => o.rsSail && o.finishWallMs != null).map((o) => [o.rsSail!, o.finishWallMs! - tz]));
  const ids = new Set<string>();
  const lastBy = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.sn}|${r.role}`;
    const prev = lastBy.get(k) ?? -Infinity;
    let step = 30_000;
    if (r.role === 'mark') step = marks.has(r.sn) ? 5000 : Infinity;
    else if (r.role === 'competitor') {
      const f = finBySail.get(r.sail);
      if (r.ts <= gun + 60_000 || (f != null && Math.abs(r.ts - f) <= 120_000)) step = 2000;
    } else step = Infinity;
    if (r.ts - prev < step) continue;
    lastBy.set(k, r.ts);
    ids.add(`${r.sn}|${r.role}|${r.ts}`);
  }
  const page = pageOf(pages, ids);
  const check = parseTelemetry([page]);
  const line = lineFrom(series(check, '0238007080'), series(check, '023800705A'));
  const gaps = [...finBySail].map(([sail, t]) => {
    const fx = check.filter((r) => r.role === 'competitor' && r.sail === sail);
    const xs = crossings(fx, line, gun, end);
    return xs.length ? Math.min(...xs.map((x) => Math.abs(x - t))) / 1000 : null;
  });
  console.log('AYC J105 R1 official vs crossing (s):', gaps.map((g) => (g == null ? '-' : g.toFixed(0))).join(' '));
  save('ayc_j105_r1.json', { note: 'AYC Fall Series 2026, J105 race 1 (official race 1), trimmed (scripts/make-recovery-fixtures.ts).', eventId: EV, telemetry: page });
}

async function cbc(): Promise<void> {
  const d = currentDoc(doc('rs_j105.json'));
  const outcome = await linkOfficial(recordingYs(), linkRequest(d, { venue: 'Annapolis, MD', startMs: d.startDate ?? 0, endMs: d.endDate ?? 0 }));
  console.log('J/105 CBC link:', outcome.status, outcome.status === 'linked' ? outcome.divisions.map((x) => [x.division, x.cls.key, x.races, x.boats.rsOnly, x.boats.ysOnly]) : outcome);
}

await cbc();
await ayc();
await j70();
