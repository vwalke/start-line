/**
 * "Color: VMG" for the track map: every stretch of track shaded by the boat's velocity made good toward where its leg
 * ends (analysis/coach/trackVmg.ts: into the wind up a beat, down it on a run, toward the mark on a reach), from the
 * SOG Boat speed draws (4 s mean) along the course over ground the tooltip shows (mapPoints.ts cogAt), on the ladder's
 * smoothed wind of the moment. Drawn as Boat speed is (ui/sog.ts: the same trimmed turbo, bins, batched paths, and
 * per-leg or whole-race scale on the fleet's 5th–95th percentile), but the range may run below zero (losing ground).
 *
 * VMG needs the Coach's wind (the coach model, which may arrive after the map's first paint): until then the tracks
 * are a neutral gray (sog.ts neutralStroke) and the key shows the bar alone.
 */
import type { CoachModel } from '../analysis/coach';
import { vmgFrame, vmgKn } from '../analysis/coach/trackVmg';
import type { RaceAnalysis } from '../analysis/types';
import { f1 } from './format';
import { cogAt } from './mapPoints';
import type { SrcTrack } from './mapPieces';
import { segmentRange, sogHoverLeg, sogKey, sogKeyPending, sogLegKey, sogRange, type RangeOf, type SogRange } from './sog';
import type { SogScale } from './speed';

/** One source's VMG per fix, worked out as the map first draws each stretch (`done`), kept per model. */
interface SrcVmg {
  v: Float32Array;
  done: Uint8Array;
}

const perModel = new WeakMap<CoachModel, WeakMap<SrcTrack, SrcVmg>>();

/**
 * VMG (kn) at each fix of `src` drawn on leg `leg`, indexed as `src` (fixes [i0, i1) worked out, once per model and
 * source): the arrays are kept, so drawing a frame allocates nothing once a stretch has been seen.
 */
export function vmgValues(m: CoachModel, src: SrcTrack, leg: number, i0 = 0, i1 = src.t.length): Float32Array {
  let bySrc = perModel.get(m);
  if (!bySrc) perModel.set(m, (bySrc = new WeakMap()));
  let s = bySrc.get(src);
  if (!s) bySrc.set(src, (s = { v: new Float32Array(src.t.length).fill(NaN), done: new Uint8Array(src.t.length) }));
  const f = vmgFrame(m);
  const hi = Math.min(i1, src.t.length);
  for (let i = Math.max(0, i0); i < hi; i++) {
    if (s.done[i]) continue;
    s.v[i] = vmgKn(f.course, f.twdAt(src.t[i]), leg, src.x[i], src.y[i], src.sog[i], cogAt(src.x, src.y, i));
    s.done[i] = 1;
  }
  return s.v;
}

/** A point as the tooltip and the boats read it: where, when, on which leg, at what SOG and COG. */
export interface VmgPoint {
  t: number;
  leg: number;
  x: number;
  y: number;
  sog: number;
  cog: number;
}

/** VMG (kn) at one point (a boat's dot at the scrubber's time, a hovered fix): the same reading as the tracks. */
export function vmgAt(m: CoachModel, p: VmgPoint): number {
  const f = vmgFrame(m);
  return vmgKn(f.course, f.twdAt(p.t), p.leg, p.x, p.y, p.sog, p.cog);
}

/** The tooltip's line: "VMG 5.2 kn" (null where there's no reading). */
export function vmgTipLine(m: CoachModel, p: VmgPoint): string | null {
  const v = vmgAt(m, p);
  return Number.isFinite(v) ? `VMG ${v < 0 ? '−' : ''}${f1(Math.abs(v))} kn` : null;
}

const ranges = new WeakMap<CoachModel, Map<string, SogRange | null>>();

/** The track map's VMG range: the racing fleet's VMG over leg `leg`, or the whole race (null), at every drawn fix. */
export function trackVmgRange(a: RaceAnalysis, m: CoachModel, leg: number | null): SogRange | null {
  let byKey = ranges.get(m);
  if (!byKey) ranges.set(m, (byKey = new Map()));
  const key = `leg:${leg}`;
  if (!byKey.has(key)) {
    byKey.set(
      key,
      sogRange(
        (function* () {
          for (const d of a.drawings) for (const s of d.segments) if (leg == null || s.leg === leg) yield* vmgValues(m, s, s.leg);
        })(),
        -Infinity,
      ),
    );
  }
  return byKey.get(key)!;
}

/** VMG's ranges for race `a` (sog.ts RangeOf). */
export const vmgRangeOf = (a: RaceAnalysis, m: CoachModel): RangeOf => (leg) => trackVmgRange(a, m, leg);

/** The range a segment of leg `segLeg` is binned on (sog.ts segmentRange, on VMG's ranges). */
export const segmentVmgRange = (a: RaceAnalysis, m: CoachModel, segLeg: number, view: number | null, scale: SogScale): SogRange | null =>
  segmentRange(vmgRangeOf(a, m), segLeg, view, scale);

/** The hover's leg line: "Beat 2 · range 3.5–6.0 kn" when scaled per leg, else the leg. */
export const vmgHoverLeg = (a: RaceAnalysis, m: CoachModel, leg: number, view: number | null, scale: SogScale): string =>
  sogHoverLeg(a, leg, view, scale, vmgRangeOf(a, m));

/**
 * The key: one leg or the whole race on one range, "VMG · Beat 2" under knots; Per leg, "VMG: low → high within each
 * leg" and each leg's range. `m` undefined: the wind is still on its way (the bar alone); null: no VMG for this race.
 */
export function vmgKey(a: RaceAnalysis, m: CoachModel | null | undefined, leg: number | null, scale: SogScale): string {
  if (m === undefined) return sogKeyPending('VMG');
  if (!m) return sogKey(null, undefined, 'VMG');
  if (leg == null && scale === 'leg') return sogLegKey(a, vmgRangeOf(a, m), 'VMG', ['low', 'high']);
  return sogKey(trackVmgRange(a, m, leg), leg == null ? 'Whole race' : (a.legs[leg]?.name ?? 'This leg'), 'VMG');
}
