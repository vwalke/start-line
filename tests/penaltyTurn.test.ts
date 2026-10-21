import { describe, expect, it } from 'vitest';
import { TURN_MARK_M, findTurns, turnLossS, type TurnTrack } from '../src/analysis/coach/detectors/penaltyTurn';
import type { Vec } from '../src/analysis/geo';

/**
 * D12 on synthetic tracks: a boat sailing at `speed` m/s, turning at `rate` °/s (+ = clockwise) for `s` seconds per
 * piece, sampled at `hz`; a `gap` piece sails on with no fixes. Headings are degrees from +y, as the analysis frame.
 */
type Piece = { s: number; rate?: number; speed?: number; gap?: boolean };
const T0 = 1_800_000_000_000;

function track(pieces: Piece[], o: { hz?: number; hdg?: number; at?: Vec; jitterM?: number; seed?: number } = {}): TurnTrack {
  const hz = o.hz ?? 1;
  const dt = 0.05;
  let [x, y] = o.at ?? [0, 0];
  let h = o.hdg ?? 0;
  let t = 0;
  let next = 0;
  let seed = o.seed ?? 1;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const out: { t: number[]; x: number[]; y: number[] } = { t: [], x: [], y: [] };
  for (const p of pieces) {
    const end = t + p.s;
    while (t < end - 1e-9) {
      if (t >= next - 1e-9) {
        if (!p.gap) {
          out.t.push(T0 + Math.round(t * 1000));
          out.x.push(x + (o.jitterM ?? 0) * rnd());
          out.y.push(y + (o.jitterM ?? 0) * rnd());
        }
        next += 1 / hz;
      }
      h += (p.rate ?? 0) * dt;
      const v = p.speed ?? 3;
      x += v * Math.sin((h * Math.PI) / 180) * dt;
      y += v * Math.cos((h * Math.PI) / 180) * dt;
      t += dt;
    }
  }
  return { t: out.t, x: out.x, y: out.y };
}

const opts = (tr: TurnTrack, marks: Vec[] = []) => ({ fromMs: tr.t[0], toMs: tr.t[tr.t.length - 1], marks });
const straight = (s: number, speed = 3): Piece => ({ s, speed });

describe('D12 penalty turns: the loops', () => {
  it('straight → a 720 → straight: two turns, its time and the seconds lost', () => {
    // 720° at 12 °/s = 60 s, slowing to 2 m/s in the loop.
    const tr = track([straight(60), { s: 60, rate: 12, speed: 2 }, straight(60)]);
    const turns = findTurns(tr, opts(tr));
    expect(turns).toHaveLength(1);
    const t = turns[0];
    expect(t.turns).toBe(2);
    expect(t.deg).toBeGreaterThanOrEqual(660);
    expect(t.conf).toBe('medium');
    expect((t.t0 - T0) / 1000).toBeGreaterThanOrEqual(58);
    expect((t.t0 - T0) / 1000).toBeLessThanOrEqual(64);
    expect((t.t1 - T0) / 1000).toBeGreaterThanOrEqual(115);
    expect((t.t1 - T0) / 1000).toBeLessThanOrEqual(122);
    // Over the loop and 15 s after it the boat made no way along its course: about the loop's time plus a little.
    expect(t.lostS).toBeGreaterThan(45);
    expect(t.lostS).toBeLessThan(80);
  });

  it('a 360 is one turn, the other way round too; high confidence from a full-rate log', () => {
    const tr = track([straight(60), { s: 30, rate: -12, speed: 2.5 }, straight(60)], { hz: 10 });
    const turns = findTurns(tr, { ...opts(tr), fullRate: true });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turns: 1, conf: 'high' });
    expect(turns[0].deg).toBeLessThanOrEqual(-300);
  });

  it('a 720 read off a sparse feed (a fix every 4 s) is still two turns', () => {
    const tr = track([straight(60), { s: 64, rate: 11.25, speed: 2 }, straight(60)], { hz: 0.25 });
    const turns = findTurns(tr, opts(tr));
    expect(turns.map((t) => t.turns)).toEqual([2]);
  });

  it('seconds lost: none when the boat sails straight through the window', () => {
    const tr = track([straight(120)]);
    expect(turnLossS(tr, T0 + 50_000, T0 + 70_000)).toBeCloseTo(0, 0);
  });
});

describe('D12: what is not a penalty turn', () => {
  it('a tack (~90°) and a gybe (~80°)', () => {
    const tack = track([straight(60), { s: 8, rate: 11 }, straight(60)]);
    const gybe = track([straight(60), { s: 8, rate: -10 }, straight(60)]);
    expect(findTurns(tack, opts(tack))).toEqual([]);
    expect(findTurns(gybe, opts(gybe))).toEqual([]);
  });

  it('a tack, then a bear-away and gybe the same way 15 s later (320° in under a minute, straight sailing between)', () => {
    const tr = track([straight(60), { s: 10, rate: 10 }, straight(15), { s: 20, rate: 11 }, straight(60)]);
    expect(findTurns(tr, opts(tr))).toEqual([]);
  });

  it('a 245° turn, 10 s nearly straight (drifting 0.7 °/s, with GPS jitter), then 115° on: two manoeuvres (J/24 R5 USA 3359 in the scan)', () => {
    const tr = track([straight(60), { s: 20, rate: -12.25 }, { s: 10, rate: -0.7 }, { s: 12, rate: -9.5 }, straight(60)], { jitterM: 0.4, seed: 3 });
    expect(findTurns(tr, opts(tr))).toEqual([]);
  });

  it('a tack, 12 s straight, then a genuine 360: one turn, timed on the 360 alone (J/24 R2 USA 537 in the scan)', () => {
    // A little GPS jitter: the 360's stretch may open on a step the other way; its way round is its net turn.
    for (const seed of [1, 2, 3, 4, 5]) {
      const tr = track([straight(60), { s: 10, rate: -13 }, straight(12), { s: 20, rate: -18, speed: 2.5 }, straight(60)], { jitterM: 0.3, seed });
      const turns = findTurns(tr, opts(tr));
      expect(turns).toHaveLength(1);
      expect(turns[0].turns).toBe(1);
      expect(turns[0].deg).toBeLessThan(-300);
      expect((turns[0].t0 - T0) / 1000).toBeGreaterThanOrEqual(78);
      expect(Math.abs(turns[0].deg)).toBeLessThan(400);
    }
  });

  it('seconds lost read off the course just before the loop: a bear-away 20 s earlier doesn’t zero it (J/111 R2 USA 026 in the scan)', () => {
    const tr = track([straight(60), { s: 6, rate: -8 }, straight(18), { s: 30, rate: -12, speed: 1.5 }, straight(60)]);
    const turns = findTurns(tr, opts(tr));
    expect(turns).toHaveLength(1);
    expect(turns[0].lostS).toBeGreaterThan(20);
  });

  it('tacking back and forth (a tack, then a tack the other way): no loop', () => {
    const tr = track([straight(30), { s: 8, rate: 11 }, straight(5), { s: 8, rate: -11 }, straight(5), { s: 8, rate: 11 }, straight(5), { s: 8, rate: -11 }, straight(30)]);
    expect(findTurns(tr, opts(tr))).toEqual([]);
  });

  it('a loop round a mark (a 360 within the mark zone) is a rounding, the same loop away from it a turn', () => {
    const tr = track([straight(60), { s: 30, rate: 12, speed: 2.5 }, straight(60)]);
    // The loop's centre: about where the boat was at +75 s (it sails up the y axis at 3 m/s first).
    const near: Vec = [10, 190];
    const far: Vec = [10, 190 + TURN_MARK_M + 200];
    expect(findTurns(tr, opts(tr, [near]))).toEqual([]);
    expect(findTurns(tr, opts(tr, [far]))).toHaveLength(1);
  });

  it('a hole mid-turn is never integrated across (a 360 with 12 s missing)', () => {
    const tr = track([straight(60), { s: 12, rate: 12, speed: 2.5 }, { s: 12, rate: 12, speed: 2.5, gap: true }, { s: 12, rate: 12, speed: 2.5 }, straight(60)]);
    expect(findTurns(tr, opts(tr))).toEqual([]);
  });

  it('a circle before the start (the gun is fromMs) is ignored', () => {
    const tr = track([straight(20), { s: 30, rate: 12, speed: 2.5 }, straight(120)]);
    expect(findTurns(tr, opts(tr))).toHaveLength(1);
    expect(findTurns(tr, { ...opts(tr), fromMs: T0 + 60_000 })).toEqual([]);
  });

  it('a drifting boat (0.2 m/s, ±2 m GPS jitter) does not turn in circles', () => {
    const tr = track([{ s: 300, speed: 0.2, rate: 0 }], { jitterM: 2, seed: 7 });
    expect(findTurns(tr, opts(tr))).toEqual([]);
  });

  it('a slow circle (360° over 2 minutes) is not a penalty turn', () => {
    const tr = track([straight(60), { s: 120, rate: 3.1, speed: 3 }, straight(60)]);
    expect(findTurns(tr, opts(tr))).toEqual([]);
  });
});
