import { describe, expect, it } from 'vitest';
import type { Course } from '../src/analysis/coach/ladder';
import { vmgFrame, vmgKn } from '../src/analysis/coach/trackVmg';
import { mapKey } from '../src/ui/captions';
import { scrubFrame, trackMap, trackPoints } from '../src/ui/charts';
import { cogAt, mapTipLines } from '../src/ui/mapPoints';
import { NEUTRAL_DAY, SOG_BINS } from '../src/ui/sog';
import { colourControls, needsCoach, parseTrackColour, readPref, writePref, COLOUR_KEY } from '../src/ui/speed';
import { segmentVmgRange, trackVmgRange, vmgAt, vmgHoverLeg, vmgKey, vmgTipLine, vmgValues } from '../src/ui/vmg';
import { coachRace, fixtureRace } from './helpers';

/**
 * Color: VMG (ui/vmg.ts, coach/trackVmg.ts): SOG along COG made good into the wind on a beat, down it on a run, toward
 * the mark on a reach (on the last leg, the boat's own point on the finish line extended), on the ladder's wind.
 */

const RAD = Math.PI / 180;
const S = 6;

/** Start at the origin; mark 1 1 km north (beat), back south (run), then 1 km east (reach); finish line x = 1000 ± 50 m. */
const course: Course = {
  pts: [
    [0, 0],
    [0, 1000],
    [0, 0],
    [1000, 0],
  ],
  kinds: ['upwind', 'downwind', 'reach'],
  finish: { left: [1000, -50], right: [1000, 50] },
};

describe('VMG at a point (coach/trackVmg.ts vmgKn)', () => {
  it('on a beat: S·cos θ, θ the angle to the wind', () => {
    for (const twd of [0, 30, 215]) {
      for (const theta of [0, 38, 45, 52, 90]) {
        for (const side of [1, -1]) expect(vmgKn(course, twd, 0, 0, 500, S, twd + side * theta)).toBeCloseTo(S * Math.cos(theta * RAD), 9);
      }
    }
  });

  it('on a run: the downwind component', () => {
    const twd = 10;
    for (const theta of [0, 25, 40]) expect(vmgKn(course, twd, 1, 0, 500, S, twd + 180 + theta)).toBeCloseTo(S * Math.cos(theta * RAD), 9);
  });

  it('on a reach: the component toward the mark', () => {
    // From (0, 0) the end of the reach is due east, wherever the wind.
    expect(vmgKn({ ...course, finish: null }, 200, 2, 0, 0, S, 90)).toBeCloseTo(S, 9);
    expect(vmgKn({ ...course, finish: null }, 200, 2, 0, 0, S, 60)).toBeCloseTo(S * Math.cos(30 * RAD), 9);
    // Off the rhumb line: toward the mark from where the boat is.
    const toMark = Math.atan2(1000 - 0, 0 - -1000) / RAD; // bearing from (0, -1000) to (1000, 0): 45°
    expect(vmgKn({ ...course, finish: null }, 200, 2, 0, -1000, S, toMark)).toBeCloseTo(S, 9);
  });

  it('on the last leg: toward its own point on the finish line extended', () => {
    // At (0, 300), the line x = 1000 extended is due east (not toward its middle at (1000, 0)).
    expect(vmgKn(course, 0, 2, 0, 300, S, 90)).toBeCloseTo(S, 9);
    expect(vmgKn(course, 0, 2, 0, 300, S, 90 - 20)).toBeCloseTo(S * Math.cos(20 * RAD), 9);
    // A beat to the finish still reads along the wind.
    const beatFinish: Course = { ...course, kinds: ['upwind', 'downwind', 'upwind'] };
    expect(vmgKn(beatFinish, 90, 2, 0, 300, S, 90 + 40)).toBeCloseTo(S * Math.cos(40 * RAD), 9);
  });

  it('is negative sailing away; 0 when not moving; NaN with no speed or no such leg', () => {
    expect(vmgKn(course, 0, 0, 0, 500, S, 180)).toBeCloseTo(-S, 9);
    expect(vmgKn(course, 0, 1, 0, 500, S, 0)).toBeCloseTo(-S, 9);
    expect(vmgKn(course, 0, 2, 0, 0, S, 270)).toBeCloseTo(-S, 9);
    expect(vmgKn(course, 0, 0, 0, 500, S, NaN)).toBe(0);
    expect(vmgKn(course, 0, 0, 0, 500, NaN, 45)).toBeNaN();
    expect(vmgKn(course, 0, 5, 0, 500, S, 45)).toBeNaN();
    // Before the gun: the first leg's.
    expect(vmgKn(course, 0, -1, 0, -50, S, 45)).toBeCloseTo(S * Math.cos(45 * RAD), 9);
  });
});

describe('VMG on the race viewer map', () => {
  const { a, m } = coachRace(fixtureRace());

  it('colors every drawn fix from its SOG and COG on the ladder’s wind', () => {
    const f = vmgFrame(m);
    let n = 0;
    for (const d of a.drawings) {
      for (const s of d.segments) {
        const v = vmgValues(m, s, s.leg);
        for (let i = 0; i < s.t.length; i += 7) {
          const want = vmgKn(f.course, f.twdAt(s.t[i]), s.leg, s.x[i], s.y[i], s.sog[i], cogAt(s.x, s.y, i));
          if (Number.isNaN(want)) expect(v[i]).toBeNaN();
          else expect(v[i]).toBeCloseTo(want, 4);
          expect(vmgAt(m, { t: s.t[i], leg: s.leg, x: s.x[i], y: s.y[i], sog: s.sog[i], cog: cogAt(s.x, s.y, i) })).toBeCloseTo(v[i], 4);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(100);
    // VMG never beats SOG.
    for (const d of a.drawings) for (const s of d.segments) vmgValues(m, s, s.leg).forEach((v, i) => Number.isFinite(v) && expect(v).toBeLessThanOrEqual(s.sog[i] + 1e-4));
  });

  it('scales on the fleet’s 5th–95th percentile, per leg or the race', () => {
    const race = trackVmgRange(a, m, null)!;
    expect(race.hi).toBeGreaterThan(race.lo);
    expect(race.hi - race.lo).toBeGreaterThanOrEqual(1);
    for (const l of a.legs) {
      const r = trackVmgRange(a, m, l.index);
      expect(segmentVmgRange(a, m, l.index, null, 'leg')).toEqual(r);
      expect(segmentVmgRange(a, m, l.index, null, 'race')).toEqual(race);
    }
    expect(vmgHoverLeg(a, m, 0, null, 'leg')).toMatch(/ · range -?[\d.]+–[\d.]+ kn$/);
  });

  it('draws colored paths per bin, and gray until the wind is in', () => {
    const svg = trackMap(a, null, null, { colour: 'vmg', coach: m });
    expect(svg).not.toContain('<polyline class="trk');
    const groups = [...svg.matchAll(/<g class="sog-trk[^"]*" data-id="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
    expect(groups.length).toBeGreaterThan(1);
    for (const [, , body] of groups) {
      const bins = [...body.matchAll(/data-bin="(\d+)"/g)].map((x) => Number(x[1]));
      expect(bins.length).toBeGreaterThan(1);
      expect(Math.max(...bins)).toBeLessThan(SOG_BINS);
    }
    expect(svg).toContain('aria-label="Race Viewer, tracks colored by VMG, scaled within each leg');
    expect(trackMap(a, null, 0, { colour: 'vmg', coach: m })).toMatch(/tracks colored by VMG, -?[\d.]+ to [\d.]+ kn/);
    // Before the coach model is in: one neutral gray, no VMG numbers.
    const waiting = trackMap(a, null, null, { colour: 'vmg' });
    expect(waiting).toContain(`stroke="${NEUTRAL_DAY}"`);
    expect(waiting).not.toMatch(/data-bin="[1-9]/);
    // Scrubbing: the boats in their VMG color too.
    const t = a.meta.gunMs + 120_000;
    const fr = scrubFrame(a, null, null, { colour: 'vmg', coach: m, scrub: true }, { t, win: [a.meta.gunMs, t] });
    expect(fr.tracks).toContain('<g class="sog-trk"');
    expect(fr.dots).toMatch(/fill="#[0-9a-f]{6}" style="--cd:#[0-9a-f]{6}"/);
  });

  it('shows VMG in the tooltip, and a key in knots', () => {
    const p = trackPoints(a, null);
    const i = Math.floor(p.ix.x.length / 2);
    const lines = mapTipLines(a, p, { kind: 'fix', i }, { valueLine: (q) => vmgTipLine(m, q) });
    expect(lines[3]).toMatch(/^VMG −?\d+\.\d kn$/);
    expect(vmgKey(a, m, 0, 'leg')).toContain('VMG · ');
    expect(vmgKey(a, m, 0, 'leg')).toContain('<span class="tu">kn</span>');
    expect(vmgKey(a, m, null, 'leg')).toContain('VMG: low → high within each leg');
    expect(vmgKey(a, undefined, null, 'leg')).toContain('VMG · kn');
    expect(vmgKey(a, null, null, 'leg')).toContain("VMG colors aren't available for this race.");
    for (const html of [vmgKey(a, m, null, 'leg'), vmgKey(a, undefined, 0, 'leg')]) expect(html).not.toMatch(/no data|gap/i);
    const cap = mapKey(a, { colour: 'vmg', leg: null });
    expect(cap.bullets.some((b) => b.startsWith('VMG: ') && b.includes('5th–95th percentile'))).toBe(true);
  });
});

describe('the VMG menu entry', () => {
  it('is offered, with the Scale choice for the whole race', () => {
    const c = colourControls('vmg', 'leg', null, 'all', 'leg');
    expect(c).toContain('data-colour="vmg" aria-pressed="true">VMG</button>');
    expect(c).toContain('aria-label="Scale VMG colors"');
    expect(colourControls('vmg', 'leg', 1)).not.toContain('data-sog-scale');
    expect(colourControls('leg', 'leg', null)).toContain('data-colour="vmg" aria-pressed="false"');
    expect(needsCoach('vmg')).toBe(true);
    expect(needsCoach('sog')).toBe(false);
  });

  it('round-trips the stored choice; older values still parse', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    try {
      writePref(COLOUR_KEY, 'vmg');
      expect(parseTrackColour(readPref(COLOUR_KEY))).toBe('vmg');
    } finally {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    expect(parseTrackColour('speed')).toBe('rank');
    expect(parseTrackColour('sog')).toBe('sog');
    expect(parseTrackColour('VMG')).toBe('leg');
  });
});
