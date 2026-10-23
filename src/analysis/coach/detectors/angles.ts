/**
 * D6 · Pointing vs speed upwind and D7 · Downwind angles (spec §3, deep.py).
 * Per leg of the kind, the boat's course-over-ground samples (cogPairs) are cut
 * into 2-min windows from its first one; in each window the boat's median
 * |TWA| and SOG (and so VMG) are set against the fleet's — every other boat's
 * medians in the *same* window — so a wind change hits both alike.
 *
 * Fires when the boat's VMG over the leg's windows (the median) is at least
 * the drop below the fleet's (3 % upwind, 4 % down) and that holds in at least
 * ANG_WINDOW_SHARE of the windows. Seconds (rate-type) =
 * (VMG_fleet − VMG_b) / VMG_fleet × the boat's time on the leg, summed over
 * the legs that fire. The top 3's own leg medians are shown alongside (the
 * debrief's "153° vs top-3 137°"); they sailed the leg at other times, so they
 * classify the angle but never set the seconds.
 */
import { median, wrap180 } from '../../geo';
import type { LegKind } from '../../types';
import { trackLegAt, type CoachTrack } from '../tracks';
import { cogPairs } from '../twdSeries';
import { RATE_REL_ERR, NOISE_BASE_S, coachCoverage, windOkShare, type Fact, type GoodNote, type Opportunity } from '../opportunity';
import type { CoachCtx } from './context';

export const ANG_WINDOW_MS = 120_000;
/** Samples slower than this are left out (drifting, a rounding), kn. */
export const ANG_MIN_SOG_KN = 2.5;
/** Upwind samples: |TWA| inside this band, °; downwind: above ANG_DOWN_MIN. */
export const ANG_UP: [number, number] = [20, 70];
export const ANG_DOWN_MIN = 110;
/** A window counts with this many boat samples and this many other boats (each with that many). */
export const ANG_MIN_SAMPLES = 2;
export const ANG_MIN_FLEET = 4;
export const D6_DROP = 0.03;
export const D7_DROP = 0.04;
export const ANG_WINDOW_SHARE = 0.6;
/** Class thresholds: TWA difference, °; SOG difference, share. */
export const D6_TWA_DEG = 2;
export const D6_SOG_DROP = 0.03;
export const D7_TWA_DEG = 8;
/** Wind bands from the fleet's median SOG (spec §6), kn. */
export const WIND_LIGHT_KN = 6;
export const WIND_FRESH_KN = 10;

interface Samples {
  t: number[];
  twa: number[];
  sog: number[];
}

/** legSamples once per track, wind and leg (every boat's debrief reads the whole fleet's); read-only. */
const samplesMemo = new WeakMap<CoachTrack, WeakMap<(t: number) => number, Map<string, Samples>>>();

/** A boat's samples on `leg`: |TWA| against the fleet wind, SOG; in the kind's band and moving. */
export function legSamples(tr: CoachTrack, leg: number, kind: LegKind, twdAt: (t: number) => number): Samples {
  let byWind = samplesMemo.get(tr);
  if (!byWind) samplesMemo.set(tr, (byWind = new WeakMap()));
  let byLeg = byWind.get(twdAt);
  if (!byLeg) byWind.set(twdAt, (byLeg = new Map()));
  const key = `${leg}:${kind}`;
  let out = byLeg.get(key);
  if (!out) byLeg.set(key, (out = readSamples(tr, leg, kind, twdAt)));
  return out;
}

function readSamples(tr: CoachTrack, leg: number, kind: LegKind, twdAt: (t: number) => number): Samples {
  const c = cogPairs(tr);
  const out: Samples = { t: [], twa: [], sog: [] };
  for (let i = 0; i < c.t.length; i++) {
    if (!(c.sogKn[i] > ANG_MIN_SOG_KN) || trackLegAt(tr, c.t[i]) !== leg) continue;
    const twa = Math.abs(wrap180(c.cog[i] - twdAt(c.t[i])));
    if (kind === 'upwind' ? twa <= ANG_UP[0] || twa >= ANG_UP[1] : twa <= ANG_DOWN_MIN) continue;
    out.t.push(c.t[i]);
    out.twa.push(twa);
    out.sog.push(c.sogKn[i]);
  }
  return out;
}

const vmgOf = (twa: number, sog: number, kind: LegKind): number => sog * Math.cos((twa * Math.PI) / 180) * (kind === 'upwind' ? 1 : -1);

interface Stat {
  twa: number;
  sog: number;
  vmg: number;
}

function stat(s: Samples, kind: LegKind, a = -Infinity, b = Infinity): Stat | null {
  const idx = s.t.map((_, i) => i).filter((i) => s.t[i] >= a && s.t[i] < b);
  if (idx.length < ANG_MIN_SAMPLES) return null;
  const twa = median(idx.map((i) => s.twa[i]));
  const sog = median(idx.map((i) => s.sog[i]));
  return { twa, sog, vmg: vmgOf(twa, sog, kind) };
}

export interface LegAngles {
  leg: number;
  kind: LegKind;
  windows: { t: number; boat: Stat; fleet: Stat; n: number; ids: string[] }[];
  /** Medians over the windows. */
  boat: Stat;
  fleet: Stat;
  /** The top 3's own leg medians (median over them); null with none. */
  top: Stat | null;
  /** (VMG_fleet − VMG_b) / VMG_fleet. */
  deficit: number;
  /** Share of windows at least the drop below the fleet. */
  share: number;
  /** The boat's time on the leg, s. */
  legS: number;
  /** Share of the leg's time the windows cover. */
  windowCov: number;
  t0: number;
  t1: number;
}

/** The matched-window comparison on `leg`; null with no window. */
export function legAngles(ctx: CoachCtx, leg: number): LegAngles | null {
  const kind = ctx.a.legs[leg]?.kind;
  if (kind !== 'upwind' && kind !== 'downwind') return null;
  const w = ctx.m.wind.twdAt;
  const mine = legSamples(ctx.tr, leg, kind, w);
  if (mine.t.length < ANG_MIN_SAMPLES) return null;
  const others = new Map<string, Samples>();
  for (const b of ctx.a.boats) {
    const tr = ctx.m.tracks.get(b.id);
    if (b.id !== ctx.boat && tr) others.set(b.id, legSamples(tr, leg, kind, w));
  }
  const drop = kind === 'upwind' ? D6_DROP : D7_DROP;
  const windows: LegAngles['windows'] = [];
  for (let c = mine.t[0]; c <= mine.t[mine.t.length - 1]; c += ANG_WINDOW_MS) {
    const boat = stat(mine, kind, c, c + ANG_WINDOW_MS);
    if (!boat) continue;
    const fs: (Stat & { id: string })[] = [];
    for (const [id, s] of others) {
      const f = stat(s, kind, c, c + ANG_WINDOW_MS);
      if (f) fs.push({ ...f, id });
    }
    if (fs.length < ANG_MIN_FLEET) continue;
    windows.push({
      t: c,
      boat,
      fleet: { twa: median(fs.map((f) => f.twa)), sog: median(fs.map((f) => f.sog)), vmg: median(fs.map((f) => f.vmg)) },
      n: fs.length,
      ids: fs.map((f) => f.id),
    });
  }
  if (!windows.length) return null;
  const med = (k: keyof Stat, who: 'boat' | 'fleet'): number => median(windows.map((x) => x[who][k]));
  const boat = { twa: med('twa', 'boat'), sog: med('sog', 'boat'), vmg: med('vmg', 'boat') };
  const fleet = { twa: med('twa', 'fleet'), sog: med('sog', 'fleet'), vmg: med('vmg', 'fleet') };
  const tops = ctx.leaders.map((id) => others.get(id)).map((s) => (s ? stat(s, kind) : null)).filter((x): x is Stat => !!x);
  const top = tops.length ? { twa: median(tops.map((s) => s.twa)), sog: median(tops.map((s) => s.sog)), vmg: median(tops.map((s) => s.vmg)) } : null;
  const lr = ctx.me.legs[leg];
  const t0 = lr?.startMs ?? mine.t[0];
  const t1 = lr?.endMs ?? mine.t[mine.t.length - 1];
  const legS = lr?.timeS ?? (t1 - t0) / 1000;
  const below = windows.filter((x) => x.fleet.vmg > 0 && (x.fleet.vmg - x.boat.vmg) / x.fleet.vmg >= drop).length;
  return {
    leg,
    kind,
    windows,
    boat,
    fleet,
    top,
    deficit: fleet.vmg > 0 ? (fleet.vmg - boat.vmg) / fleet.vmg : 0,
    share: below / windows.length,
    legS,
    windowCov: Math.min(1, (windows.length * ANG_WINDOW_MS) / 1000 / Math.max(1, legS)),
    t0,
    t1,
  };
}

/** Light / medium / fresh from the fleet's median SOG on these legs (spec §6). */
export const windBand = (sogKn: number): 'light' | 'medium' | 'fresh' => (sogKn < WIND_LIGHT_KN ? 'light' : sogKn <= WIND_FRESH_KN ? 'medium' : 'fresh');

/** The class of a slow leg (spec §3). */
export function angleClass(l: LegAngles): string {
  if (l.kind === 'upwind') {
    const tighter = l.fleet.twa - l.boat.twa;
    const slower = (l.fleet.sog - l.boat.sog) / l.fleet.sog;
    if (tighter >= D6_TWA_DEG && slower >= D6_SOG_DROP) return 'high-slow';
    if (-tighter >= D6_TWA_DEG && l.boat.sog > l.fleet.sog) return 'low-fast';
    return 'slow';
  }
  const ref = l.top ?? l.fleet;
  const deeper = l.boat.twa - ref.twa;
  if (deeper >= D7_TWA_DEG && l.boat.sog < ref.sog) return 'deep';
  if (-deeper >= D7_TWA_DEG) return 'hot';
  return 'slow';
}

export interface AnglesResult {
  opp: Opportunity | null;
  ok: GoodNote | null;
  legs: LegAngles[];
}

/** Evaluated legs (windows over at least this share of the leg) feed the ✓ chip. */
export const ANG_OK_COVERAGE = 0.5;

/**
 * D6 (`kind` 'upwind') or D7 ('downwind') over the race's legs of that kind. `worse`: legs where the boat's progress
 * contradicts a "fine" (nowhere.ts progressWorse): no ✓ while one of them is evaluated.
 */
export function detectAngles(ctx: CoachCtx, kind: 'upwind' | 'downwind', worse: ReadonlySet<number> = new Set()): AnglesResult {
  const legs = ctx.a.legs
    .map((l, k) => (l.kind === kind ? legAngles(ctx, k) : null))
    .filter((x): x is LegAngles => !!x);
  const drop = kind === 'upwind' ? D6_DROP : D7_DROP;
  const fired = legs.filter((l) => l.deficit >= drop && l.share >= ANG_WINDOW_SHARE);
  const det = kind === 'upwind' ? 'D6' : 'D7';
  const pool = (ls: LegAngles[], who: 'boat' | 'fleet', k: keyof Stat): number => median(ls.flatMap((l) => l.windows.map((x) => x[who][k])));
  const facts = (ls: LegAngles[]): Record<string, Fact> => {
    const tops = ls.map((l) => l.top).filter((x): x is Stat => !!x);
    return {
      twa: pool(ls, 'boat', 'twa'),
      sog: pool(ls, 'boat', 'sog'),
      vmg: pool(ls, 'boat', 'vmg'),
      fTwa: pool(ls, 'fleet', 'twa'),
      fSog: pool(ls, 'fleet', 'sog'),
      fVmg: pool(ls, 'fleet', 'vmg'),
      tTwa: tops.length ? median(tops.map((s) => s.twa)) : null,
      tSog: tops.length ? median(tops.map((s) => s.sog)) : null,
      wind: windBand(pool(ls, 'fleet', 'sog')),
      legs: ls.map((l) => ctx.a.legs[l.leg].name).join(' + '),
    };
  };
  if (!fired.length) {
    const good = legs.filter((l) => l.windowCov >= ANG_OK_COVERAGE && l.deficit < drop && !worse.has(l.leg));
    // The boat's coverage of the legs judged (time-weighted): the ✓ says "not enough data" under debrief.ts OK_THIN_COVERAGE.
    const ms = good.reduce((s, l) => s + Math.max(0, l.t1 - l.t0), 0);
    const coverage = ms > 0 ? good.reduce((s, l) => s + coachCoverage(ctx.tr.t, l.t0, l.t1) * Math.max(0, l.t1 - l.t0), 0) / ms : 0;
    const ofKind = ctx.a.legs.filter((l) => l.kind === kind).length;
    const ok: GoodNote | null =
      good.length && good.length === legs.filter((l) => l.windowCov >= ANG_OK_COVERAGE).length
        ? { kind: 'ok', detector: det, variant: kind, facts: { ...facts(good), all: good.length === ofKind ? 1 : 0 }, t0: good[0].t0, t1: good[good.length - 1].t1, coverage }
        : null;
    return { opp: null, ok, legs };
  }
  const seconds = fired.reduce((s, l) => s + l.deficit * l.legS, 0);
  const biggest = fired.reduce((p, q) => (q.deficit * q.legS > p.deficit * p.legS ? q : p));
  const totS = fired.reduce((s, l) => s + (l.t1 - l.t0), 0);
  const cov = fired.reduce((s, l) => s + coachCoverage(ctx.tr.t, l.t0, l.t1) * (l.t1 - l.t0), 0) / Math.max(1, totS);
  const wind = fired.reduce((s, l) => s + windOkShare(ctx.m.wind, l.t0, l.t1) * (l.t1 - l.t0), 0) / Math.max(1, totS);
  // The fleet: boats present in the windows of the fired legs.
  const wins = fired.flatMap((l) => l.windows);
  const seen = new Map<string, number>();
  for (const x of wins) for (const id of x.ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  const shares = [...seen.values()].map((v) => v / wins.length);
  const noise = NOISE_BASE_S + RATE_REL_ERR * seconds;
  return {
    opp: {
      kind: det,
      variant: angleClass(biggest),
      t0: fired[0].t0,
      t1: fired[fired.length - 1].t1,
      spans: fired.map((l) => [l.t0, l.t1] as [number, number]),
      seconds,
      secondsLo: Math.max(0, seconds - noise),
      secondsHi: seconds + noise,
      confidence: 'high',
      coverage: cov,
      conf: { boatCov: cov, refs: { good: shares.filter((s) => s >= 0.8).length, fair: shares.filter((s) => s >= 0.5).length, need: 3 }, windOk: wind },
      facts: { ...facts(fired), deficit: seconds / fired.reduce((s, l) => s + l.legS, 0), runs: fired.length },
      refBoats: [...seen.keys()],
    },
    ok: null,
    legs,
  };
}
