/**
 * Find (or follow a manual `ys=`) the Yachtscoring event for a RaceSense event, pick each
 * division's class, align its races by gun and pair its boats by sail. Network goes through a
 * YsSource (the /api/ys proxy in the app, fixtures in tests). Never throws: a failure is an
 * outcome the race list shows as a chip, and RaceSense numbering stays.
 */
import {
  EVENT_MARGIN,
  alignRaces,
  inferOffset,
  metaScore,
  officialGuns,
  pickClass,
  scoreClass,
  type ClassScore,
  type DivisionInput,
  type EventMeta,
  type RaceAlign,
} from './match';
import { matchBoats, sailKey, type MatchTier } from './sail';
import {
  classKey,
  parseClasses,
  parseResults,
  reportClasses,
  type OfficialClass,
  type OfficialResult,
  type YsEventRow,
  type YsResultReport,
  type YsSource,
} from './yachtscoring';

/** Candidate events worth checking on guns and boats. */
export const META_MIN = 0.35;
const MAX_CANDIDATES = 3;

export interface LinkOverride {
  eventId: number;
  /** A split id or `circle|class` (applies to every division; the best-scoring class otherwise). */
  cls?: string | null;
}

export interface LinkRequest {
  meta: EventMeta;
  /** The RaceSense races' own UTC offset (ms), the prior for the time zone. */
  tzPriorMs: number | null;
  divisions: DivisionInput[];
  override?: LinkOverride | null;
}

export interface BoatPair {
  rs: string;
  ys: string;
  tier: MatchTier;
}

export interface DivisionLink {
  division: string;
  cls: OfficialClass;
  score: Pick<ClassScore, 'guns' | 'sails' | 'total'>;
  races: RaceAlign[];
  /** Official races with no RaceSense race at their gun (UTC): where an unlisted race may be. */
  officialOnly: { number: number; gunMs: number }[];
  /** RaceSense races with no official race. */
  rsOnly: number[];
  /** The first official start (UTC): RaceSense races before it are practice. */
  firstGunMs: number;
  boats: { pairs: BoatPair[]; rsOnly: string[]; ysOnly: string[] };
  /** Results per official race number, keyed by RaceSense sail where the boat pairs (else `ys:<sail>`). */
  results: Record<number, OfficialResultRow[]>;
}

export interface OfficialResultRow extends OfficialResult {
  /** The RaceSense sail this result belongs to, or null when the boat didn't pair. */
  rsSail: string | null;
}

export interface CandidateNote {
  id: number;
  name: string;
  score: number;
}

export type LinkOutcome =
  | {
      status: 'linked';
      eventId: number;
      eventName: string;
      how: 'auto' | 'manual';
      /** Local − UTC for the Yachtscoring wall clock, ms. */
      tzOffsetMs: number;
      divisions: DivisionLink[];
      /** RaceSense divisions with no confident class. */
      unlinked: string[];
    }
  | { status: 'none'; reason: 'off' | 'no-match'; candidates: CandidateNote[] }
  | { status: 'error'; message: string };

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

interface Checked {
  row: YsEventRow;
  meta: number;
  total: number;
  tzOffsetMs: number;
  classes: OfficialClass[];
  picks: Map<string, ClassScore>;
}

/** A class filter from `ysc=`: split id or `circle|class` (case-insensitive). */
const clsFilter = (ysc: string | null | undefined): ((c: OfficialClass) => boolean) => {
  const v = (ysc ?? '').trim();
  if (!v) return () => true;
  if (/^\d+$/.test(v)) return (c) => String(c.splitId) === v;
  return (c) => c.key.toLowerCase() === v.toLowerCase() || c.className.toLowerCase() === v.toLowerCase();
};

export async function linkOfficial(src: YsSource, req: LinkRequest): Promise<LinkOutcome> {
  try {
    return await link(src, req);
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

async function link(src: YsSource, req: LinkRequest): Promise<LinkOutcome> {
  const manual = req.override ?? null;
  let rows: { row: YsEventRow; meta: number }[];
  if (manual) {
    const ev = await src.event(manual.eventId);
    rows = [{ row: { ...ev, id: manual.eventId }, meta: metaScore(req.meta, ev) }];
  } else {
    const found = await src.searchDates(ymd(req.meta.startMs - 10 * 86_400_000), ymd(req.meta.endMs + 86_400_000));
    rows = found.map((row) => ({ row, meta: metaScore(req.meta, row) })).filter((c) => c.meta >= META_MIN);
    if (!rows.length) {
      const q = req.meta.name.replace(/\b(19|20)\d\d\b/g, ' ').replace(/\s+/g, ' ').trim();
      if (q.length >= 3) {
        rows = (await src.searchName(q)).map((row) => ({ row, meta: metaScore(req.meta, row) })).filter((c) => c.meta >= META_MIN);
      }
    }
    rows.sort((a, b) => b.meta - a.meta);
    rows = rows.slice(0, MAX_CANDIDATES);
  }

  const reports = new Map<string, Promise<YsResultReport>>();
  const report = (id: number, n: number): Promise<YsResultReport> => {
    const k = `${id}/${n}`;
    let p = reports.get(k);
    if (!p) reports.set(k, (p = src.results(id, n)));
    return p;
  };

  const checked: Checked[] = [];
  for (const { row, meta } of rows) {
    const classes = parseClasses(await src.races(row.id)).filter(clsFilter(manual?.cls));
    const allWall = classes.flatMap((c) => c.races.map((r) => r.wallMs));
    const allGuns = req.divisions.flatMap((d) => d.races.map((r) => r.gunMs));
    const gmt = classes.flatMap((c) => c.races.map((r) => r.gmtOffsetH)).find((h): h is number => h != null);
    const tz = inferOffset(allWall, allGuns, req.tzPriorMs, gmt != null ? gmt * 3_600_000 : null);
    const picks = new Map<string, ClassScore>();
    let sum = 0;
    for (const div of req.divisions) {
      // Guns first; the entries (from one race report, which lists every class with that race number) for the likeliest few.
      const pre = classes.map((c) => scoreClass(div, c, tz.offsetMs, null)).sort((a, b) => b.total - a.total).slice(0, 4);
      const scored: ClassScore[] = [];
      for (const s of pre) {
        if (s.total <= 0 && !manual) continue;
        const al = alignRaces(div.races, officialGuns(s.cls, tz.offsetMs));
        const n = al[0]?.official ?? s.cls.races[0]?.number;
        const boats = n != null ? reportClasses(await report(row.id, n)).get(s.cls.key) ?? null : null;
        scored.push(scoreClass(div, s.cls, tz.offsetMs, boats ? boats.map((b) => ({ prefix: b.sailPrefix, sail: b.sailNumber ?? '', name: b.name })) : null));
      }
      const pick = pickClass(scored, !!manual);
      if (pick) {
        picks.set(div.name, pick);
        sum += pick.total;
      }
    }
    const total = 0.35 * meta + 0.65 * (req.divisions.length ? sum / req.divisions.length : 0);
    checked.push({ row, meta, total, tzOffsetMs: tz.offsetMs, classes, picks });
  }
  checked.sort((a, b) => b.total - a.total);
  const notes = checked.map((c) => ({ id: c.row.id, name: c.row.name, score: Math.round(c.total * 100) / 100 }));
  const best = checked[0];
  if (!best || !best.picks.size) return { status: 'none', reason: 'no-match', candidates: notes };
  if (!manual && checked[1] && checked[1].picks.size && best.total - checked[1].total < EVENT_MARGIN) {
    return { status: 'none', reason: 'no-match', candidates: notes };
  }

  const divisions: DivisionLink[] = [];
  for (const div of req.divisions) {
    const pick = best.picks.get(div.name);
    if (!pick) continue;
    const cls = pick.cls;
    const guns = officialGuns(cls, best.tzOffsetMs);
    const races = alignRaces(div.races, guns);
    const results: Record<number, OfficialResult[]> = {};
    for (const r of cls.races) {
      const got = parseResults(await report(best.row.id, r.number), cls);
      if (got) results[r.number] = got;
    }
    // Every boat any race lists, once per sail.
    const ysBoats = new Map<string, OfficialResult>();
    for (const rs of Object.values(results)) for (const b of rs) if (!ysBoats.has(sailKey(b.prefix, b.sail) || b.name)) ysBoats.set(sailKey(b.prefix, b.sail) || b.name, b);
    const m = matchBoats(div.boats, [...ysBoats.values()], (x) => x, (b) => ({ prefix: b.prefix, sail: b.sail, name: b.name }));
    const ysName = (b: OfficialResult): string => [b.prefix && !b.sail.toUpperCase().startsWith(b.prefix.toUpperCase()) ? b.prefix : '', b.sail].filter(Boolean).join(' ').trim();
    const pairOf = new Map(m.pairs.map((p) => [sailKey(p.b.prefix, p.b.sail) || p.b.name, p.a.sail]));
    const rows: Record<number, OfficialResultRow[]> = {};
    for (const [n, rs] of Object.entries(results)) rows[Number(n)] = rs.map((b) => ({ ...b, rsSail: pairOf.get(sailKey(b.prefix, b.sail) || b.name) ?? null }));
    const matched = new Set(races.map((a) => a.official));
    const matchedRs = new Set(races.map((a) => a.rsRace));
    divisions.push({
      division: div.name,
      cls,
      score: { guns: pick.guns, sails: pick.sails, total: pick.total },
      races,
      officialOnly: guns.filter((g) => !matched.has(g.number)),
      rsOnly: div.races.filter((r) => !matchedRs.has(r.raceNumber)).map((r) => r.raceNumber),
      firstGunMs: Math.min(...guns.map((g) => g.gunMs)),
      boats: { pairs: m.pairs.map((p) => ({ rs: p.a.sail, ys: ysName(p.b), tier: p.tier })), rsOnly: m.onlyA.map((a) => a.sail), ysOnly: m.onlyB.map(ysName) },
      results: rows,
    });
  }
  return {
    status: 'linked',
    eventId: best.row.id,
    eventName: best.row.name,
    how: manual ? 'manual' : 'auto',
    tzOffsetMs: best.tzOffsetMs,
    divisions,
    unlinked: req.divisions.filter((d) => !best.picks.has(d.name)).map((d) => d.name),
  };
}

export { classKey };
