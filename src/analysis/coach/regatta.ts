/**
 * Recall Coach, the Regatta view: one boat across every race of the event the race menu offers
 * (practice left out; rebuilt and tracker-only races in). Each race is analysed on its own (the
 * worker) down to a small digest — the boat's place, its legs against the fleet, and every finding
 * the race's debrief keeps (rank.ts, uncapped) — and the digests are summed up here: the place row,
 * the findings that recur (by seconds at stake and by how many races; the side of the course D14, speed without progress
 * D15 and the line bias D16 are themes like the others; a data-gated detector — D8
 * dirty air, D9 roundings, D11 heel — counts only the races it had the data to measure), the best and worst
 * legs by type, the three things to work on (pattern cards for what recurs), and what went well,
 * by fixed rules. Races the tracker covered poorly are kept
 * and marked, their seconds weighted down. Penalties (official codes, and penalty turns D12) are a row of their own
 * (penaltiesOf): never a theme, a pattern card or a thing to work on by seconds. Pure: the UI renders it, the worker
 * builds the digests.
 */
import type { OfficialResultRow } from '../../data/official/link';
import type { FinishSource, RaceData } from '../../data/types';
import type { LegKind, RaceAnalysis } from '../types';
import type { GoodNote, Opportunity } from './opportunity';
import { coachDebrief } from './debrief';
import { fleetOf } from './fleet';
import { buildCoach, coachRaw, type CoachModel } from './index';
import type { Confidence, DetectorKind } from './opportunity';
import { confidenceOf } from './opportunity';
import { rankOpportunities } from './rank';
import { codeInfo } from '../../data/official/codes';
import { turnSeconds } from './penalty';

export { fleetOf } from './fleet';

/** A boat's result in one race: its place, or the official code (DNF, …); `of` the fleet it is out of. */
export interface RaceFinish {
  place: number | null;
  code: string | null;
  of: number;
  source: FinishSource;
  /** A coded result's official score (points); a boat that finished with a code: its on-water place and the places the code cost. */
  points?: number | null;
  onWater?: number | null;
  penaltyPlaces?: number | null;
}

/** Each boat's result in an analysed race, by sail (the places the header and tables show). */
export function analysedFinishes(a: RaceAnalysis): Map<string, RaceFinish> {
  const of = fleetOf(a);
  const places = a.meta.results?.places;
  return new Map(
    a.boats.map((b) => [
      b.sail,
      {
        place: b.finishPos,
        code: b.finishCode ?? null,
        of,
        source: places ?? b.finishSource ?? 'racesense',
        ...(b.finishCode && b.scoredPoints != null ? { points: b.scoredPoints } : {}),
        ...(b.onWaterPlace != null ? { onWater: b.onWaterPlace, penaltyPlaces: b.penaltyPlaces ?? null } : {}),
      },
    ]),
  );
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

const CONF_ORDER: Confidence[] = ['none', 'low', 'medium', 'high'];

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
  /** Themes of the data-gated detectors that had enough data in this race ('dirty-air', 'round-leeward', …). */
  evaluated?: string[];
  /** ➕ Went well in this race (the race view's), most seconds first. */
  went?: WentDigest[];
  /** Penalty turns found on the track (D12: on the penalty card or a card of their own): how many loops and their seconds. */
  turns?: { loops: number; seconds: number };
}

/** One ➕ of a race: its family ('start', 'leg:upwind', 'round:leeward', …), what it was, the seconds gained. */
export interface WentDigest {
  family: string;
  /** "Beat 2", "Leeward gate", "Start". */
  label: string;
  seconds: number;
}

/** A ➕'s family and label, for the Regatta view. */
export function wentOf(a: Pick<RaceAnalysis, 'legs'>, n: GoodNote): WentDigest {
  const f = n.facts;
  const seconds = n.seconds ?? 0;
  if (n.detector === 'D9') return { family: `round:${n.variant}`, label: String(f.mark ?? 'Mark'), seconds };
  if (n.detector === 'D13') return { family: 'round:gate', label: String(f.mark ?? 'Leeward gate'), seconds };
  if (n.detector === 'D1' || n.detector === 'D3') return { family: 'start', label: n.detector === 'D1' ? 'Start' : 'First minutes', seconds };
  if (n.detector === 'D16') return { family: 'start', label: 'Start: favoured end', seconds };
  if (n.detector === 'D14') return { family: 'side', label: String(f.leg ?? 'Leg'), seconds };
  if (n.detector === 'D11') return { family: `heel:${f.legKind === 'downwind' ? 'downwind' : 'upwind'}`, label: String(f.leg ?? 'Leg'), seconds };
  const leg = a.legs.find((l) => l.name === f.leg);
  return { family: `leg:${leg?.kind ?? 'upwind'}`, label: String(f.leg ?? 'Leg'), seconds };
}

/** The themes a data-gated detector's findings fall in: what the race had data for (D8, each kind of mark D9 timed, the legs D11 compared heel on, a gate D13 judged). */
export const evaluatedThemes = (q: { D8: boolean; D9: readonly string[]; D11?: readonly string[]; D13?: boolean }): string[] => [
  ...(q.D8 ? ['dirty-air'] : []),
  ...q.D9.map((t) => `round-${t}`),
  ...(q.D13 ? [GATE_THEME] : []),
  ...(q.D11 ?? []).flatMap((k) => HEEL_THEMES[k] ?? []),
];
/** Gate choice (D13): a subtheme of the leeward roundings (its own "of N": the races D13 judged a gate in). */
export const GATE_THEME = 'round-leeward-gate';
/** The heel themes each kind of leg D11 compared can measure. */
const HEEL_THEMES: Record<string, string[]> = { upwind: ['heel-over', 'heel-under'], downwind: ['heel-down'] };
/** A theme only some races can measure: its "of N races" counts those races only. */
export const gatedTheme = (theme: string): boolean => theme === 'dirty-air' || theme.startsWith('round-') || theme.startsWith('heel-');

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
  const finish = me
    ? (analysedFinishes(a).get(sail) ?? null)
    : row
      ? {
          place: row.code == null ? row.place : null,
          code: row.code,
          of: official!.length,
          source: 'official' as const,
          ...(row.code != null && row.points != null ? { points: row.points } : {}),
          ...(row.code != null && row.onWater != null ? { onWater: row.onWater, penaltyPlaces: row.penaltyPlaces ?? null } : {}),
        }
      : null;
  if (!me) return { raceNumber: a.meta.raceNumber, sail, tracked: false, finish, coverage: null, noData: true, legs: [], findings: [] };
  const d = model ? coachDebrief(a, model, me.id) : null;
  // Penalty turns (D12) are a penalty, never a theme: they go to the Penalties row (`turns`), not the findings.
  const ranked = d && !d.noData ? rankOpportunities(d.found, Infinity) : [];
  // The side of the course (D14) is one card a race: the other legs on the side that didn't pay ride on it (`alsoS`) and count here.
  const findings: FindingDigest[] = ranked
    .filter((c) => c.kind !== 'D12')
    .map((c) => ({ theme: themeKey(c.kind, c.variant), kind: c.kind, variant: c.variant, seconds: c.seconds + alsoSeconds(c), confidence: c.confidence }));
  const loops = d && !d.noData ? (d.penalty?.turns ?? model?.turns?.get(me.id) ?? []) : [];
  const turns = loops.length ? { loops: loops.length, seconds: turnSeconds(loops) } : null;
  // D8 as a chip (on D3, or with no card to carry it) still recurs as a theme; its seconds are D3's, not counted twice.
  if (d && !d.noData && d.dirtyAir.chip && !findings.some((f) => f.kind === 'D8')) findings.push({ theme: 'dirty-air', kind: 'D8', variant: 'chip', seconds: 0, confidence: 'medium' });
  // D11 riding on a D6 / D7 card, or found but under a card's minimum seconds, still recurs as a theme (no seconds of its own).
  if (d && !d.noData) {
    const heel = d.found.flatMap((o) => [
      ...(o.kind === 'D11' && confidenceOf(o.conf).level !== 'none' ? [{ variant: o.variant, conf: confidenceOf(o.conf).level }] : []),
      ...(o.chips ?? []).filter((c) => c.kind === 'D11').map((c) => ({ variant: String(c.facts.variant), conf: 'medium' as Confidence })),
    ]);
    for (const h of heel) {
      const theme = themeKey('D11', h.variant);
      if (!findings.some((f) => f.theme === theme)) findings.push({ theme, kind: 'D11', variant: h.variant, seconds: 0, confidence: h.conf });
    }
  }
  return {
    raceNumber: a.meta.raceNumber,
    sail,
    tracked: true,
    finish,
    coverage: d?.raceCov ?? me.coverage,
    noData: !d || d.noData,
    legs: legDigests(a, sail),
    findings,
    evaluated: d && !d.noData ? evaluatedThemes(d.quality) : [],
    went: d && !d.noData ? d.plus.map((n) => wentOf(a, n)) : [],
    ...(turns ? { turns } : {}),
  };
}

/** The seconds of the legs riding on a D14 card (detectors/side.ts `alsoS`); 0 for any other card. */
export const alsoSeconds = (c: Pick<Opportunity, 'kind' | 'facts'>): number => (c.kind === 'D14' && typeof c.facts.alsoS === 'number' ? c.facts.alsoS : 0);

/** The worker's path: the Coach model from the race's raw fixes (as the race view builds it), then the digest. */
export function digestRace(a: RaceAnalysis, data: RaceData, sail: string, official: readonly OfficialResultRow[] | null = null): RaceDigest {
  const raw = a.boats.some((b) => b.sail === sail) ? coachRaw(a, data) : null;
  return raceDigest(a, raw ? buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null, raw.turns ?? null, raw.overStart ?? null) : null, sail, official);
}

// ---- themes: what a finding is about, across races (coarse enough to recur), and what to work on

export interface Theme {
  label: string;
  /** "slow at the gun" in "slow at the gun in 4 of 9 races". */
  phrase: string;
  /** A pattern card's lead: "Leeward roundings cost you time" (in 3 of 4 races with good data). */
  pattern: string;
}

/** The areas a sailor works on; a detector's variants within one area recur as one theme. */
export const THEMES: Record<string, Theme> = {
  start: { label: 'Starts: over, late or back at the gun', phrase: 'over early, late or back from the line at the gun', pattern: 'Over early, late or back from the line at the gun' },
  'gun-speed': { label: 'Slow at the gun', phrase: 'slow at the gun', pattern: 'Slow at the gun' },
  'after-start': { label: 'First minutes after the start', phrase: 'losing ground in the first minutes', pattern: 'The first minutes after the start cost you time' },
  shifts: { label: 'Wrong side of the shifts', phrase: 'on the wrong side of a shift', pattern: 'On the wrong side of a shift' },
  leader: { label: 'Let the leaders go', phrase: 'level with a leader, then let go', pattern: 'Level with a leader, then let go' },
  gains: { label: 'Gave back gains from a side', phrase: 'giving back a gain from a side', pattern: 'Gave back a gain from a side' },
  upwind: { label: 'Upwind speed and height', phrase: 'slow upwind', pattern: 'Slow upwind' },
  downwind: { label: 'Downwind angles and speed', phrase: 'slow downwind', pattern: 'Slow downwind' },
  'last-leg': { label: 'The last leg', phrase: 'losing out on the last leg', pattern: 'The last leg cost you time' },
  'dirty-air': { label: 'Dirty air early on the beats', phrase: 'in dirty air early on the beats', pattern: 'You sailed in dirty air early on the beats' },
  'round-windward': { label: 'Windward mark roundings', phrase: 'slow or wide at the windward mark', pattern: 'Windward roundings cost you time' },
  'round-leeward': { label: 'Leeward mark roundings', phrase: 'slow or wide at the leeward mark', pattern: 'Leeward roundings cost you time' },
  [GATE_THEME]: { label: 'Leeward roundings: gate choice', phrase: 'rounding the unfavoured gate mark', pattern: 'The unfavoured gate mark cost you time' },
  'round-offset': { label: 'Offset mark roundings', phrase: 'slow or wide at the offset mark', pattern: 'Offset-mark roundings cost you time' },
  'round-reach': { label: 'Reach mark roundings', phrase: 'slow or wide at the reach marks', pattern: 'Reach-mark roundings cost you time' },
  'heel-over': { label: 'Over-heeled upwind', phrase: 'over-heeled and slower upwind', pattern: 'Over-heeled upwind' },
  'heel-under': { label: 'Too flat upwind', phrase: 'flatter than the leaders and slower upwind', pattern: 'Too flat upwind' },
  'heel-down': { label: 'Heel on the runs', phrase: 'heeled to windward or rolling on the runs', pattern: 'Heeled to windward or rolling on the runs' },
  side: { label: 'Side of the course', phrase: 'on the side of the course that didn’t pay', pattern: 'The side you sailed didn’t pay' },
  distance: { label: 'Fast but not making progress', phrase: 'fast but sailing extra distance', pattern: 'Fast, but sailing extra distance for the ground made' },
  'line-end': { label: 'Starting at the unfavoured end', phrase: 'starting away from the favoured end of a biased line', pattern: 'You started away from the favoured end of the line' },
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
    case 'D8':
      return 'dirty-air';
    case 'D9':
      return `round-${variant}`;
    case 'D10':
      return 'last-leg';
    case 'D11':
      return variant === 'over' ? 'heel-over' : variant === 'under' ? 'heel-under' : 'heel-down';
    case 'D12':
      // Never a theme (raceDigest leaves D12 out of the findings): the Penalties row says it.
      return 'penalty-turns';
    case 'D13':
      return GATE_THEME;
    case 'D14':
      return 'side';
    case 'D15':
      return 'distance';
    case 'D16':
      return 'line-end';
  }
}
export const themeOf = (key: string): Theme => THEMES[key] ?? { label: key, phrase: key, pattern: key };

/** What to work on, by detector and variant (the race cards' tips, coachCards.ts, in short); the theme's tip is its costliest variant's. */
const TIPS: Record<string, string> = {
  'D1:late': 'Time the final approach so you hit the line at the gun, at full speed.',
  'D1:second-row': 'Set up closer to the line and own your gap to leeward.',
  'D1:ocs': 'Hold a safe gap to the line in the last 30 s; a bow out costs far more than a second late.',
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
  D8: 'Get a clear lane: tack or foot out of a boat’s shadow within a few lengths; don’t sit in its wind.',
  'D9:windward': 'Plan the bear-away: come in on the layline, ease the main as you turn, hoist once round.',
  'D9:leeward': 'Wide in, tight out: drop early, swing wide on the approach and leave close to the mark.',
  'D9:offset': 'Set up early for the offset: hoist and settle before it, then turn tight.',
  'D9:reach': 'Turn tight at the reach marks and trim for the new angle as you go round.',
  'D10:beat': 'Sail the lifted tack and stay between the boats just ahead and the finish.',
  'D10:run': 'Keep someone calling pressure and gybe into the puffs.',
  'D11:over': 'Keep the boat on its lines upwind: hike harder, and ease or depower in the puffs.',
  'D11:under': 'Let the boat heel to its groove: power up, and in light air move weight to leeward.',
  'D11:windward': 'On the runs keep the boat flat; heel to windward only as far as the faster boats do.',
  'D11:rolling': 'Steady the boat on the runs: smooth steering and trim, and keep the weight still.',
  D12: 'Keep clear early: a penalty turn costs far more than giving room or ducking.',
  D13: 'Before the gate, look upwind: round the buoy further upwind unless it is crowded.',
  D14: 'Before each leg, look for the side with more pressure or the coming shift and sail toward it, the fleet on your hip.',
  'D15:upwind': 'Sail the angle of the boats making the most ground upwind: speed only pays in the right direction.',
  'D15:downwind': 'Soak with the boats making the most ground downwind: speed only pays in the right direction.',
  D16: 'Check the line bias before the start and, when it is 6° or more off square, start near the favoured end.',
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
  /** Seconds per race it was found in (raceLabels' order). */
  raceSeconds: number[];
  /** The best confidence of its findings in each race (raceLabels' order): a low-resolution D9 is medium or low. */
  raceConf: Confidence[];
  /** `of` counts only the races the detector had the data for (D8, D9). */
  gated: boolean;
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
  /** A finding in RECUR_RACES or more races: shown as a pattern card ("… in 3 of 4 races with good data"). */
  pattern: boolean;
  /** Per-race chips: "R1 32 s". */
  chips: string[];
}

/** A ➕ family over the regatta (Went well). */
export interface WentWell {
  family: string;
  title: string;
  /** Races it went well in, of the races with data. */
  races: number;
  of: number;
  totalS: number;
  /** Weighted by each race's coverage: what ranks it. */
  weightedS: number;
  /** The best single one: "R2 Beat 1 +45 s". */
  best: { label: string; what: string; seconds: number };
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
  /** At most WENT_WELL_TOP, the most weighted seconds first. */
  went: WentWell[];
  /** The Penalties row (penaltiesOf): one entry per official code, and penalty turns; empty with none. */
  penalties: PenaltyRow[];
}

/** One line of the Penalties row: a code over the regatta ("DPI in 8 of 8 races · 24 penalty points · ≈ 24 places"), or penalty turns. */
export interface PenaltyRow {
  /** The official code, or 'turns' for penalty turns (D12). */
  code: string;
  meaning: string;
  /** Races with it, of the races analysed. */
  races: number;
  of: number;
  raceLabels: string[];
  /** The result is lost in those races (DSQ, UFD, OCS, DNF, …). */
  lost: boolean;
  /** Points the code added over the on-water places (a points penalty), summed; null when no race has both. */
  penaltyPoints: number | null;
  /** Places it cost (penaltyPlaces) summed; null as penaltyPoints. */
  places: number | null;
  /** The scored points summed (a lost result's points); null with none. */
  points: number | null;
  /** Penalty turns: loops and the seconds they cost, summed. */
  loops?: number;
  seconds?: number;
}

/** The codes that are a result, not a penalty: a boat that never started (DNS, DNC) has no Penalties line. */
const NOT_A_PENALTY = new Set(['DNS', 'DNC']);

/**
 * The Penalties row: every official code over the races analysed (the boat's scored result, never a speed theme),
 * the points it added over the on-water places and the places that cost, or the points of a lost result; then
 * penalty turns (D12) with the seconds they cost. Codes in the order of the most races.
 */
export function penaltiesOf(rows: readonly (RegattaRace & { weight: number })[]): PenaltyRow[] {
  const done = rows.filter((r) => r.status === 'done' && r.digest);
  const by = new Map<string, PenaltyRow>();
  const add = (n: number | null | undefined, cur: number | null): number | null => (n == null ? cur : (cur ?? 0) + n);
  for (const r of done) {
    const f = r.digest!.finish;
    const code = f?.code;
    if (!f || !code || NOT_A_PENALTY.has(code)) continue;
    const info = codeInfo(code);
    const cur = by.get(code) ?? { code, meaning: info.meaning, races: 0, of: done.length, raceLabels: [], lost: info.lost, penaltyPoints: null, places: null, points: null };
    cur.races += 1;
    cur.raceLabels.push(r.label);
    if (f.onWater != null && f.points != null && !info.lost) {
      cur.penaltyPoints = add(Math.round((f.points - f.onWater) * 10) / 10, cur.penaltyPoints);
      cur.places = add(f.penaltyPlaces, cur.places);
    } else cur.points = add(f.points, cur.points);
    by.set(code, cur);
  }
  const out = [...by.values()].sort((p, q) => q.races - p.races || p.code.localeCompare(q.code));
  const turned = done.filter((r) => r.digest!.turns);
  if (turned.length) {
    out.push({
      code: 'turns',
      meaning: 'Penalty turns (a 360 or a 720) on the track',
      races: turned.length,
      of: done.length,
      raceLabels: turned.map((r) => r.label),
      lost: false,
      penaltyPoints: null,
      places: null,
      points: null,
      loops: turned.reduce((s, r) => s + r.digest!.turns!.loops, 0),
      seconds: turned.reduce((s, r) => s + r.digest!.turns!.seconds, 0),
    });
  }
  return out;
}

/** A finding counts as recurring from this many races… */
export const RECUR_RACES = 2;
/** …or from this many weighted seconds in one. */
export const RECUR_SOLO_S = 30;
/** A leg type is worth working on from this much lost per leg (weighted mean), s. */
export const LEG_WORK_S = 10;
export const TOP_WORK = 3;
/** Went well over the regatta: at most this many families. */
export const WENT_WELL_TOP = 3;

const FAMILY_TITLE: Record<string, string> = {
  start: 'Starts',
  'leg:upwind': 'Beats',
  'leg:downwind': 'Runs',
  'leg:reach': 'Reaches',
  'round:windward': 'Windward roundings',
  'round:leeward': 'Leeward roundings',
  'round:offset': 'Offset roundings',
  'round:reach': 'Reach-mark roundings',
  'round:gate': 'Gate choice',
  side: 'Side of the course',
  'heel:upwind': 'Heel upwind',
  'heel:downwind': 'Heel on the runs',
};
export const familyTitle = (f: string): string => FAMILY_TITLE[f] ?? f;

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
    const confs = new Map<string, Confidence>();
    for (const f of r.digest!.findings) {
      sums.set(f.theme, (sums.get(f.theme) ?? 0) + f.seconds);
      const c = confs.get(f.theme);
      if (!c || CONF_ORDER.indexOf(f.confidence) > CONF_ORDER.indexOf(c)) confs.set(f.theme, f.confidence);
      const vs = variants.get(f.theme) ?? new Map<string, { s: number; tip: string }>();
      const k = `${f.kind}:${f.variant}`;
      vs.set(k, { s: (vs.get(k)?.s ?? 0) + f.seconds * r.weight, tip: tipOf(f.kind, f.variant) });
      variants.set(f.theme, vs);
    }
    for (const [theme, sec] of sums) {
      const t = themeOf(theme);
      const gated = gatedTheme(theme);
      // A gated detector's denominator: the races it had the data for (one it fired in always had).
      const of = gated ? withData.filter((x) => x === r || (x.digest!.evaluated ?? []).includes(theme) || x.digest!.findings.some((y) => y.theme === theme)).length : withData.length;
      const cur = byTheme.get(theme) ?? { theme, label: t.label, phrase: t.phrase, tip: '', races: 0, of, totalS: 0, weightedS: 0, lowRaces: 0, raceLabels: [], raceSeconds: [], raceConf: [], gated };
      cur.races += 1;
      cur.totalS += sec;
      cur.weightedS += sec * r.weight;
      if (r.low) cur.lowRaces += 1;
      cur.raceLabels.push(r.label);
      cur.raceSeconds.push(sec);
      cur.raceConf.push(confs.get(theme) ?? 'high');
      byTheme.set(theme, cur);
    }
  }
  for (const f of byTheme.values()) f.tip = [...variants.get(f.theme)!.entries()].sort((p, q) => q[1].s - p[1].s || p[0].localeCompare(q[0]))[0][1].tip;
  const findings = [...byTheme.values()].sort((p, q) => q.weightedS - p.weightedS || q.races - p.races || p.label.localeCompare(q.label));
  // Gate choice is a subtheme of the leeward roundings: listed right under them when both recur.
  const gi = findings.findIndex((f) => f.theme === GATE_THEME);
  if (gi >= 0 && findings.some((f) => f.theme === 'round-leeward')) {
    const [gate] = findings.splice(gi, 1);
    findings.splice(findings.findIndex((f) => f.theme === 'round-leeward') + 1, 0, gate);
  }

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
    .map((f) => {
      const pattern = f.races >= RECUR_RACES;
      const total = f.totalS >= 1 ? `, ~${Math.round(f.totalS)} s total` : '';
      const low = f.lowRaces ? ` (${f.lowRaces} with low tracker data)` : '';
      return {
        theme: f.theme,
        title: f.label,
        why: pattern ? `${themeOf(f.theme).pattern} in ${f.races} of ${f.of} races with good data${total}${low}` : `${cap(f.phrase)} in ${f.races} of ${f.of} races${total}${low}`,
        tip: f.tip,
        score: f.weightedS,
        pattern,
        chips: f.raceLabels.map((l, i) => {
          const c = f.raceConf[i];
          return `${f.raceSeconds[i] >= 1 ? `${l} ${Math.round(f.raceSeconds[i])} s` : l}${c === 'high' ? '' : ` (${c})`}`;
        }),
      };
    });
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
      pattern: false,
      chips: [],
    });
  }
  top.sort((p, q) => q.score - p.score || p.title.localeCompare(q.title));

  return { rows, done: done.length, withData: withData.length, total: rows.length, findings, legs, top: top.slice(0, TOP_WORK), went: wentWellOf(withData), penalties: penaltiesOf(rows) };
}

/**
 * Went well over the regatta: each race's ➕ (legs, roundings, the start where the boat gained on the
 * leaders) grouped by family, ranked by seconds weighted by the race's coverage; at most WENT_WELL_TOP.
 */
export function wentWellOf(races: readonly (RegattaRace & { weight: number })[]): WentWell[] {
  const by = new Map<string, WentWell>();
  // Heel (D11) and gate choice (D13) went well only in races that had the data to judge: those are their "of N".
  const ofFamily = (family: string): number => {
    const theme = family === 'round:gate' ? GATE_THEME : family.startsWith('heel:') ? HEEL_THEMES[family.slice(5)]?.[0] : null;
    if (!theme) return races.length;
    return races.filter((x) => (x.digest?.evaluated ?? []).includes(theme) || (x.digest?.went ?? []).some((w) => w.family === family)).length;
  };
  for (const r of races) {
    const seen = new Set<string>();
    for (const w of r.digest?.went ?? []) {
      const cur = by.get(w.family) ?? { family: w.family, title: familyTitle(w.family), races: 0, of: ofFamily(w.family), totalS: 0, weightedS: 0, best: { label: r.label, what: w.label, seconds: w.seconds } };
      if (!seen.has(w.family)) cur.races += 1;
      seen.add(w.family);
      cur.totalS += w.seconds;
      cur.weightedS += w.seconds * r.weight;
      if (w.seconds > cur.best.seconds) cur.best = { label: r.label, what: w.label, seconds: w.seconds };
      by.set(w.family, cur);
    }
  }
  return [...by.values()].sort((p, q) => q.weightedS - p.weightedS || q.races - p.races || p.title.localeCompare(q.title)).slice(0, WENT_WELL_TOP);
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
