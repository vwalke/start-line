/**
 * D11 · Heel (the tracker's IMU roll, analysis/heel.ts). Per beat (and, at a
 * lower confidence, per run), the boat's leeward heel is set against a
 * reference group's in matched windows: the same HEEL_WINDOW_MS of the clock,
 * both on the same leg, so both sailed the same breeze. The group is the
 * leaders (finish top 3); when fewer than HEEL_MIN_WINDOWS windows can be
 * matched with them, the peers (d5Peers: the boats that finished up to 6
 * places ahead, else Near ±3), capped at medium.
 *
 * - A window counts when the boat and at least HEEL_MIN_REFS reference boats
 *   each have HEEL_MIN_SAMPLES leeward-heel fixes in it (manoeuvres blanked),
 *   roll readings over HEEL_MIN_COVERAGE of it (fixes ≤ COACH_MAX_SPAN_S
 *   apart), and two course-over-ground samples for the speeds (angles.ts
 *   legSamples). The feed's roll is whole degrees: a window's mean rests on
 *   8+ fixes, and only differences of HEEL_DIFF_DEG (3°) or more count.
 * - Upwind fires when the boat's heel differs from the group's median by
 *   HEEL_DIFF_DEG or more, the same way, in HEEL_WINDOW_SHARE of the leg's
 *   windows (and in the median), and over those windows its VMG was at least
 *   HEEL_VMG_DROP below the group's (slower in at least half of them).
 *   'over' (more heeled) or 'under' (flatter). Downwind: 'windward' (heeled
 *   HEEL_DIFF_DEG more to windward) or 'rolling' (heel's spread within a
 *   window HEEL_STD_DEG above the group's), the same VMG tie; at most medium.
 * - Seconds (rate-type, as D6): Σ over the windows where heel differed of
 *   (VMG_ref − VMG_b) / VMG_ref × the window's length.
 * - The mirror: heel differed the same way and the boat's VMG was
 *   HEEL_VMG_DROP or more better: a ➕ (HEEL_PLUS_S or more). Beats measured
 *   with good data and within HEEL_DIFF_DEG of the group: the ✓.
 *
 * The boat's speed loss on a beat or run is D6's / D7's to claim: when they
 * fire on the same leg, D11 rides on their card as a chip (debrief.ts
 * attachHeel) rather than counting the same seconds twice.
 *
 * Data: heelTracks (the worker, from the raw fixes) — each boat's leeward
 * heel at most every HEEL_STEP_MS; an uploaded .vkx log (Boat.fullRate with
 * its roll) at its full rate. Without roll for the boat or its group: not
 * evaluated, never guessed.
 */
import { makeProjection, median } from '../../geo';
import { heelSeries } from '../../heel';
import { detectManoeuvres, signedTwa } from '../../manoeuvres';
import type { LegKind, RaceAnalysis } from '../../types';
import type { RaceData } from '../../../data/types';
import { makeTwdAt } from '../../wind';
import { RATE_REL_ERR, NOISE_BASE_S, coachCoverage, windOkShare, type Confidence, type Fact, type GoodNote, type Opportunity } from '../opportunity';
import { COACH_MAX_SPAN_S, trackLegAt, type CoachTrack } from '../tracks';
import { ANG_MIN_SAMPLES, legSamples, windBand } from './angles';
import { d5Peers } from './consolidate';
import type { CoachCtx } from './context';

/** Matched windows this long, ms… */
export const HEEL_WINDOW_MS = 120_000;
/** …and a leg's last, shorter window counts from this long, ms. */
export const HEEL_WINDOW_MIN_MS = 60_000;
/** Leeward-heel fixes a boat needs in a window. */
export const HEEL_MIN_SAMPLES = 8;
/** Share of a window with roll readings (fixes ≤ COACH_MAX_SPAN_S apart) a boat needs. */
export const HEEL_MIN_COVERAGE = 0.5;
/** Reference boats with heel a window needs. */
export const HEEL_MIN_REFS = 2;
/** Matched windows a leg needs to be evaluated. */
export const HEEL_MIN_WINDOWS = 3;
/** A heel difference counts from this, ° (the feed's roll is whole degrees). */
export const HEEL_DIFF_DEG = 3;
/** …in at least this share of the leg's windows. */
export const HEEL_WINDOW_SHARE = 0.6;
/** VMG at least this share below the group's over those windows. */
export const HEEL_VMG_DROP = 0.02;
/** Downwind: heel's spread (standard deviation) in a window this much above the group's, °. */
export const HEEL_STD_DEG = 2;
/** A ➕ from this many seconds gained. */
export const HEEL_PLUS_S = 10;
/** Heel fixes are kept at most this often from the feed (an uploaded log keeps every fix), ms. */
export const HEEL_STEP_MS = 1_000;

/** A boat's heel for the Coach: fix times, roll (NaN = no reading) and leeward heel (NaN near a manoeuvre or with the side unclear). */
export interface HeelTrack {
  t: Float64Array;
  roll: Float32Array;
  lee: Float32Array;
}

/**
 * Every racing boat's heel from the gun to a minute after its finish (or its last fix), as analyze.ts
 * works it out (heelSeries: the analysis's wind, its tacks and gybes blanked), from the raw fixes: an
 * uploaded log (Boat.fullRate with roll) at its full rate, the feed at most every HEEL_STEP_MS. Boats
 * without a roll reading are left out.
 */
export function heelTracks(a: RaceAnalysis, data: RaceData): Record<string, HeelTrack> {
  const out: Record<string, HeelTrack> = {};
  const sl = data.startLine;
  const proj = makeProjection({ lat: (sl.left.lat + sl.right.lat) / 2, lon: (sl.left.lon + sl.right.lon) / 2 });
  const twdAt = makeTwdAt(a.wind.estimates, a.wind.twdAtGunDeg);
  const byId = new Map(data.boats.map((b) => [b.id, b]));
  const gun = a.meta.gunMs;
  for (const r of a.boats) {
    const b = byId.get(r.id);
    if (!b) continue;
    const full = b.fullRate?.roll ? b.fullRate : null;
    const src = full ? { t: full.t, lat: full.lat, lon: full.lon, roll: full.roll! } : b.track.roll ? { t: b.track.t, lat: b.track.lat, lon: b.track.lon, roll: b.track.roll } : null;
    if (!src || !src.t.length) continue;
    const end = (r.finishMs ?? src.t[src.t.length - 1]) + 60_000;
    // From a little before the gun, so the course (and a tack) at the gun is known.
    let i0 = 0;
    while (i0 < src.t.length && src.t[i0] < gun - 30_000) i0++;
    let i1 = i0;
    while (i1 < src.t.length && src.t[i1] <= end) i1++;
    if (i1 - i0 < 2) continue;
    // No IMU in the window: skip before projecting / detecting manoeuvres (90-boat fleets, older feeds).
    let any = false;
    for (let k = i0; k < i1; k++) if (Number.isFinite(src.roll[k])) { any = true; break; }
    if (!any) continue;
    // Feed: thin to HEEL_STEP_MS before the expensive work. An uploaded log keeps every fix.
    const step = full ? 0 : HEEL_STEP_MS;
    const idx: number[] = [];
    let last = -Infinity;
    for (let k = i0; k < i1; k++) {
      if (src.t[k] - last < step - 50 && k !== i1 - 1) continue;
      idx.push(k);
      last = src.t[k];
    }
    if (idx.length < 2) continue;
    const n = idx.length;
    const t = Float64Array.from(idx, (k) => src.t[k]);
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const roll = Float32Array.from(idx, (k) => src.roll[k]);
    for (let k = 0; k < n; k++) {
      const p = proj.toXY(src.lat[idx[k]], src.lon[idx[k]]);
      x[k] = p[0];
      y[k] = p[1];
    }
    const xy = { t, x, y };
    const hs = heelSeries(t, roll, signedTwa(xy, twdAt).twa, detectManoeuvres(xy, twdAt, gun, end));
    const keep: number[] = [];
    for (let k = 0; k < n; k++) if (t[k] >= gun) keep.push(k);
    if (keep.length < 2) continue;
    out[r.id] = {
      t: Float64Array.from(keep, (k) => t[k]),
      roll: Float32Array.from(keep, (k) => roll[k]),
      lee: Float32Array.from(keep, (k) => hs.lee[k]),
    };
  }
  return out;
}

/** One boat in one window. */
export interface HeelSide {
  /** Time-weighted mean leeward heel, °. */
  heel: number;
  /** Standard deviation of the leeward-heel fixes, °. */
  std: number;
  /** Leeward-heel fixes. */
  n: number;
  /** Share of the window with roll readings. */
  cov: number;
  twa: number;
  sog: number;
  vmg: number;
}

/** Heel in [a, b): the mean (each fix holds to the next, never over COACH_MAX_SPAN_S), spread, fixes and coverage; null below the window's needs. */
export function heelIn(h: Pick<HeelTrack, 't' | 'roll' | 'lee'>, a: number, b: number): Pick<HeelSide, 'heel' | 'std' | 'n' | 'cov'> | null {
  const gap = COACH_MAX_SPAN_S * 1000;
  let read = 0;
  let sum = 0;
  let w = 0;
  const v: number[] = [];
  const t = h.t;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m] < a) lo = m + 1;
    else hi = m;
  }
  for (let k = Math.max(0, lo - 1); k < t.length - 1 && t[k] < b; k++) {
    const dt = Math.min(t[k + 1], b) - Math.max(t[k], a);
    if (t[k] >= a && Number.isFinite(h.lee[k])) v.push(h.lee[k]);
    if (t[k + 1] - t[k] > gap || dt <= 0) continue;
    if (Number.isFinite(h.roll[k])) read += dt;
    if (Number.isFinite(h.lee[k])) {
      sum += h.lee[k] * dt;
      w += dt;
    }
  }
  const cov = read / (b - a);
  if (v.length < HEEL_MIN_SAMPLES || cov < HEEL_MIN_COVERAGE || w <= 0) return null;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const std = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1));
  return { heel: sum / w, std, n: v.length, cov: Math.min(1, cov) };
}

export interface HeelWindow {
  t0: number;
  t1: number;
  boat: HeelSide;
  /** The reference boats' medians. */
  ref: HeelSide;
  ids: string[];
}

export type HeelVariant = 'over' | 'under' | 'windward' | 'rolling';

export interface LegHeel {
  leg: number;
  kind: 'upwind' | 'downwind';
  /** The group compared with. */
  ref: 'leaders' | 'peers';
  refIds: string[];
  windows: HeelWindow[];
  /** Median over the windows of boat − group heel, ° (+ = more heeled to leeward), and spread. */
  dHeel: number;
  dStd: number;
  /** How the boat's heel differed consistently (HEEL_WINDOW_SHARE of the windows and the median); null: it didn't. */
  variant: HeelVariant | null;
  /** The windows it differed in. */
  differ: HeelWindow[];
  /** Over those windows: (VMG_ref − VMG_b) / VMG_ref, time-weighted (+ = slower), and the seconds it adds up to. */
  deficit: number;
  seconds: number;
  /** Share of those windows the boat was slower in VMG. */
  slowerShare: number;
  /** The boat's leg: when, and the share of it the matched windows cover. */
  t0: number;
  t1: number;
  windowCov: number;
}

const vmgOf = (twa: number, sog: number, kind: LegKind): number => sog * Math.cos((twa * Math.PI) / 180) * (kind === 'upwind' ? 1 : -1);

type Samples = ReturnType<typeof legSamples>;

function speedIn(s: Samples, kind: LegKind, a: number, b: number): Pick<HeelSide, 'twa' | 'sog' | 'vmg'> | null {
  const idx: number[] = [];
  for (let i = 0; i < s.t.length; i++) if (s.t[i] >= a && s.t[i] < b) idx.push(i);
  if (idx.length < ANG_MIN_SAMPLES) return null;
  const twa = median(idx.map((i) => s.twa[i]));
  const sog = median(idx.map((i) => s.sog[i]));
  return { twa, sog, vmg: vmgOf(twa, sog, kind) };
}

/** The boat on `leg`: its timed leg, else the span of its fixes there. */
function legWin(ctx: CoachCtx, leg: number): [number, number] | null {
  const lr = ctx.me.legs[leg];
  if (lr) return [lr.startMs, lr.endMs];
  const ts = Array.from(ctx.tr.t).filter((t) => trackLegAt(ctx.tr, t) === leg);
  return ts.length >= 2 ? [ts[0], ts[ts.length - 1]] : null;
}

/** The matched windows on `leg` against `ids`. */
function windowsOn(ctx: CoachCtx, leg: number, kind: 'upwind' | 'downwind', ids: string[], span: [number, number]): HeelWindow[] {
  const heel = ctx.m.heel!;
  const mine = heel.get(ctx.boat)!;
  const twd = ctx.m.wind.twdAt;
  const mySp = legSamples(ctx.tr, leg, kind, twd);
  const refs = ids
    .map((id) => ({ id, h: heel.get(id), tr: ctx.m.tracks.get(id) }))
    .filter((r): r is { id: string; h: HeelTrack; tr: CoachTrack } => !!r.h && !!r.tr)
    .map((r) => ({ ...r, sp: legSamples(r.tr, leg, kind, twd) }));
  const out: HeelWindow[] = [];
  const [s0, s1] = span;
  for (let c = s0; c + HEEL_WINDOW_MIN_MS <= s1; c += HEEL_WINDOW_MS) {
    const e = Math.min(c + HEEL_WINDOW_MS, s1);
    const bh = heelIn(mine, c, e);
    const bs = bh && speedIn(mySp, kind, c, e);
    if (!bh || !bs) continue;
    const rs: (HeelSide & { id: string })[] = [];
    for (const r of refs) {
      // Same leg for the whole window (ends and the middle): the same breeze, the same kind of sailing.
      // Leaders who have already rounded onto the next beat/run are left out, not compared across legs.
      if (trackLegAt(r.tr, c) !== leg || trackLegAt(r.tr, e - 1) !== leg || trackLegAt(r.tr, (c + e) / 2) !== leg) continue;
      const h = heelIn(r.h, c, e);
      const s = h && speedIn(r.sp, kind, c, e);
      if (h && s) rs.push({ ...h, ...s, id: r.id });
    }
    if (rs.length < HEEL_MIN_REFS) continue;
    const med = (k: keyof HeelSide): number => median(rs.map((r) => r[k]));
    out.push({
      t0: c,
      t1: e,
      boat: { ...bh, ...bs },
      ref: { heel: med('heel'), std: med('std'), n: med('n'), cov: med('cov'), twa: med('twa'), sog: med('sog'), vmg: med('vmg') },
      ids: rs.map((r) => r.id),
    });
  }
  return out;
}

/** The leg's verdict from its windows. */
function verdict(kind: 'upwind' | 'downwind', ws: HeelWindow[]): Pick<LegHeel, 'dHeel' | 'dStd' | 'variant' | 'differ' | 'deficit' | 'seconds' | 'slowerShare'> {
  const dh = ws.map((w) => w.boat.heel - w.ref.heel);
  const ds = ws.map((w) => w.boat.std - w.ref.std);
  const dHeel = median(dh);
  const dStd = median(ds);
  const share = (f: (i: number) => boolean): HeelWindow[] => ws.filter((_, i) => f(i));
  const cands: { variant: HeelVariant; differ: HeelWindow[] }[] = [];
  if (kind === 'upwind') {
    if (dHeel >= HEEL_DIFF_DEG) cands.push({ variant: 'over', differ: share((i) => dh[i] >= HEEL_DIFF_DEG) });
    if (dHeel <= -HEEL_DIFF_DEG) cands.push({ variant: 'under', differ: share((i) => dh[i] <= -HEEL_DIFF_DEG) });
  } else {
    if (dHeel <= -HEEL_DIFF_DEG) cands.push({ variant: 'windward', differ: share((i) => dh[i] <= -HEEL_DIFF_DEG) });
    if (dStd >= HEEL_STD_DEG) cands.push({ variant: 'rolling', differ: share((i) => ds[i] >= HEEL_STD_DEG) });
  }
  const rated = cands
    .filter((c) => c.differ.length >= HEEL_WINDOW_SHARE * ws.length)
    .map((c) => {
      let lost = 0;
      let ms = 0;
      let slower = 0;
      for (const w of c.differ) {
        const len = w.t1 - w.t0;
        const d = w.ref.vmg > 0 ? (w.ref.vmg - w.boat.vmg) / w.ref.vmg : 0;
        lost += d * len;
        ms += len;
        if (w.boat.vmg < w.ref.vmg) slower++;
      }
      return { ...c, deficit: ms > 0 ? lost / ms : 0, seconds: lost / 1000, slowerShare: c.differ.length ? slower / c.differ.length : 0 };
    })
    .sort((p, q) => Math.abs(q.seconds) - Math.abs(p.seconds));
  const best = rated[0];
  if (!best) return { dHeel, dStd, variant: null, differ: [], deficit: 0, seconds: 0, slowerShare: 0 };
  return { dHeel, dStd, ...best };
}

/**
 * The heel comparison on `leg` (a beat or a run): against the leaders, else the peers when the leaders
 * give fewer than HEEL_MIN_WINDOWS windows; null when neither does (or there is no heel data).
 */
export function legHeel(ctx: CoachCtx, leg: number): LegHeel | null {
  const kind = ctx.a.legs[leg]?.kind;
  if ((kind !== 'upwind' && kind !== 'downwind') || !ctx.m.heel?.has(ctx.boat)) return null;
  const span = legWin(ctx, leg);
  if (!span) return null;
  const has = (id: string): boolean => !!ctx.m.heel!.get(id) && ctx.m.tracks.has(id);
  const sets: { ref: 'leaders' | 'peers'; ids: string[] }[] = [
    { ref: 'leaders', ids: ctx.leaders.filter(has) },
    { ref: 'peers', ids: d5Peers(ctx).ids.filter(has) },
  ];
  for (const s of sets) {
    if (s.ids.length < HEEL_MIN_REFS) continue;
    const ws = windowsOn(ctx, leg, kind, s.ids, span);
    if (ws.length < HEEL_MIN_WINDOWS) continue;
    const legMs = Math.max(1, span[1] - span[0]);
    return {
      leg,
      kind,
      ref: s.ref,
      refIds: s.ids,
      windows: ws,
      ...verdict(kind, ws),
      t0: span[0],
      t1: span[1],
      windowCov: Math.min(1, ws.reduce((x, w) => x + (w.t1 - w.t0), 0) / legMs),
    };
  }
  return null;
}

/** A leg's heel verdict cost time: it differed consistently and the boat was slower in VMG over those windows. */
export const heelFired = (l: LegHeel): boolean => l.variant != null && l.deficit >= HEEL_VMG_DROP && l.slowerShare >= 0.5 && l.seconds > 0;
/** …or gained: it differed and the boat was faster. */
export const heelGained = (l: LegHeel): boolean => l.variant != null && l.deficit <= -HEEL_VMG_DROP && l.slowerShare <= 0.5 && -l.seconds >= HEEL_PLUS_S;

/** Contiguous windows as one span. */
function joinSpans(ws: readonly HeelWindow[]): [number, number][] {
  const out: [number, number][] = [];
  for (const w of ws) {
    const last = out[out.length - 1];
    if (last && w.t0 <= last[1]) last[1] = Math.max(last[1], w.t1);
    else out.push([w.t0, w.t1]);
  }
  return out;
}

/**
 * A leg's numbers for the card, the chip and the ➕, over the windows it differed in (or all of them): heel and
 * angles their medians; the speeds time-weighted means, as the seconds are.
 */
export function heelFacts(ctx: CoachCtx, l: LegHeel): Record<string, Fact> {
  const ws = l.differ.length ? l.differ : l.windows;
  const m = (f: (w: HeelWindow) => number): number => median(ws.map(f));
  const tw = ws.reduce((s, w) => s + (w.t1 - w.t0), 0);
  const mean = (f: (w: HeelWindow) => number): number => ws.reduce((s, w) => s + f(w) * (w.t1 - w.t0), 0) / Math.max(1, tw);
  return {
    leg: ctx.a.legs[l.leg].name,
    legs: ctx.a.legs[l.leg].name,
    legKind: l.kind,
    variant: l.variant,
    ref: l.ref,
    refN: l.refIds.length,
    heel: m((w) => w.boat.heel),
    refHeel: m((w) => w.ref.heel),
    dHeel: m((w) => w.boat.heel - w.ref.heel),
    std: m((w) => w.boat.std),
    refStd: m((w) => w.ref.std),
    vmg: mean((w) => w.boat.vmg),
    refVmg: mean((w) => w.ref.vmg),
    // + = slower, kn.
    dVmg: mean((w) => w.ref.vmg - w.boat.vmg),
    sog: mean((w) => w.boat.sog),
    refSog: mean((w) => w.ref.sog),
    twa: m((w) => w.boat.twa),
    refTwa: m((w) => w.ref.twa),
    // + = sailed lower (wider of the wind) upwind, hotter downwind, °.
    dTwa: m((w) => (w.boat.twa - w.ref.twa) * (l.kind === 'upwind' ? 1 : -1)),
    wind: windBand(m((w) => w.ref.sog)),
    windows: l.differ.length,
    of: l.windows.length,
  };
}

export interface HeelResult {
  /** One per leg that fired, by time. */
  opps: Opportunity[];
  /** ✓ heel upwind within HEEL_DIFF_DEG of the group on every beat measured. */
  ok: GoodNote | null;
  /** ➕ legs where heel differed and the boat gained. */
  plus: GoodNote[];
  legs: LegHeel[];
  /** The kinds of leg the boat's heel could be compared on (the Regatta view's denominators). */
  evaluated: ('upwind' | 'downwind')[];
}

/** D11 over the race's beats and runs. */
export function detectHeel(ctx: CoachCtx): HeelResult {
  const legs = ctx.a.legs.map((_, k) => legHeel(ctx, k)).filter((x): x is LegHeel => !!x);
  const opps: Opportunity[] = [];
  const plus: GoodNote[] = [];
  for (const l of legs) {
    const facts = heelFacts(ctx, l);
    const spans = joinSpans(l.differ);
    if (heelFired(l)) {
      const covMs = l.windows.reduce((s, w) => s + (w.t1 - w.t0) * w.boat.cov, 0);
      const legMs = Math.max(1, l.t1 - l.t0);
      // The boat's heel data over the leg (matched windows × their roll coverage), never above its track's.
      const cov = Math.min(covMs / legMs, coachCoverage(ctx.tr.t, l.t0, l.t1));
      const seen = new Map<string, number>();
      for (const w of l.windows) for (const id of w.ids) seen.set(id, (seen.get(id) ?? 0) + 1);
      const shares = l.refIds.map((id) => (seen.get(id) ?? 0) / l.windows.length);
      const cap: Confidence | undefined = l.ref === 'peers' || l.kind === 'downwind' ? 'medium' : undefined;
      const noise = NOISE_BASE_S + RATE_REL_ERR * l.seconds;
      opps.push({
        kind: 'D11',
        variant: l.variant!,
        t0: spans[0][0],
        t1: spans[spans.length - 1][1],
        spans,
        seconds: l.seconds,
        secondsLo: Math.max(0, l.seconds - noise),
        secondsHi: l.seconds + noise,
        confidence: 'high',
        coverage: cov,
        conf: {
          boatCov: cov,
          refs: { good: shares.filter((s) => s >= 0.8).length, fair: shares.filter((s) => s >= 0.5).length, need: Math.min(3, l.refIds.length) },
          windOk: windOkShare(ctx.m.wind, l.t0, l.t1),
          ...(cap ? { refCap: cap } : {}),
        },
        facts,
        refBoats: l.refIds,
      });
    } else if (heelGained(l)) {
      plus.push({ kind: 'plus', detector: 'D11', variant: l.variant!, facts: { ...facts, gainS: -l.seconds }, t0: spans[0][0], t1: spans[spans.length - 1][1], seconds: -l.seconds });
    }
  }
  const beats = legs.filter((l) => l.kind === 'upwind' && l.windowCov >= 0.5);
  const okBeats = beats.filter((l) => Math.abs(l.dHeel) < HEEL_DIFF_DEG && !heelFired(l));
  // The chip shows the two medians over every window: they too must be within HEEL_DIFF_DEG.
  const mine = median(okBeats.flatMap((l) => l.windows.map((w) => w.boat.heel)));
  const theirs = median(okBeats.flatMap((l) => l.windows.map((w) => w.ref.heel)));
  const ok: GoodNote | null =
    beats.length && okBeats.length === beats.length && !opps.some((o) => o.facts.legKind === 'upwind') && Math.abs(mine - theirs) < HEEL_DIFF_DEG
      ? {
          kind: 'ok',
          detector: 'D11',
          variant: 'upwind',
          facts: { heel: mine, refHeel: theirs, ref: okBeats.every((l) => l.ref === 'leaders') ? 'leaders' : 'peers' },
          t0: okBeats[0].t0,
          t1: okBeats[okBeats.length - 1].t1,
        }
      : null;
  const evaluated = (['upwind', 'downwind'] as const).filter((k) => legs.some((l) => l.kind === k));
  return { opps, ok, plus, legs, evaluated };
}
