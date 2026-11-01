import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { legGainAt, legPlaces } from '../src/analysis/coach/gainLoss';
import { ladderReader } from '../src/analysis/coach/ladderNow';
import { progressAt, progressBase } from '../src/analysis/coach/progress';
import { placeChanges } from '../src/analysis/places';
import { PRE_LEG } from '../src/analysis/types';
import { mapKey } from '../src/ui/captions';
import { scrubFrame, trackMap, trackPoints } from '../src/ui/charts';
import { GAIN_BINS, GAIN_CAP, GAIN_COLORS, GAIN_KEY_TEXT, GAIN_LABELS, GAIN_NEUTRAL_DAY, gainBin, gainColor, gainKey, gainStroke, gainTipLine, placesLine } from '../src/ui/gain';
import { mapTipLines } from '../src/ui/mapPoints';
import { NEUTRAL_DAY } from '../src/ui/sog';
import { colourControls, contrast, needsCoach, parseTrackColour, SPEED_BG } from '../src/ui/speed';
import { coachRace, fixtureRace } from './helpers';

/**
 * Color: Gain/loss (ui/gain.ts, coach/gainLoss.ts): each leg of a boat's track one color, by the places it gained or
 * lost on the leg (its place entering it less its place at its end; the leg under way, so far).
 */

describe('Gain/loss: places on each leg', () => {
  const { a, m } = coachRace(fixtureRace());
  const pc = placeChanges(a);
  const lp = legPlaces(a, m);
  const n = a.legs.length;

  it('reads each leg from the bump chart: place entering less place at the rounding or the finish', () => {
    expect(legPlaces(a, m)).toBe(lp);
    const all: number[] = [];
    for (const b of pc.boats) {
      for (let k = 0; k < n; k++) {
        const g = legGainAt(lp, b.id, k, Infinity);
        expect(g).toBe(b.places[k]! - b.places[k + 1]!);
        all.push(g!);
      }
    }
    // Gained, lost and held all occur in the fixture.
    expect(all.some((g) => g > 0)).toBe(true);
    expect(all.some((g) => g < 0)).toBe(true);
    expect(all.some((g) => g === 0)).toBe(true);
  });

  it('enters leg 1 at the start place (the start table, clean starters at the gun), else the ladder place at its first fix', () => {
    for (const b of a.boats) expect(pc.boats.find((x) => x.id === b.id)!.places[0]).toBe(b.start?.startPlace ?? null);
    const fresh = coachRace(fixtureRace());
    const b = fresh.a.boats[0];
    b.start!.startPlace = null;
    const lp2 = legPlaces(fresh.a, fresh.m);
    const seg = fresh.a.drawings.find((d) => d.id === b.id)!.segments.find((s) => s.leg === 0)!;
    const t0 = Math.max(fresh.a.meta.gunMs, seg.t[0]);
    const at = progressAt(fresh.a, fresh.m, progressBase(fresh.a, fresh.m), t0).byId.get(b.id)!;
    expect(at.est).toBe(false);
    const mark = placeChanges(fresh.a).boats[0].places[1]!;
    expect(legGainAt(lp2, b.id, 0, Infinity)).toBe(at.place - mark);
  });

  it('colors the leg under way by its place on the ladder now against its entry place, and nothing for legs not started', () => {
    const base = progressBase(a, m);
    const read = ladderReader(a, m);
    let checked = 0;
    for (const b of a.boats) {
      const row = pc.boats.find((x) => x.id === b.id)!;
      const end1 = b.legs[1]!.endMs!;
      const start1 = b.legs[1]!.startMs!;
      const t = Math.round((start1 + end1) / 2);
      const rungs = read(t).reads.map((r) => r.rung);
      const live = progressAt(a, m, base, t).byId.get(b.id)!;
      expect(live.est).toBe(false);
      expect(legGainAt(lp, b.id, 1, t)).toBe(row.places[1]! - live.place);
      // Reading the places doesn't move the moment the rungs' reader last read.
      expect(read(t).reads.map((r) => r.rung)).toEqual(rungs);
      // The leg before is done: its rounding places; the legs after haven't started.
      expect(legGainAt(lp, b.id, 0, t)).toBe(row.places[0]! - row.places[1]!);
      expect(legGainAt(lp, b.id, 2, t)).toBeNull();
      expect(legGainAt(lp, b.id, 3, t)).toBeNull();
      // Once it has rounded, its rounding place.
      expect(legGainAt(lp, b.id, 1, end1)).toBe(row.places[1]! - row.places[2]!);
      checked++;
    }
    expect(checked).toBe(a.boats.length);
  });

  it('is gray before the gun and with no place at either end', () => {
    for (const b of a.boats) expect(legGainAt(lp, b.id, PRE_LEG, Infinity)).toBeNull();
    expect(legGainAt(lp, 'no-such-boat', 0, Infinity)).toBeNull();
    expect(legGainAt(lp, a.boats[0].id, n, Infinity)).toBeNull();
    expect(gainColor(null)).toBe(GAIN_NEUTRAL_DAY);
    expect(gainColor(0)).toBe(GAIN_NEUTRAL_DAY);
    expect(gainTipLine(a, m, a.boats[0].id, PRE_LEG, Infinity)).toBeNull();
  });

  it('carries a boat that stopped short of its finish at its ladder place at its last fix on the leg', () => {
    const fresh = coachRace(fixtureRace());
    const b = fresh.a.boats[0];
    b.finishPos = null;
    delete b.onWaterPlace;
    const lp2 = legPlaces(fresh.a, fresh.m);
    const segs = fresh.a.drawings.find((d) => d.id === b.id)!.segments.filter((s) => s.leg === n - 1);
    const last = Math.max(...segs.map((s) => s.t[s.t.length - 1]));
    const entry = placeChanges(fresh.a).boats[0].places[n - 1]!;
    const p = lp2.placeAt(b.id, last);
    expect(p).not.toBeNull();
    expect(legGainAt(lp2, b.id, n - 1, Infinity)).toBe(entry - p!);
    // The same later on: no further than its last fix.
    expect(legGainAt(lp2, b.id, n - 1, last + 3_600_000)).toBe(entry - p!);
  });

  it('shades 1, 2 and 3 or more places, red lost, gray held, green gained, readable on either chart', () => {
    expect(GAIN_BINS).toBe(7);
    expect([-9, -3, -2, -1, 0, 1, 2, 3, 9].map(gainBin)).toEqual([0, 0, 1, 2, 3, 4, 5, 6, 6]);
    expect(gainBin(null)).toBe(GAIN_CAP);
    for (const scheme of ['light', 'dark'] as const) {
      const cs = GAIN_COLORS[scheme];
      expect(new Set(cs).size).toBe(GAIN_BINS);
      for (const c of cs) expect(contrast(c, SPEED_BG[scheme])).toBeGreaterThanOrEqual(3);
      // Reds lose green, greens lose red.
      const [r, g] = [parseInt(cs[0].slice(1, 3), 16), parseInt(cs[0].slice(3, 5), 16)];
      expect(r).toBeGreaterThan(g);
      expect(parseInt(cs[6].slice(3, 5), 16)).toBeGreaterThan(parseInt(cs[6].slice(1, 3), 16));
    }
    expect(gainStroke(6, GAIN_BINS)).toBe(`stroke="${GAIN_COLORS.light[6]}" style="--cd:${GAIN_COLORS.dark[6]}"`);
  });

  it('draws each leg of a track in one color, gray until the ladder is in', () => {
    const svg = trackMap(a, null, null, { colour: 'gain', coach: m });
    for (const b of pc.boats) {
      const g = new RegExp(`<g class="sog-trk" data-id="${b.id}"[^>]*>(.*?)</g>`).exec(svg)![1];
      const bins = new Set([...g.matchAll(/data-bin="(\d+)"/g)].map((x) => Number(x[1])));
      const want = new Set(a.legs.map((_, k) => gainBin(b.places[k]! - b.places[k + 1]!)));
      expect(bins).toEqual(want);
    }
    expect(svg).toContain('colored by the places each boat gained or lost on each leg: red lost, gray held, green gained');
    expect(svg).not.toMatch(/no data|no reading|missing|\bgap\b/i);
    const waiting = trackMap(a, null, null, { colour: 'gain' });
    expect(waiting).toContain(`stroke="${NEUTRAL_DAY}"`);
    expect(waiting).not.toMatch(/data-bin="[1-9]/);
    // A replay: the leg under way colored so far; dots as their tracks.
    const t = a.meta.gunMs + 400_000;
    const fr = scrubFrame(a, null, null, { colour: 'gain', coach: m, scrub: true }, { t, win: [a.meta.gunMs, t] });
    expect(fr.tracks).toContain('<g class="sog-trk"');
    const b0 = fr.boats.find((b) => b.leg >= 0)!;
    expect(fr.dots).toContain(`fill="${gainColor(legGainAt(lp, b0.id, b0.leg, t))}"`);
  });

  it('says "+2 places on Beat 2" on hover', () => {
    expect(placesLine(2, 'Beat 2')).toBe('+2 places on Beat 2');
    expect(placesLine(-1, 'Run 1')).toBe('−1 place on Run 1');
    expect(placesLine(-4, 'Run 2')).toBe('−4 places on Run 2');
    expect(placesLine(0, 'Beat 1')).toBe('Held place on Beat 1');
    const p = trackPoints(a, null);
    const [i0, i1] = p.ix.span[0];
    const lines = new Set<string>();
    for (let i = i0; i < i1; i += 5) {
      const ls = mapTipLines(a, p, { kind: 'fix', i }, { valueLine: (q) => gainTipLine(a, m, q.id, q.leg, Infinity) });
      for (const l of ls) if (/ on (Beat|Run) \d$/.test(l)) lines.add(l);
    }
    expect(lines.size).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/^([+−][1-9]\d* places? |Held place )on (Beat|Run) \d$/);
  });

  it('keys the shades −3+ to +3+ as places gained/lost on the leg; its caption', () => {
    expect(GAIN_LABELS).toEqual(['−3+', '−2', '−1', '0', '+1', '+2', '+3+']);
    expect(GAIN_KEY_TEXT).toBe('Places gained/lost on the leg');
    const key = gainKey(m);
    expect([...key.matchAll(/<span class="gain-sw"[^>]*>([^<]*)<\/span>/g)].map((x) => x[1])).toEqual([...GAIN_LABELS]);
    expect(key).toContain(GAIN_KEY_TEXT);
    expect(key).toContain(`--c:${GAIN_COLORS.light[0]};--cd:${GAIN_COLORS.dark[0]}`);
    expect(gainKey(undefined)).toContain(GAIN_KEY_TEXT);
    expect(gainKey(null)).toContain("Gain/loss colors aren't available for this race.");
    for (const html of [key, gainKey(null)]) expect(html).not.toMatch(/no data|\bgap\b|missing|colour/i);
    const cap = mapKey(a, { colour: 'gain', leg: null });
    const b = cap.bullets.find((x) => x.startsWith('Gain/loss: '))!;
    expect(b).toContain('places the boat gained (green) or lost (red)');
    expect(b).toContain('change so far');
    expect(cap.bullets.join(' ')).toContain('places on the leg');
    expect(cap.bullets.join(' ')).not.toMatch(/\bgap\b|over early|OCS|m\/min|colour/i);
  });

  it('lets the five Color buttons wrap on the narrowest phones, one segmented line from 381 px up', () => {
    const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
    const mm = /@media \(max-width: (\d+)px\) \{\s*\.seg:has\(> button\[data-colour\]\) \{ flex-wrap: wrap; gap: 4px; \}([^@]*?)\n\}/.exec(css);
    expect(mm).not.toBeNull();
    const px = Number(mm![1]);
    expect(px).toBeGreaterThanOrEqual(320);
    expect(px).toBeLessThan(470);
    expect(mm![2]).toContain('.seg:has(> button[data-colour]) button { margin-left: 0; border-radius: 6px; }');
    expect(colourControls('leg', 'leg', null).match(/<button /g)).toHaveLength(5);
  });

  it('is in the menu, and its stored value parses', () => {
    expect(colourControls('gain', 'leg', null)).toContain('data-colour="gain" aria-pressed="true">Gain/loss</button>');
    expect(colourControls('gain', 'leg', null)).not.toContain('data-sog-scale');
    expect(parseTrackColour('gain')).toBe('gain');
    expect(parseTrackColour('vmg')).toBe('vmg');
    expect(parseTrackColour('speed')).toBe('rank');
    expect(needsCoach('gain')).toBe(true);
  });
});
