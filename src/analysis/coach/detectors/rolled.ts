/**
 * D2 · Speed at the gun / rolled (spec §3), gun → +60 s. A neighbour bow-level
 * at the gun (its distance to the line within D2_ALONG_LOA boatlengths of the
 * boat's) and to windward (D2_WWD_LOA along the line on the side the wind
 * comes over: the committee-boat end on starboard), going faster
 * (own SOG < D2_SPEED_RATIO × its SOG), that gained a boatlength or more by
 * +60 s along the boat's own course (rolling is measured along the heading,
 * not up the wind). Never a card of its own: a chip on D3.
 */
import { dot, len, sub, type Vec } from '../../geo';
import { posAt, type CoachTrack } from '../tracks';
import type { AttachedChip } from '../opportunity';
import type { CoachCtx } from './context';

export const D2_ALONG_LOA = 1;
export const D2_WWD_LOA: [number, number] = [0.5, 3];
export const D2_SPEED_RATIO = 0.75;
export const D2_GAIN_LOA = 1;
/** The gain is read from the first second both are tracked (within this of the gun) to +60 s (±10 s), ms. */
export const D2_READ_MS = 20_000;
export const D2_AT_MS = 60_000;

/** The first time from `from` toward `to` (1 s steps) where both boats have a position: their positions. */
function bothAt(ctx: CoachCtx, n: CoachTrack, from: number, to: number): { b: Vec; n: Vec } | null {
  const step = to >= from ? 1000 : -1000;
  for (let t = from; step > 0 ? t <= to : t >= to; t += step) {
    const pb = posAt(ctx.tr, t);
    const pn = posAt(n, t);
    if (pb && pn) return { b: pb, n: pn };
  }
  return null;
}

/** How far the neighbour gained on the boat along the boat's own course from the gun to +60 s, m; null unless both are tracked at both ends. */
export function rollGainM(ctx: CoachCtx, nbr: string): number | null {
  const n = ctx.m.tracks.get(nbr);
  if (!n) return null;
  const s0 = bothAt(ctx, n, ctx.gun, ctx.gun + D2_READ_MS);
  const at = ctx.gun + D2_AT_MS;
  const s1 = bothAt(ctx, n, at, at + 10_000) ?? bothAt(ctx, n, at, at - 10_000);
  if (!s0 || !s1) return null;
  const d = sub(s1.b, s0.b);
  const L = len(d);
  if (!(L > 0)) return null;
  const dir: Vec = [d[0] / L, d[1] / L];
  return dot(sub(s1.n, s1.b), dir) - dot(sub(s0.n, s0.b), dir);
}

export function detectRolled(ctx: CoachCtx): AttachedChip | null {
  const me = ctx.me.start;
  if (!me || !(me.speedKn > 0)) return null;
  const L = ctx.loaM;
  const lineM = ctx.a.line.lengthM;
  // Starboard (+): the wind comes over the right, the committee-boat end of the line.
  const wwdSign = me.twaDeg >= 0 ? 1 : -1;
  let best: AttachedChip | null = null;
  let bestRatio = 0;
  for (const o of ctx.a.boats) {
    const s = o.start;
    if (o.id === ctx.boat || !s || !(s.speedKn > 0)) continue;
    if (Math.abs(s.dtlM - me.dtlM) > D2_ALONG_LOA * L) continue;
    const wwd = ((s.linePosPct - me.linePosPct) / 100) * lineM * wwdSign;
    if (wwd < D2_WWD_LOA[0] * L || wwd > D2_WWD_LOA[1] * L) continue;
    if (!(me.speedKn < D2_SPEED_RATIO * s.speedKn)) continue;
    const gain = rollGainM(ctx, o.id);
    if (gain == null || gain < D2_GAIN_LOA * L) continue;
    const ratio = s.speedKn / me.speedKn;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = { kind: 'D2', facts: { sog: me.speedKn, nbr: o.id, nbrName: ctx.nameOf(o.id), nbrSog: s.speedKn, nbrM: wwd, gainM: gain } };
    }
  }
  return best;
}
