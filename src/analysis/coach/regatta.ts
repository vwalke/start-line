/**
 * Recall Coach, the Regatta view: one boat across every race of the event the race menu offers
 * (practice left out; rebuilt and tracker-only races in). Each race is analysed on its own (the
 * worker) down to a small digest — the boat's place, its legs against the fleet, and every finding
 * the race's debrief keeps (rank.ts, uncapped) — and the digests are summed up here: the place row,
 * the findings that recur (by seconds at stake and by how many races), the best and worst legs by
 * type, and the three things to work on, by fixed rules. Races the tracker covered poorly are kept
 * and marked, their seconds weighted down. Pure: the UI renders it, the worker builds the digests.
 */
import type { OfficialResultRow } from '../../data/official/link';
import type { FinishSource, RaceData } from '../../data/types';
import type { LegKind, RaceAnalysis } from '../types';
import { coachDebrief } from './debrief';
import { buildCoach, coachRaw, type CoachModel } from './index';
import type { Confidence, DetectorKind } from './opportunity';
import { rankOpportunities } from './rank';

/** A boat's result in one race: its place, or the official code (DNF, …); `of` the fleet it is out of. */
export interface RaceFinish {
  place: number | null;
  code: string | null;
  of: number;
  source: FinishSource;
}

/**
 * The fleet a place is out of, as the results count it: linked to official results, the official
 * fleet (tracked boats they don't list out, listed boats with no track in); else the tracked fleet.
 */
export function fleetOf(a: RaceAnalysis): number {
  const r = a.meta.results;
  if (r?.places !== 'official') return a.boats.length;
  return a.boats.length - (r.trackNoOfficial?.length ?? 0) + (r.officialNoTrack?.length ?? 0);
}

/** Each boat's result in an analysed race, by sail (the places the header and tables show). */
export function analysedFinishes(a: RaceAnalysis): Map<string, RaceFinish> {
  const of = fleetOf(a);
  const places = a.meta.results?.places;
  return new Map(a.boats.map((b) => [b.sail, { place: b.finishPos, code: b.finishCode ?? null, of, source: places ?? b.finishSource ?? 'racesense' }]));
}

/** Below this race coverage a race is marked low data and its seconds weighted down (the Coach header warns below it too). */
export const LOW_COVERAGE = 0.8;
/** A low-data race's seconds count at least this share. */
export const MIN_WEIGHT = 0.2;
/** A race's weight from the boat's coverage of it: 1 from LOW_COVERAGE up, in proportion below (at least MIN_WEIGHT). */
export const coverageWeight = (cov: number | null): number => (cov == null ? 1 : Math.min(1, Math.max(MIN_WEIGHT, cov / LOW_COVERAGE)));

export interface LegDigest {
  leg: number;
  name: string;
  kind: LegKind;
  /** The boat's leg time minus the fleet's median for the leg, s (+ = lost). */
  deltaS: number;
  /** Its rank by leg time among the boats that sailed the leg. */
  rank: number;
  of: number;
  /** The boat's coverage of the leg, 0–1. */
  coverage: number;
  /** A rounding at either end falls in a tracker hole: the leg's time is uncertain (legs.ts timeGapS). */
  timingGap: boolean;
}

export interface FindingDigest {
  theme: string;
  kind: DetectorKind;
  variant: string;
  seconds: number;
  confidence: Confidence;
}

/** One race, one boat. */
export interface RaceDigest {
  /** The race key (the menu's and `race=`). */
  raceNumber: number;
  sail: string;
  /** The boat sailed it with a track. */
  tracked: boolean;
  finish: RaceFinish | null;
  /** The boat's coverage of the race, 0–1; null without a track. */
  coverage: number | null;
  /** Too little tracker data for findings (debrief.ts RACE_MIN_COVERAGE), or no course to measure against. */
  noData: boolean;
  legs: LegDigest[];
  findings: FindingDigest[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The boat's legs against the fleet: time vs the leg's median, rank by leg time. */
export function legDigests(a: RaceAnalysis, sail: string): LegDigest[] {
  const me = a.boats.find((b) => b.sail === sail);
  if (!me) return [];
  const out: LegDigest[] = [];
  a.legs.forEach((leg, k) => {
    const mine = me.legs[k];
    if (!mine || !(mine.timeS > 0)) return;
    const times = a.boats.map((b) => b.legs[k]?.timeS).filter((t): t is number => t != null && t > 0);
    out.push({
      leg: k,
      name: leg.name,
      kind: leg.kind,
      deltaS: mine.timeS - median(times),
      rank: 1 + times.filter((t) => t < mine.timeS).length,
      of: times.length,
      coverage: mine.coverage,
      timingGap: mine.timeGapS != null,
    });
  });
  return out;
}

/** The race's digest for the boat with sail `sail` (its model built from the raw fixes, as the race view's). */
export function raceDigest(a: RaceAnalysis, model: CoachModel | null, sail: string, official: readonly OfficialResultRow[] | null = null): RaceDigest {
  const me = a.boats.find((b) => b.sail === sail);
  const row = official?.find((r) => r.rsSail === sail);
  const finish = me ? (analysedFinishes(a).get(sail) ?? null) : row ? { place: row.code == null ? row.place : null, code: row.code, of: official!.length, source: 'official' as const } : null;
  if (!me) return { raceNumber: a.meta.raceNumber, sail, tracked: false, finish, coverage: null, noData: true, legs: [], findings: [] };
  const d = model ? coachDebrief(a, model, me.id) : null;
  const findings = d && !d.noData ? rankOpportunities(d.found, Infinity).map((c) => ({ theme: themeKey(c.kind, c.variant), kind: c.kind, variant: c.variant, seconds: c.seconds, confidence: c.confidence })) : [];
  return {
    raceNumber: a.meta.raceNumber,
    sail,
    tracked: true,
    finish,
    coverage: d?.raceCov ?? me.coverage,
    noData: !d || d.noData,
    legs: legDigests(a, sail),
    findings,
  };
}

/** The worker's path: the Coach model from the race's raw fixes (as the race view builds it), then the digest. */
export function digestRace(a: RaceAnalysis, data: RaceData, sail: string, official: readonly OfficialResultRow[] | null = null): RaceDigest {
  const raw = a.boats.some((b) => b.sail === sail) ? coachRaw(a, data) : null;
  return raceDigest(a, raw ? buildCoach(a, raw.wind, raw.crossMs) : null, sail, official);
}

// ---- themes: what a finding is about, across races (coarse enough to recur), and what to work on

export interface Theme {
  label: string;
  /** "slow at the gun" in "slow at the gun in 4 of 9 races". */
  phrase: string;
}

/** The areas a sailor works on; a detector's variants within one area recur as one theme. */
export const THEMES: Record<string, Theme> = {
  start: { label: 'Starts: late or back at the gun', phrase: 'late or back from the line at the gun' },
  'gun-speed': { label: 'Slow at the gun', phrase: 'slow at the gun' },
  'after-start': { label: 'First minutes after the start', phrase: 'losing ground in the first minutes' },
  shifts: { label: 'Wrong side of the shifts', phrase: 'on the wrong side of a shift' },
  leader: { label: 'Let the leaders go', phrase: 'level with a leader, then let go' },
  gains: { label: 'Gave back gains from a side', phrase: 'giving back a gain from a side' },
  upwind: { label: 'Upwind speed and height', phrase: 'slow upwind' },
  downwind: { label: 'Downwind angles and speed', phrase: 'slow downwind' },
  'last-leg': { label: 'The last leg', phrase: 'losing out on the last leg' },
};

/** A finding's theme. */
export function themeKey(kind: DetectorKind, variant: string): string {
  switch (kind) {
    case 'D1':
      return 'start';
    case 'D2':
      return 'gun-speed';
    case 'D3':
      return variant === 'slow-start' ? 'gun-speed' : 'after-start';
    case 'D4':
      return 'shifts';
    case 'D5':
      return variant === 'caught-leader' ? 'leader' : 'gains';
    case 'D6':
      return 'upwind';
    case 'D7':
      return 'downwind';
    case 'D10':
      return 'last-leg';
  }
}
export const themeOf = (key: string): Theme => THEMES[key] ?? { label: key, phrase: key };

/** What to work on, by detector and variant (the race cards' tips, coachCards.ts, in short); the theme's tip is its costliest variant's. */
const TIPS: Record<string, string> = {
  'D1:late': 'Time the final approach so you hit the line at the gun, at full speed.',
  'D1:second-row': 'Set up closer to the line and own your gap to leeward.',
  D2: 'Hit the line at full speed. If pinned, foot a length before tacking.',
  'D3:slow-start': 'Hit the line at full speed. If pinned, foot a length before tacking.',
  'D3:tacks': 'Pick one lane off the line and stay in it; tack only into a clear lane.',
  'D3:lane': 'Sail fast in a clear lane first; foot off rather than pinch in dirty air.',
  D4: 'When the wind keeps going one way, sail the lifted tack toward it; on a header over 30 s, tack.',
  'D5:caught-leader': 'Once level with the leader, stay between them and the mark.',
  'D5:overstand': 'When the corner pays, tack on the next header and come back; avoid early laylines.',
  'D5:banked': 'Bank gains: tack on the header and get back between the fleet and the mark.',
  'D6:high-slow': 'Ease a touch and sail for speed; height comes once the boat is moving.',
  'D6:low-fast': 'You have the speed: trim for height and point higher.',
  'D6:slow': 'Check trim and weight against the boats around you; change one thing at a time.',
  'D7:deep': 'Sail hotter in the lulls and soak low only in the puffs; gybe on the angle.',
  'D7:hot': 'Soak lower in the puffs: the speed was there, the extra distance cost it.',
  'D7:slow': 'Keep someone calling pressure and gybe into the puffs.',
  'D10:beat': 'Sail the lifted tack and stay between the boats just ahead and the finish.',
  'D10:run': 'Keep someone calling pressure and gybe into the puffs.',
};
export const tipOf = (kind: DetectorKind, variant: string): string => TIPS[`${kind}:${variant}`] ?? TIPS[kind] ?? '';

// ---- the summary

/** One race of the regatta: the menu's race, and its digest once analysed. */
export interface RegattaRace {
  raceNumber: number;
  /** The menu's name, short (`R7`) and whole ("Race 7"). */
  label: string;
  name: string;
  status: 'pending' | 'running' | 'done' | 'error';
  digest: RaceDigest | null;
  error?: string;
}

export interface RecurringFinding {
  theme: string;
  label: string;
  phrase: string;
  /** The tip of its costliest variant (tipOf). */
  tip: string;
  /** Races it was found in, of the races with findings data. */
  races: number;
  of: number;
  /** Seconds at stake summed, and weighted by each race's coverage. */
  totalS: number;
  weightedS: number;
  /** Of `races`, how many had low tracker coverage. */
  lowRaces: number;
  raceLabels: string[];
}

export interface LegExtreme {
  label: string;
  leg: string;
  deltaS: number;
  rank: number;
  of: number;
  low: boolean;
}

export interface LegTypeSummary {
  kind: LegKind;
  legs: number;
  /** Mean time vs the fleet's median per leg, weighted by coverage, s (+ = lost), and the weighted sum. */
  meanS: number;
  weightedS: number;
  best: LegExtreme;
  worst: LegExtreme;
}

export interface WorkOn {
  /** The finding's theme, or `legs:<kind>` for a leg type. */
  theme: string;
  title: string;
  why: string;
  tip: string;
  /** What ranks it: weighted seconds over the regatta. */
  score: number;
}

export interface RegattaSummary {
  rows: (RegattaRace & { low: boolean; weight: number })[];
  /** Races analysed (done), and the races with findings data (tracked, enough coverage). */
  done: number;
  withData: number;
  total: number;
  findings: RecurringFinding[];
  legs: LegTypeSummary[];
  top: WorkOn[];
}

/** A finding counts as recurring from this many races… */
export const RECUR_RACES = 2;
/** …or from this many weighted seconds in one. */
export const RECUR_SOLO_S = 30;
/** A leg type is worth working on from this much lost per leg (weighted mean), s. */
export const LEG_WORK_S = 10;
export const TOP_WORK = 3;

const LEG_WORDS: Record<LegKind, { one: string; many: string; tip: string }> = {
  upwind: { one: 'beat', many: 'beats', tip: 'Upwind: work on speed in a clear lane, then on the shifts; compare trim with the boats that gain on you.' },
  downwind: { one: 'run', many: 'runs', tip: 'Downwind: sail the pressure, gybe on the angle, and keep someone calling the puffs.' },
  reach: { one: 'reach', many: 'reaches', tip: 'Reaches: sail the fastest angle and defend your lane early; avoid luffing matches.' },
};
export const legWord = (k: LegKind, n: number): string => (n === 1 ? LEG_WORDS[k].one : LEG_WORDS[k].many);

/** A leg's own weight: its coverage (as a race's), and MIN_WEIGHT when a rounding falls in a hole. */
export const legWeight = (l: Pick<LegDigest, 'coverage' | 'timingGap'>): number => (l.timingGap ? MIN_WEIGHT : coverageWeight(l.coverage));
/** Best and worst legs come from legs weighted at least this much, when there are any. */
export const SOLID_LEG = 0.5;

export function summarizeRegatta(races: readonly RegattaRace[]): RegattaSummary {
  const rows = races.map((r) => {
    const cov = r.digest?.coverage ?? null;
    return { ...r, low: r.digest?.tracked === true && cov != null && cov < LOW_COVERAGE, weight: coverageWeight(cov) };
  });
  const done = rows.filter((r) => r.status === 'done' && r.digest);
  const withData = done.filter((r) => r.digest!.tracked && !r.digest!.noData);

  // Findings by theme: once per race (a theme twice in a race sums), weighted by the race's coverage.
  const byTheme = new Map<string, RecurringFinding>();
  /** Weighted seconds per detector variant within each theme, for the tip. */
  const variants = new Map<string, Map<string, { s: number; tip: string }>>();
  for (const r of withData) {
    const sums = new Map<string, number>();
    for (const f of r.digest!.findings) {
      sums.set(f.theme, (sums.get(f.theme) ?? 0) + f.seconds);
      const vs = variants.get(f.theme) ?? new Map<string, { s: number; tip: string }>();
      const k = `${f.kind}:${f.variant}`;
      vs.set(k, { s: (vs.get(k)?.s ?? 0) + f.seconds * r.weight, tip: tipOf(f.kind, f.variant) });
      variants.set(f.theme, vs);
    }
    for (const [theme, sec] of sums) {
      const t = themeOf(theme);
      const cur = byTheme.get(theme) ?? { theme, label: t.label, phrase: t.phrase, tip: '', races: 0, of: withData.length, totalS: 0, weightedS: 0, lowRaces: 0, raceLabels: [] };
      cur.races += 1;
      cur.totalS += sec;
      cur.weightedS += sec * r.weight;
      if (r.low) cur.lowRaces += 1;
      cur.raceLabels.push(r.label);
      byTheme.set(theme, cur);
    }
  }
  for (const f of byTheme.values()) f.tip = [...variants.get(f.theme)!.entries()].sort((p, q) => q[1].s - p[1].s || p[0].localeCompare(q[0]))[0][1].tip;
  const findings = [...byTheme.values()].sort((p, q) => q.weightedS - p.weightedS || q.races - p.races || p.label.localeCompare(q.label));

  // Legs by type: weighted mean vs the fleet's median (a poorly covered leg, or one timed across a hole, counts less),
  // and the best and worst single leg, from the well-covered legs when there are any.
  const legs: LegTypeSummary[] = [];
  for (const kind of ['upwind', 'downwind', 'reach'] as LegKind[]) {
    const all = done.flatMap((r) => r.digest!.legs.filter((l) => l.kind === kind).map((l) => ({ r, l, w: r.weight * legWeight(l) })));
    if (!all.length) continue;
    const wsum = all.reduce((sum, x) => sum + x.w, 0);
    const weightedS = all.reduce((sum, x) => sum + x.l.deltaS * x.w, 0);
    const ext = (x: (typeof all)[number]): LegExtreme => ({ label: x.r.label, leg: x.l.name, deltaS: x.l.deltaS, rank: x.l.rank, of: x.l.of, low: x.r.low || legWeight(x.l) < 1 });
    const solid = all.filter((x) => x.w >= SOLID_LEG);
    const sorted = [...(solid.length ? solid : all)].sort((p, q) => p.l.deltaS - q.l.deltaS);
    legs.push({ kind, legs: all.length, meanS: weightedS / wsum, weightedS, best: ext(sorted[0]), worst: ext(sorted[sorted.length - 1]) });
  }

  // The rules: recurring findings (≥ RECUR_RACES races, or ≥ RECUR_SOLO_S weighted in one), and the leg type that costs the most per leg.
  const top: WorkOn[] = findings
    .filter((f) => f.races >= RECUR_RACES || f.weightedS >= RECUR_SOLO_S)
    .map((f) => ({ theme: f.theme, title: f.label, why: `${cap(f.phrase)} in ${f.races} of ${f.of} races, ~${Math.round(f.totalS)} s total${f.lowRaces ? ` (${f.lowRaces} with low tracker data)` : ''}`, tip: f.tip, score: f.weightedS }));
  const worstType = [...legs].filter((l) => l.legs >= RECUR_RACES && l.meanS >= LEG_WORK_S).sort((p, q) => q.weightedS - p.weightedS)[0];
  // …unless a finding about the same legs (the upwind or downwind theme) already says it.
  if (worstType && !top.some((t) => t.theme === worstType.kind)) {
    const w = LEG_WORDS[worstType.kind];
    top.push({
      theme: `legs:${worstType.kind}`,
      title: cap(w.many),
      why: `~${Math.round(worstType.meanS)} s lost per ${w.one} vs the fleet's median, over ${worstType.legs} ${legWord(worstType.kind, worstType.legs)}`,
      tip: w.tip,
      score: worstType.weightedS,
    });
  }
  top.sort((p, q) => q.score - p.score || p.title.localeCompare(q.title));

  return { rows, done: done.length, withData: withData.length, total: rows.length, findings, legs, top: top.slice(0, TOP_WORK) };
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
