/**
 * D4 · Shift, wrong side / headed tack (spec §3; deep.py headed share). On
 * each beat, windows 3–10 min long slide over the boat's time on the leg. A
 * window fires when the fleet wind (twdSeries) moved D4_SHIFT_DEG or more
 * between its ends, the boat sat on the losing side of it — across the wind
 * from the leaders (the finish top 3) who were D4_SIDE_M or more toward the
 * side the shift favoured (a veer favours the right, a backing the left) — and
 * it spent at least D4_HEADED_X × those leaders' share of the window on the
 * headed tack (and at least D4_HEADED_MIN). Seconds = Δgap to those leaders
 * over the window (spec §2): the chart's bold line with them as its group (ctx.gaps,
 * the gap at equal course progress), its first point to its last; the window that lost most wins.
 * The shares are read inside the window, not over the whole beat: a beat's
 * other minutes (the start, the swing back after it) would wash the shift out
 * (R2 Beat 1: Good Trade 19 % vs Mirage 10 % over the beat, 20 % vs 0 % over
 * the shift).
 *
 * Headed share: the share of the boat's upwind course-over-ground samples on
 * the tack headed against the wind's HEADED_MEAN_MS mean by more than
 * HEADED_DEG (a backing heads starboard, a veer port).
 */
import { bearingVec, dot, median, sub, wrap180 } from '../../geo';
import { posAt, trackLegAt, type CoachTrack } from '../tracks';
import { cogPairs, type TwdSeries } from '../twdSeries';
import { WIND_EST_S, coachCoverage, gapChange, gapNoise, rangeOf, reading, refCoverage, untrackedS, windOkShare, type GoodNote, type Opportunity } from '../opportunity';
import type { CoachCtx } from './context';

export const D4_MIN_WINDOW_MS = 3 * 60_000;
export const D4_MAX_WINDOW_MS = 10 * 60_000;
/** Window ends step this much, ms. */
export const D4_STEP_MS = 60_000;
export const D4_SHIFT_DEG = 8;
/** One shift, not a swing: the end-to-end change is at least this share of the wind's range inside the window (a swing back is D5's). */
export const D4_MONOTONE = 0.75;
/** A leader counts as on the other side when its mean across-wind distance from the boat over the window is this much toward the favoured side, m. */
export const D4_SIDE_M = 100;
export const D4_HEADED_X = 2;
/** …and the boat's headed share is at least this (2 × a leader's 0 % is no bar), 0–1. */
export const D4_HEADED_MIN = 0.1;
/** Headed: more than this off the mean wind, °… */
export const HEADED_DEG = 3;
/** …the mean of the measured minutes this wide, centred, ms. */
export const HEADED_MEAN_MS = 10 * 60_000;
/** Upwind samples: moving faster than this, kn, with |TWA| in this band, °. */
export const HEADED_MIN_SOG_KN = 2.5;
export const HEADED_TWA: [number, number] = [20, 70];
/** A headed share needs this many samples. */
export const HEADED_MIN_SAMPLES = 20;
/** Separation is sampled this often across a window, ms. */
export const SEP_STEP_MS = 30_000;
/** ✓ Shifts needs a beat this well covered. */
export const D4_OK_COVERAGE = 0.5;

/** The mean of the measured wind minutes within HEADED_MEAN_MS / 2 of `t` (twdAt(t) with none), °. */
export function twdMean(w: Pick<TwdSeries, 't' | 'twd' | 'ok' | 'twdAt'>, t: number): number {
  const at = w.twdAt(t);
  let s = 0;
  let n = 0;
  for (let i = 0; i < w.t.length; i++) {
    if (!w.ok[i] || Math.abs(w.t[i] - t) > HEADED_MEAN_MS / 2) continue;
    s += wrap180(w.twd[i] - at);
    n++;
  }
  return n ? at + s / n : at;
}

/** A boat's upwind samples on one leg: times, and how many of them up to each were on the headed tack. */
export interface HeadedSamples {
  t: number[];
  /** cum[i]: headed samples among t[0..i]. */
  cum: number[];
}

/** The boat's upwind course-over-ground samples on `leg` (moving, |TWA| in HEADED_TWA), each marked headed or not. */
export function headedSamples(tr: Pick<CoachTrack, 't' | 'x' | 'y' | 'bounds' | 'spans'>, leg: number, w: Pick<TwdSeries, 't' | 'twd' | 'ok' | 'twdAt'>): HeadedSamples {
  const c = cogPairs(tr);
  const out: HeadedSamples = { t: [], cum: [] };
  let h = 0;
  for (let i = 0; i < c.t.length; i++) {
    if (!(c.sogKn[i] > HEADED_MIN_SOG_KN) || trackLegAt(tr, c.t[i]) !== leg) continue;
    const twd = w.twdAt(c.t[i]);
    const twa = wrap180(twd - c.cog[i]); // + = starboard
    if (Math.abs(twa) <= HEADED_TWA[0] || Math.abs(twa) >= HEADED_TWA[1]) continue;
    const shift = wrap180(twd - twdMean(w, c.t[i])); // + = veered
    if (twa > 0 ? shift < -HEADED_DEG : shift > HEADED_DEG) h++;
    out.t.push(c.t[i]);
    out.cum.push(h);
  }
  return out;
}

/** The headed share of the samples in [from, to], with their count; null under HEADED_MIN_SAMPLES. */
export function shareIn(s: HeadedSamples, from = -Infinity, to = Infinity): { share: number; n: number } | null {
  const lo = s.t.findIndex((t) => t >= from);
  if (lo < 0) return null;
  let hi = lo - 1;
  while (hi + 1 < s.t.length && s.t[hi + 1] <= to) hi++;
  const n = hi - lo + 1;
  if (n < HEADED_MIN_SAMPLES) return null;
  return { share: (s.cum[hi] - (lo > 0 ? s.cum[lo - 1] : 0)) / n, n };
}

/** Share of the boat's upwind samples on `leg` in [from, to] sailed on the headed tack, with the count; null with too few. */
export const headedShare = (
  tr: Pick<CoachTrack, 't' | 'x' | 'y' | 'bounds' | 'spans'>,
  leg: number,
  w: Pick<TwdSeries, 't' | 'twd' | 'ok' | 'twdAt'>,
  from = -Infinity,
  to = Infinity,
): { share: number; n: number } | null => shareIn(headedSamples(tr, leg, w), from, to);

/** The boat's across-wind offset from `ref` at `t` (+ = the boat is to the right looking upwind), m; null without both fixes. */
export function signedSep(me: Pick<CoachTrack, 't' | 'x' | 'y'>, ref: Pick<CoachTrack, 't' | 'x' | 'y'>, t: number, twdDeg: number): number | null {
  const p = posAt(me, t);
  const q = posAt(ref, t);
  return p && q ? dot(sub(p, q), bearingVec(twdDeg + 90)) : null;
}

/** Mean signed separation over [a, b] sampled every SEP_STEP_MS across a fixed wind (`twdDeg`); null with under half the samples. */
export function meanSep(me: CoachTrack, ref: CoachTrack, a: number, b: number, twdDeg: number): number | null {
  const v: number[] = [];
  let n = 0;
  for (let t = a; t <= b; t += SEP_STEP_MS) {
    n++;
    const s = signedSep(me, ref, t, twdDeg);
    if (s != null) v.push(s);
  }
  return v.length && v.length >= n / 2 ? v.reduce((x, y) => x + y, 0) / v.length : null;
}

/** The mean wind over [a, b] (twdAt every minute, averaged about the first), °. */
export function windowTwd(twdAt: (t: number) => number, a: number, b: number): number {
  const w0 = twdAt(a);
  let s = 0;
  let n = 0;
  for (let t = a; t <= b; t += 60_000) {
    s += wrap180(twdAt(t) - w0);
    n++;
  }
  return w0 + s / Math.max(1, n);
}

/** The wind's range (max − min, about the start) over [a, b], read every minute, °. */
export function twdRange(twdAt: (t: number) => number, a: number, b: number): number {
  const w0 = twdAt(a);
  let lo = 0;
  let hi = 0;
  for (let t = a; t <= b + 1; t += Math.min(60_000, Math.max(1, b - a))) {
    const d = wrap180(twdAt(Math.min(t, b)) - w0);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return hi - lo;
}

/** First and last fix of the boat on `leg`, ms; null when it has fewer than two. */
export function legWindow(tr: CoachTrack, leg: number): [number, number] | null {
  let a: number | null = null;
  let b: number | null = null;
  for (let i = 0; i < tr.t.length; i++) {
    if (trackLegAt(tr, tr.t[i]) !== leg) continue;
    a ??= tr.t[i];
    b = tr.t[i];
  }
  return a != null && b != null && b > a ? [a, b] : null;
}

export interface ShiftWindow {
  leg: number;
  t0: number;
  t1: number;
  /** Wind change over the window, ° (+ = veered). */
  dTwd: number;
  twd0: number;
  twd1: number;
  /** The leaders on the favoured side, their mean separations (the boat's offset, + = right) and the Δgap to them (g0 → g1). */
  refs: string[];
  seps: number[];
  dgap: number;
  g0: number;
  g1: number;
}

interface Best {
  win: ShiftWindow;
  headed: number;
  ldrHeaded: { id: string; share: number }[];
}

export interface ShiftResult {
  opp: Opportunity | null;
  ok: GoodNote | null;
}

export function detectShift(ctx: CoachCtx): ShiftResult {
  const w = ctx.m.wind;
  const leaders = ctx.leaders.filter((id) => ctx.m.tracks.has(id));
  if (!leaders.length) return { opp: null, ok: null };
  const ltr = leaders.map((id) => ctx.m.tracks.get(id)!);
  const cross = ctx.m.crossMs?.[ctx.boat] ?? null;
  // Set inside the legs' callback: a holder, so the type isn't narrowed to its initial null.
  const top: { best: Best | null } = { best: null };
  // For the ✓: well-covered beats with a shift, and whether the boat was ever on its losing side.
  const lifted: number[] = [];
  let losingLegs = 0;
  ctx.a.legs.forEach((leg, k) => {
    if (leg.kind !== 'upwind') return;
    const lw = legWindow(ctx.tr, k);
    if (!lw) return;
    const a = Math.max(lw[0], cross ?? -Infinity);
    const b = lw[1];
    if (b - a < D4_MIN_WINDOW_MS) return;
    const mine = headedSamples(ctx.tr, k, w);
    const theirs = ltr.map((tr) => headedSamples(tr, k, w));
    const goodLeg = coachCoverage(ctx.tr.t, a, b) >= D4_OK_COVERAGE;
    let shiftSeen = false;
    let losing = false;
    for (let t0 = a; t0 + D4_MIN_WINDOW_MS <= b; t0 += D4_STEP_MS) {
      for (let t1 = t0 + D4_MIN_WINDOW_MS; t1 <= Math.min(b, t0 + D4_MAX_WINDOW_MS); t1 += D4_STEP_MS) {
        const twd0 = w.twdAt(t0);
        const twd1 = w.twdAt(t1);
        const dTwd = wrap180(twd1 - twd0);
        if (Math.abs(dTwd) < D4_SHIFT_DEG || Math.abs(dTwd) < D4_MONOTONE * twdRange(w.twdAt, t0, t1)) continue;
        shiftSeen = true;
        const axis = windowTwd(w.twdAt, t0, t1);
        // Leaders toward the favoured side: the boat's offset from them has the opposite sign to the shift.
        const ks: number[] = [];
        const seps: number[] = [];
        ltr.forEach((tr, i) => {
          const s = meanSep(ctx.tr, tr, t0, t1, axis);
          if (s != null && s * Math.sign(dTwd) <= -D4_SIDE_M) {
            ks.push(i);
            seps.push(s);
          }
        });
        if (!ks.length) continue;
        losing = true;
        const me = shareIn(mine, t0, t1);
        const ldr = ks.map((i) => ({ id: leaders[i], h: shareIn(theirs[i], t0, t1) })).filter((x) => x.h != null);
        if (!me || !ldr.length || me.share < D4_HEADED_MIN || me.share < D4_HEADED_X * median(ldr.map((x) => x.h!.share))) continue;
        // The chart with those leaders as its group (Custom): its bold line.
        const refs = ks.map((i) => leaders[i]);
        const g = gapChange(ctx.gaps(refs, a, b), t0, t1);
        if (!g) continue;
        const dgap = g.g1 - g.g0;
        if (dgap <= 0 || (top.best && dgap <= top.best.win.dgap)) continue;
        top.best = {
          win: { leg: k, t0: g.t0, t1: g.t1, dTwd, twd0, twd1, refs, seps, dgap, g0: g.g0, g1: g.g1 },
          headed: me.share,
          ldrHeaded: ldr.map((x) => ({ id: x.id, share: x.h!.share })),
        };
      }
    }
    if (goodLeg && shiftSeen) {
      if (losing) losingLegs++;
      else lifted.push(k);
    }
  });
  const best = top.best;
  if (!best) {
    // ✓ only when every well-covered beat with a shift had the boat on the favoured side of the leaders.
    const ok: GoodNote | null =
      lifted.length && !losingLegs
        ? { kind: 'ok', detector: 'D4', variant: 'lifted', facts: { legs: lifted.map((k) => ctx.a.legs[k].name).join(' + ') }, t0: ctx.gun, t1: ctx.gun }
        : null;
    return { opp: null, ok };
  }
  const { win, headed, ldrHeaded } = best;
  // The named leader: the one furthest toward the favoured side ("Mirage held left").
  const far = win.seps.map((s, i) => ({ s, i })).sort((p, q) => Math.abs(q.s) - Math.abs(p.s))[0];
  const ldr = win.refs[far.i];
  const sepM = median(win.seps.map(Math.abs));
  const cov = coachCoverage(ctx.tr.t, win.t0, win.t1);
  const seconds = win.dgap;
  const { noise, windS } = gapNoise(sepM, ctx.m.vmg[win.leg], untrackedS(ctx.tr.t, win.t0, win.t1));
  const range = rangeOf(seconds, noise);
  const refTracks = win.refs.map((id) => ctx.m.tracks.get(id)).filter((x): x is CoachTrack => !!x);
  const side = Math.sign(median(win.seps)) > 0 ? 'right' : 'left';
  return {
    opp: {
      kind: 'D4',
      variant: 'headed',
      t0: win.t0,
      t1: win.t1,
      seconds,
      ...range,
      confidence: 'high',
      coverage: cov,
      conf: {
        boatCov: cov,
        refs: refCoverage(refTracks, win.t0, win.t1),
        windOk: windOkShare(w, win.t0, win.t1),
        rangeShare: (range.secondsHi - range.secondsLo) / Math.max(1, seconds),
      },
      facts: {
        leg: ctx.a.legs[win.leg].name,
        shift: Math.abs(win.dTwd),
        dir: win.dTwd < 0 ? 'left' : 'right',
        twd0: win.twd0,
        twd1: win.twd1,
        side,
        otherSide: side === 'right' ? 'left' : 'right',
        headed,
        ldr: ctx.nameOf(ldr),
        ldrHeaded: ldrHeaded.find((x) => x.id === ldr)?.share ?? (ldrHeaded.length ? median(ldrHeaded.map((x) => x.share)) : null),
        sepM: Math.abs(win.seps[far.i]),
        refs: win.refs.length,
      },
      refBoats: win.refs,
      windEst: windS >= WIND_EST_S,
      gaps: [reading(win.refs, win)],
    },
    ok: null,
  };
}
