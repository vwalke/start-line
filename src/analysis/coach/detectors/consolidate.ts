/**
 * D5 · Consolidation / overstand (spec §3; the debrief's "gains from the side
 * not banked"). On each leg the boat's gap to a reference is read every
 * D5_READ_STEP_MS, each read the chart's point there (ctx.gaps: the gap at equal
 * course progress, timeGap.ts groupGap). A swing is a peak — the gap having
 * improved D5_GAIN_S or more over the D5_LOOKBACK_MS before it — then a loss
 * of D5_LOSS_S or more within D5_LOSS_MS, all on one well-tracked stretch
 * (gapReads: Good Trade's race 1 gap grows another 15 s across its sparse
 * 13–17 min, and that belongs to the rounding, not the swing). It fires when the boat was
 * D5_SEP_M or more across the wind from the reference at the peak and the
 * wind swung D5_SHIFT_DEG or more by the trough; or, upwind, when the boat
 * overstood (layline test) and lost D5_OVERSTAND_S or more. Seconds = peak →
 * trough of the gap: the chart's change between those two points (Opportunity.gaps).
 *
 * Two references, two stories:
 * - caught-leader: each of the leaders (finish top 3) alone, the peak being
 *   level with it (within D5_LEVEL_S). Drawing level with a named
 *   boat is a sharper event than a group median moving, so the wind needs
 *   only to have swung D5_LEADER_SHIFT_DEG (Good Trade race 1: Patriot 526 m
 *   away, the fleet wind 37° → 41° while it pulled 31 s ahead; the fleet's
 *   minute wind can't see the local lift a 500 m split sails in).
 * - overstand / banked: the peers, the boats that finished up to
 *   D5_PEERS_AHEAD places ahead (the places a gain banked could have taken),
 *   or the Near ±3 group when fewer than 3 finished ahead. Overstand when the
 *   layline test holds, else banked.
 *
 * Layline test (upwind): the boat tacked onto a course at the mark (within
 * LAYLINE_FETCH_DEG) it could lay (|TWA| ≥ half the tack angle − 5°) more
 * than LAYLINE_FAR_M out and didn't tack again before the trough; or it spent
 * half the loss heading at the mark LAYLINE_BELOW_DEG or more below
 * close-hauled.
 */
import { len, median, sub, vecBearing, wrap180 } from '../../geo';
import { finishRank } from '../../result';
import { detectManoeuvres } from '../../manoeuvres';
import { groupIds, placeOf } from '../groups';
import { legEnd, type GapPoint } from '../ladder';
import { posAt, type CoachTrack } from '../tracks';
import { cogPairs } from '../twdSeries';
import {
  GAP_READ_MS,
  WIND_EST_S,
  coachCoverage,
  gapNear,
  gapNoise,
  rangeOf,
  reading,
  refCoverage,
  untrackedS,
  windOkShare,
  type Fact,
  type GoodNote,
  type Opportunity,
} from '../opportunity';
import type { CoachCtx } from './context';
import { lateralSep, typicalSep } from './early';
import { legWindow, signedSep } from './shift';

export const D5_GAIN_S = 20;
export const D5_LOSS_S = 30;
export const D5_LOSS_MS = 6 * 60_000;
export const D5_LOOKBACK_MS = 10 * 60_000;
export const D5_SEP_M = 300;
export const D5_SHIFT_DEG = 8;
export const D5_OVERSTAND_S = 60;
/** Caught-leader: level means within this of the leader, or ahead of it, s. */
export const D5_LEVEL_S = 10;
export const D5_LEADER_SHIFT_DEG = 4;
export const D5_PEERS_AHEAD = 6;
export const D5_MIN_PEERS = 3;
/** Gap reads every this often, ms. */
export const D5_READ_STEP_MS = 30_000;
export const LAYLINE_FAR_M = 1000;
export const LAYLINE_FETCH_DEG = 15;
export const LAYLINE_BELOW_DEG = 15;
/** The course after a tack is read over this stretch after it, ms. */
export const LAYLINE_SETTLE_MS: [number, number] = [30_000, 120_000];
/** ✓ Banked gains needs a leg this well covered. */
export const D5_OK_COVERAGE = 0.5;

/** A read needs the boat's track to cover this share of the GAP_READ_MS × 2 around it (coachCoverage)… */
export const D5_READ_COVERAGE = 0.5;
/** …and reads further apart than this (a read missing) start a new stretch of track, ms. */
export const D5_READ_GAP_MS = 60_000;

export interface GapReadPt {
  t: number;
  g: number;
  /** Stretch of well-tracked reads (a swing compares only within one). */
  seg: number;
}

/**
 * One gap read per D5_READ_STEP_MS on `leg` (the boat on that leg), from `pick`: the chart's point nearest it (within
 * half a step; its own time), where the boat's own track `t` covers D5_READ_COVERAGE of the two minutes around it. A
 * sparse stretch (fixes 15–30 s apart, as Good Trade's race 1 from 13 to 17 min) yields a stray read or two that would
 * join a swing to what happened in the stretch; they are left out, and the stretch splits the reads.
 */
export function gapReads(
  points: readonly GapPoint[],
  leg: number,
  a: number,
  b: number,
  pick: (p: GapPoint) => number | null,
  t?: ArrayLike<number> & { length: number },
): GapReadPt[] {
  const on = points.filter((p) => p.leg === leg);
  const out: GapReadPt[] = [];
  let seg = 0;
  for (let x = a; x <= b; x += D5_READ_STEP_MS) {
    if (t && coachCoverage(t, x - GAP_READ_MS, x + GAP_READ_MS) < D5_READ_COVERAGE) continue;
    const hit = gapNear(on, x, D5_READ_STEP_MS / 2, pick);
    const prev = out[out.length - 1];
    if (!hit || (prev && hit.tMs <= prev.t)) continue;
    if (prev && hit.tMs - prev.t > D5_READ_GAP_MS) seg++;
    out.push({ t: hit.tMs, g: hit.g, seg });
  }
  return out;
}

export interface Swing {
  /** The read before the peak the gain is measured from, the peak, the trough. */
  tFrom: number;
  gFrom: number;
  tPeak: number;
  gPeak: number;
  tTrough: number;
  gTrough: number;
}

/** The best gain into each read: the highest read over the D5_LOOKBACK_MS before it on the same stretch. */
function gainFrom(reads: readonly GapReadPt[], i: number): GapReadPt | null {
  let from: GapReadPt | null = null;
  for (let j = i - 1; j >= 0 && reads[j].seg === reads[i].seg && reads[i].t - reads[j].t <= D5_LOOKBACK_MS; j--) if (!from || reads[j].g > from.g) from = reads[j];
  return from;
}

/** Some read gained D5_GAIN_S or more over the lookback. */
export const anyGain = (reads: readonly GapReadPt[], gainS = D5_GAIN_S): boolean => reads.some((r, i) => (gainFrom(reads, i)?.g ?? -Infinity) - r.g >= gainS);

/** Every gain-then-loss in `reads` (gain ≥ D5_GAIN_S, then loss ≥ D5_LOSS_S within D5_LOSS_MS, one stretch of track), biggest loss first. */
export function swings(reads: readonly GapReadPt[], gainS = D5_GAIN_S, lossS = D5_LOSS_S): Swing[] {
  const out: Swing[] = [];
  reads.forEach((r, i) => {
    // A peak is a turn: no better read either side of it on the same stretch (not a point on the slope).
    const prev = reads[i - 1];
    const next = reads[i + 1];
    if ((prev && prev.seg === r.seg && prev.g < r.g) || (next && next.seg === r.seg && next.g < r.g)) return;
    const from = gainFrom(reads, i);
    if (!from || from.g - r.g < gainS) return;
    let to: GapReadPt | null = null;
    for (let j = i + 1; j < reads.length && reads[j].seg === r.seg && reads[j].t - r.t <= D5_LOSS_MS; j++) if (!to || reads[j].g > to.g) to = reads[j];
    if (!to || to.g - r.g < lossS) return;
    out.push({ tFrom: from.t, gFrom: from.g, tPeak: r.t, gPeak: r.g, tTrough: to.t, gTrough: to.g });
  });
  return out.sort((p, q) => q.gTrough - q.gPeak - (p.gTrough - p.gPeak) || p.tPeak - q.tPeak);
}

/** The wind's largest move from its value at `a` over [a, b], ° (signed, + = veered). */
export function windSwing(twdAt: (t: number) => number, a: number, b: number): number {
  const w0 = twdAt(a);
  let best = 0;
  for (let t = a; t <= b; t += 30_000) {
    const d = wrap180(twdAt(t) - w0);
    if (Math.abs(d) > Math.abs(best)) best = d;
  }
  return best;
}

export interface Layline {
  /** Committed to the layline this far out, m (null: not from a tack over LAYLINE_FAR_M out). */
  fromM: number | null;
  /** Spent half of [a, b] heading at the mark LAYLINE_BELOW_DEG or more below close-hauled. */
  below: boolean;
}

/** The layline test on upwind leg `leg` for the stretch ending at `b` (the loss: [a, b]); null when neither part holds. */
export function laylineTest(ctx: CoachCtx, leg: number, legStart: number, a: number, b: number): Layline | null {
  if (ctx.a.legs[leg]?.kind !== 'upwind') return null;
  const tr = ctx.tr;
  const w = ctx.m.wind;
  const c = cogPairs(tr);
  const sample = (from: number, to: number) => {
    const out: { cogOff: number; twa: number; half: number; d: number }[] = [];
    for (let i = 0; i < c.t.length; i++) {
      if (c.t[i] < from || c.t[i] > to) continue;
      const p = posAt(tr, c.t[i]);
      if (!p) continue;
      const mark = legEnd(ctx.m.course, leg, p);
      const v = sub(mark, p);
      const twd = w.twdAt(c.t[i]);
      out.push({ cogOff: Math.abs(wrap180(c.cog[i] - vecBearing(v))), twa: Math.abs(wrap180(c.cog[i] - twd)), half: w.taAt(c.t[i]) / 2, d: len(v) });
    }
    return out;
  };
  let fromM: number | null = null;
  const tacks = detectManoeuvres(tr, w.twdAt, legStart, b).filter((m) => m.kind === 'tack');
  const last = tacks[tacks.length - 1];
  if (last && last.tMs < b) {
    const s = sample(last.tMs + LAYLINE_SETTLE_MS[0], Math.min(b, last.tMs + LAYLINE_SETTLE_MS[1]));
    if (s.length >= 3) {
      const off = median(s.map((x) => x.cogOff));
      const twa = median(s.map((x) => x.twa));
      const half = median(s.map((x) => x.half));
      const d = s[0].d;
      if (off <= LAYLINE_FETCH_DEG && twa >= half - 5 && twa < 90 && d > LAYLINE_FAR_M) fromM = d;
    }
  }
  const s = sample(a, b);
  const below = s.length >= 3 && s.filter((x) => x.cogOff <= LAYLINE_FETCH_DEG && x.twa >= x.half + LAYLINE_BELOW_DEG).length >= s.length / 2;
  return fromM != null || below ? { fromM, below } : null;
}

/** The peers for D5: up to D5_PEERS_AHEAD places ahead by finish (D5_MIN_PEERS of them), else the Near ±3 group. */
export function d5Peers(ctx: CoachCtx): { ids: string[]; ahead: boolean } {
  const p = placeOf(ctx.me);
  if (p != null) {
    const ahead = ctx.a.boats
      .filter((b) => b.id !== ctx.boat && finishRank(b) != null && finishRank(b)! < p && finishRank(b)! >= p - D5_PEERS_AHEAD && ctx.m.tracks.has(b.id))
      .sort((x, y) => finishRank(x)! - finishRank(y)!)
      .map((b) => b.id);
    if (ahead.length >= D5_MIN_PEERS) return { ids: ahead, ahead: true };
  }
  return { ids: groupIds(ctx.a.boats, ctx.boat, { kind: 'near' }).filter((id) => ctx.m.tracks.has(id)), ahead: false };
}

interface Found {
  opp: Opportunity;
  rank: number;
}

/** Variants by how specific the story is, when two overlap: an overstand, a caught leader, a gain given back. */
const SPECIFIC: Record<string, number> = { overstand: 3, 'caught-leader': 2, banked: 1 };

export interface ConsolidateResult {
  opps: Opportunity[];
  ok: GoodNote | null;
}

export function detectConsolidate(ctx: CoachCtx): ConsolidateResult {
  const w = ctx.m.wind;
  const peers = d5Peers(ctx);
  const leaders = ctx.leaders.filter((id) => ctx.m.tracks.has(id));
  const found: Found[] = [];
  // For the ✓: well-covered legs where the boat gained on its peers, and whether any such gain was given back.
  let gainLegs = 0;
  let gaveBack = false;
  ctx.a.legs.forEach((leg, k) => {
    const lw = legWindow(ctx.tr, k);
    if (!lw) return;
    const [a, b] = lw;
    const goodLeg = coachCoverage(ctx.tr.t, a, b) >= D5_OK_COVERAGE;
    const make = (variant: string, refs: string[], s: Swing, sepM: number, sepSigned: number | null, lay: Layline | null, extra: Record<string, Fact>, boat?: string): Opportunity => {
      const t0 = s.tPeak;
      const t1 = s.tTrough;
      const seconds = s.gTrough - s.gPeak;
      const cov = coachCoverage(ctx.tr.t, t0, t1);
      // Peak sep (often 1 km+ on a corner) is the story; the ±3° wind term uses the
      // typical (start/mid/end) sep of the peak→trough window, as D3 does. Using the
      // peak alone over-applies the term when the trough has no fix or the boats have
      // closed (R3 Beat 2: 1085 m peak vs 709 m mid → a 119–249 s chip for an 184 s loss).
      const { noise, windS } = gapNoise(typicalSep(ctx, refs, t0, t1), ctx.m.vmg[k], untrackedS(ctx.tr.t, t0, t1));
      const range = rangeOf(seconds, noise);
      const refTracks = refs.map((id) => ctx.m.tracks.get(id)).filter((x): x is CoachTrack => !!x);
      const shift = windSwing(w.twdAt, t0, t1);
      return {
        kind: 'D5',
        variant,
        t0,
        t1,
        seconds,
        ...range,
        confidence: 'high',
        coverage: cov,
        conf: {
          boatCov: cov,
          refs: refCoverage(refTracks, t0, t1),
          windOk: windOkShare(w, t0, t1),
          rangeShare: (range.secondsHi - range.secondsLo) / Math.max(1, seconds),
          marksEstimated: ctx.marksEstimated,
        },
        facts: {
          leg: leg.name,
          gain: s.gFrom - s.gPeak,
          gPeak: s.gPeak,
          gTrough: s.gTrough,
          tPeak: s.tPeak,
          tTrough: s.tTrough,
          shift: Math.abs(shift),
          dir: shift < 0 ? 'left' : 'right',
          sepM,
          side: sepSigned == null ? null : sepSigned > 0 ? 'right' : 'left',
          layFromM: lay?.fromM ?? null,
          ...extra,
        },
        refBoats: refs,
        windEst: windS >= WIND_EST_S,
        gaps: [reading(refs, { t0: s.tPeak, g0: s.gPeak, t1: s.tTrough, g1: s.gTrough }, boat)],
      };
    };
    // Caught the leader: each leader alone.
    if (leaders.length) {
      const pts = ctx.gaps(leaders, a, b);
      leaders.forEach((id, i) => {
        const reads = gapReads(pts, k, a, b, (p) => p.each[i], ctx.tr.t);
        const ref = ctx.m.tracks.get(id)!;
        for (const s of swings(reads)) {
          if (Math.abs(s.gPeak) > D5_LEVEL_S) continue;
          const sep = signedSep(ctx.tr, ref, s.tPeak, w.twdAt(s.tPeak));
          if (sep == null || Math.abs(sep) < D5_SEP_M || Math.abs(windSwing(w.twdAt, s.tPeak, s.tTrough)) < D5_LEADER_SHIFT_DEG) continue;
          const tacked = detectManoeuvres(ctx.tr, w.twdAt, s.tPeak - 60_000, s.tTrough).some((m) => m.kind === 'tack');
          const opp = make('caught-leader', [id], s, Math.abs(sep), sep, null, { ldr: ctx.nameOf(id), tacked: tacked ? 1 : 0 }, id);
          found.push({ opp, rank: SPECIFIC['caught-leader'] });
          break;
        }
      });
    }
    // The peers' median: banked, or overstood.
    if (peers.ids.length) {
      const pts = ctx.gaps(peers.ids, a, b);
      const reads = gapReads(pts, k, a, b, (p) => p.behindS, ctx.tr.t);
      const all = swings(reads);
      if (goodLeg && anyGain(reads)) gainLegs++;
      if (all.length) gaveBack = true;
      for (const s of all) {
        const sep = lateralSep(ctx, peers.ids, s.tPeak);
        const sepM = sep ?? 0;
        const shift = Math.abs(windSwing(w.twdAt, s.tPeak, s.tTrough));
        const lay = laylineTest(ctx, k, a, s.tPeak, s.tTrough);
        const loss = s.gTrough - s.gPeak;
        if (!((sepM >= D5_SEP_M && shift >= D5_SHIFT_DEG) || (lay && loss >= D5_OVERSTAND_S))) continue;
        const places = peers.ids.map((id) => ctx.a.boats.find((x) => x.id === id)).map((x) => (x ? finishRank(x) : null)).filter((x): x is number => x != null);
        const side = sideOf(ctx, peers.ids, s.tPeak);
        const opp = make(lay ? 'overstand' : 'banked', peers.ids, s, sepM, side, lay, {
          peersAhead: peers.ahead ? 1 : 0,
          placeLo: places.length ? Math.min(...places) : null,
          placeHi: places.length ? Math.max(...places) : null,
        });
        found.push({ opp, rank: SPECIFIC[opp.variant] });
        break;
      }
    }
  });
  // Overlapping D5 stories on the same stretch: keep the most specific.
  const keep: Found[] = [];
  for (const f of [...found].sort((p, q) => q.rank - p.rank || q.opp.seconds - p.opp.seconds)) {
    if (keep.some((k) => k.opp.t0 < f.opp.t1 && f.opp.t0 < k.opp.t1)) continue;
    keep.push(f);
  }
  // ✓ only when the boat gained on its peers on a well-covered leg and never gave D5_LOSS_S of a gain back.
  const ok: GoodNote | null = !keep.length && gainLegs && !gaveBack ? { kind: 'ok', detector: 'D5', variant: 'banked', facts: {}, t0: ctx.gun, t1: ctx.gun } : null;
  return { opps: keep.map((f) => f.opp).sort((p, q) => p.t0 - q.t0), ok };
}

/** The boat's side of the group's median position at `t` (+ = right looking upwind), m; null without positions. */
function sideOf(ctx: CoachCtx, ids: string[], t: number): number | null {
  const p = posAt(ctx.tr, t);
  const q = ids.map((id) => ctx.m.tracks.get(id)).map((tr) => (tr ? posAt(tr, t) : null)).filter((x): x is [number, number] => !!x);
  if (!p || !q.length) return null;
  const mid: [number, number] = [median(q.map((v) => v[0])), median(q.map((v) => v[1]))];
  const r = (ctx.m.wind.twdAt(t) + 90) * (Math.PI / 180);
  return (p[0] - mid[0]) * Math.sin(r) + (p[1] - mid[1]) * Math.cos(r);
}
