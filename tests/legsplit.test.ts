import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { smooth, turnThresholds, zigzag } from '../src/analysis/course';
import { EARTH_R, wrap180, type Vec } from '../src/analysis/geo';
import type { RaceAnalysis } from '../src/analysis/types';
import { classifyLeg, straddles } from '../src/analysis/wind';
import { buildRaceData, parseTelemetry } from '../src/data/racesense/adapter';
import type { CourseMark, RaceData } from '../src/data/types';
import { legSplit, trackMap } from '../src/ui/charts';
import { mapKey, raceNotesKey } from '../src/ui/captions';
import { c31Race, fixtureRace, j88Race, loadFixture, m24Race } from './helpers';

const names = (a: RaceAnalysis): string[] => a.legs.map((l) => l.name);
const min = (a: RaceAnalysis, t: number): number => (t - a.meta.gunMs) / 60_000;

/** Every boat that has all its legs: they run gun → finish with no gaps, so they sum to the race time. */
function expectContiguous(a: RaceAnalysis): void {
  for (const b of a.boats) {
    if (!b.legs.every((l) => l) || b.raceTimeS == null) continue;
    expect(b.legs[0]!.startMs).toBe(a.meta.gunMs);
    for (let i = 1; i < b.legs.length; i++) expect(b.legs[i]!.startMs).toBe(b.legs[i - 1]!.endMs);
    expect(b.legs.reduce((s, l) => s + l!.timeS, 0)).toBeCloseTo(b.raceTimeS, 6);
  }
}

describe('Melges 24 Worlds race 4: Windward Mark and OFFSET never transmit', () => {
  const a = analyzeRace(m24Race());
  const finishers = a.boats.filter((b) => b.finishPos != null);

  it('splits two windward/leeward laps from the fleet’s turns', () => {
    expect(names(a)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
    expect(a.legs.map((l) => l.to)).toEqual(['Windward mark', 'Gate', 'Windward mark', 'Finish']);
    expect(a.legSource).toBe('fleet');
  });

  it('estimates the wind from the tacks, near 77°', () => {
    expect(a.wind.method).toBe('tacks');
    expect(Math.abs(wrap180(a.wind.twdAtGunDeg - 77))).toBeLessThan(15);
  });

  it('gives at least 75% of finishers all four legs, summing to their race time', () => {
    expect(finishers.filter((b) => b.legs.every((l) => l)).length).toBeGreaterThanOrEqual(0.75 * finishers.length);
    expectContiguous(a);
  });

  it('leaves out the legs whose windward rounding fell in a hole, 100–150 s of sailing from the fix it was timed at', () => {
    // 619, 629 and 708 were timed at the fix before or after a 2–6 min hole, still well short of (or past) the turn.
    for (const id of ['619', '629', '708']) {
      const b = a.boats.find((x) => x.id === id)!;
      expect(b.legs.slice(0, 2)).toEqual([null, null]);
      expect(b.legs[2]).not.toBeNull();
      expect(b.upwind!.complete).toBe(false);
      expect(b.upwind!.place).toBeNull();
    }
  });

  it('turns the winner 870 at about 16, 26 and 44 min', () => {
    const w = a.boats.find((b) => b.sail === '870')!;
    expect(w.finishPos).toBe(1);
    [16, 26, 44].forEach((m, i) => expect(Math.abs(min(a, w.legs[i]!.endMs) - m)).toBeLessThanOrEqual(2));
    expect(min(a, w.legs[3]!.endMs)).toBeCloseTo(52.9, 1);
  });

  it('explains the missing marks and the offset in the warnings', () => {
    const w = a.warnings.find((t) => t.startsWith('Legs are split where each boat turned'))!;
    expect(w).toContain('Windward Mark and OFFSET sent no tracker positions');
    expect(w).toContain('The offset mark is counted as part of the following run.');
    expect(a.warnings.join(' ')).not.toMatch(/Not enough steady upwind sailing/);
  });

  it('shows the notes as chips (⚠ legs split from turns first) and the why as short ⓘ bullets', () => {
    const k = raceNotesKey(a);
    const texts = k.chips.map((c) => `${c.warn ? '⚠ ' : ''}${c.text}`);
    expect(texts[0]).toBe('⚠ legs split from turns');
    expect(texts).toContain('windward mark est.');
    expect(texts).toContain(`${a.excluded.length} not racing`);
    expect(k.bullets).toEqual([
      'Legs split where each boat turned at the top and bottom.',
      'No tracker positions from Windward Mark and OFFSET.',
      "Tracked marks (Gate) don't give the rounding order.",
      'Windward mark placed from the tracks (est.).',
      'The offset mark counts as part of the following run.',
      'Not racing: coach or spare trackers, listed under the boat list.',
    ]);
    // The full sentence stays as the chip's title.
    expect(k.chips[0].title).toBe(a.warnings.find((t) => t.startsWith('Legs are split')));
    expect(a.notes.map((n) => n.text)).toEqual(a.warnings);
  });

  it('draws the windward mark hollow as an estimate and the Gate where it was rounded', () => {
    expect(a.marks.filter((m) => m.estimated).map((m) => m.name)).toEqual(['Windward mark']);
    const svg = trackMap(a, null);
    expect(svg).toContain('>Windward (est.)</text>');
    expect(svg).toMatch(/<circle class="mark est"[^>]*stroke-dasharray/);
    expect(svg).toContain('>Gate</text>');
    expect(legSplit(a)).toEqual({ chip: 'legs: fleet turns', info: 'Legs split where each boat turned (snapped to mark trackers where present).' });
    // Hollow marks: a legend swatch on the map's key line, not a sentence.
    expect(mapKey(a, { colour: 'leg' }).chips).toContainEqual({ text: 'estimated mark', swatch: 'est' });
  });
});

describe('Benelux race 8: complete marks in rounding order', () => {
  const a = analyzeRace(fixtureRace());
  it('keeps the mark-tracker legs', () => {
    expect(names(a)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
    expect(a.legs.map((l) => l.to)).toEqual(['M1', 'Gate', 'M1', 'Finish']);
    expect(a.legSource).toBe('course');
    expect(a.marks.some((m) => m.estimated)).toBe(false);
    expect(legSplit(a)).toEqual({ chip: 'legs: mark trackers', info: "Legs split at each boat's closest approach to the mark trackers." });
    expect(mapKey(a, { colour: 'leg' }).chips.some((c) => c.swatch === 'est')).toBe(false);
    expect(a.warnings).toEqual([]);
  });
});

describe('J/88 North Americans race 5: no mark trackers', () => {
  const a = analyzeRace(j88Race());
  it('finds two laps with a downwind finish', () => {
    expect(a.meta.raceNumber).toBe(5);
    expect(names(a)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
    expect(a.legs.map((l) => l.to)).toEqual(['Windward mark', 'Leeward mark', 'Windward mark', 'Finish']);
    expect(a.legSource).toBe('fleet');
    expect(a.wind.method).toBe('tacks');
    expect(a.boats.every((b) => b.legs.every((l) => l))).toBe(true);
    expectContiguous(a);
  });

  it('draws both turns as estimated marks', () => {
    expect(a.marks.map((m) => [m.name, !!m.estimated])).toEqual([
      ['Windward mark', true],
      ['Leeward mark', true],
    ]);
    const svg = trackMap(a, null);
    expect(svg).toContain('>Windward (est.)</text>');
    expect(svg).toContain('>Leeward (est.)</text>');
    expect(a.warnings.join(' ')).toContain('the feed has no mark trackers for this course');
    expect(raceNotesKey(a).bullets).toContain('The feed has no mark trackers for this course.');
    expect(raceNotesKey(a).chips.map((c) => c.text)).toEqual(['legs split from turns', 'windward mark est.', 'leeward mark est.']);
  });
});

describe('C31 Gold Cup race 10: course lists Bottom Gate, Mark 1, Mark 1a', () => {
  const a = analyzeRace(c31Race());
  it('is a two-lap windward/leeward, not Beat/Beat/Reach/Run', () => {
    expect(names(a)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
    expect(a.legs.map((l) => l.to)).toEqual(['Windward mark', 'Bottom Gate', 'Mark 1a', 'Finish']);
    expect(a.legSource).toBe('fleet');
    expect(a.boats.every((b) => b.legs.every((l) => l))).toBe(true);
    expectContiguous(a);
  });
});

describe('zigzag turn detection', () => {
  /** Piecewise-linear s through the given levels, 1 sample per metre-ish step of 10. */
  const path = (...levels: number[]): number[] => {
    const out: number[] = [levels[0]];
    for (let i = 1; i < levels.length; i++) {
      const n = Math.max(1, Math.round(Math.abs(levels[i] - levels[i - 1]) / 10));
      for (let k = 1; k <= n; k++) out.push(levels[i - 1] + ((levels[i] - levels[i - 1]) * k) / n);
    }
    return out;
  };
  const pat = (s: number[], h = 300, finalH = 100): string => zigzag(s, h, finalH).map((e) => e.type).join('');

  it('finds two windward/leeward laps with a downwind finish', () => {
    expect(pat(path(0, 1000, 0, 1000, 0))).toBe('TBT');
  });

  it('places each extreme at the turn', () => {
    const s = path(0, 1000, 0, 1000, 0);
    expect(zigzag(s, 300).map((e) => s[e.i])).toEqual([1000, 0, 1000]);
  });

  it('counts a short beat to a finish just above the leeward gate as its own leg', () => {
    // 200 m of beat after the gate: under h (300) but over finalH (100).
    expect(pat(path(0, 1000, 0, 1000, 0, 200))).toBe('TBTB');
    expect(pat(path(0, 1000, 0, 1000, 0, 50))).toBe('TBT');
  });

  it('ignores wiggles under the hysteresis (OCS return, penalty turn)', () => {
    expect(pat(path(0, 80, -20, 1000, 900, 950, 0, 1000, 0))).toBe('TBT');
  });

  it('records a bottom first when leg 1 goes down the axis', () => {
    expect(pat(path(0, -1000, 0))).toBe('B');
  });

  it('scales the thresholds with the course', () => {
    expect(turnThresholds(100)).toEqual({ h: 100, finalH: 60 });
    expect(turnThresholds(2000)).toEqual({ h: 600, finalH: 200 });
  });

  it('smooths with a centred moving average', () => {
    expect(smooth([0, 0, 3, 0, 0], 1)).toEqual([0, 1, 1, 1, 0]);
  });
});

describe('leg classification', () => {
  it('uses ±50° of the wind and downwind', () => {
    expect(classifyLeg(10, 0)).toBe('upwind');
    expect(classifyLeg(-45, 0)).toBe('upwind');
    expect(classifyLeg(180, 0)).toBe('downwind');
    expect(classifyLeg(135, 0)).toBe('downwind');
    expect(classifyLeg(90, 0)).toBe('reach');
  });

  it('calls the 50–70° / 110–130° band a beat or run only if the fleet tacked or gybed', () => {
    expect(classifyLeg(60, 0)).toBe('reach');
    expect(classifyLeg(60, 0, true)).toBe('upwind');
    expect(classifyLeg(120, 0)).toBe('reach');
    expect(classifyLeg(120, 0, false, true)).toBe('downwind');
    expect(classifyLeg(80, 0, true, true)).toBe('reach');
  });

  it('recognises tacks/gybes as two steady headings either side of the axis', () => {
    const tacks = [...Array(40).fill(320), ...Array(40).fill(40)];
    expect(straddles(tacks, 0)).toBe(true);
    expect(straddles(tacks, 180)).toBe(true);
    // A reach: both clusters on the same side of the wind.
    expect(straddles([...Array(40).fill(80), ...Array(40).fill(110)], 0)).toBe(false);
    expect(straddles(Array(80).fill(90), 0)).toBe(false);
  });
});

// ---- synthetic races (wind from the north, 1 Hz, 3 m/s; tacks ±42°, gybes ±25°)
const LAT0 = 52;
const LON0 = 5;
const toLatLon = ([x, y]: Vec) => ({
  lat: LAT0 + (y / (EARTH_R * Math.PI)) * 180,
  lon: LON0 + (x / (EARTH_R * Math.cos((LAT0 * Math.PI) / 180) * Math.PI)) * 180,
});

/** One boat sailing `waypoints` from `start`: beats and runs zigzag inside a lane of ±`lane` m; reaches go straight. */
function sail(start: Vec, waypoints: Vec[], lane: number, speed: number): { xy: Vec[]; hdg: number[] } {
  const xy: Vec[] = [start];
  const hdg: number[] = [0];
  let p = start;
  for (const to of waypoints) {
    const dx = to[0] - p[0];
    const dy = to[1] - p[1];
    const brg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    const twa = Math.abs(wrap180(brg));
    const zig = twa < 45 ? 42 : twa > 150 ? 155 : null;
    let side = 1;
    const origin = p;
    const ux = dx / Math.hypot(dx, dy);
    const uy = dy / Math.hypot(dx, dy);
    for (let n = 0; n < 5000; n++) {
      const rx = to[0] - p[0];
      const ry = to[1] - p[1];
      const d = Math.hypot(rx, ry);
      if (d < speed) break;
      let h: number;
      // Offset to the right of the rhumb line; side +1 sails toward the right.
      const lat = (p[0] - origin[0]) * uy - (p[1] - origin[1]) * ux;
      // On the layline (or a reach): straight for the mark.
      if (zig == null || rx * ux + ry * uy < 1.2 * Math.abs(lat) + 30) h = (Math.atan2(rx, ry) * 180) / Math.PI;
      else {
        if (lat > lane) side = -1;
        if (lat < -lane) side = 1;
        h = zig === 42 ? side * 42 : 180 + side * 25;
      }
      const r = (h * Math.PI) / 180;
      p = [p[0] + speed * Math.sin(r), p[1] + speed * Math.cos(r)];
      xy.push(p);
      hdg.push(((h % 360) + 360) % 360);
    }
    p = to;
    xy.push(p);
    hdg.push(hdg[hdg.length - 1]);
  }
  return { xy, hdg };
}

function syntheticRace(waypoints: Vec[], course: { name: string; at: Vec }[], boats = 6): RaceData {
  const gun = Date.UTC(2026, 5, 1, 12);
  const out: RaceData['boats'] = [];
  for (let i = 0; i < boats; i++) {
    const start: Vec = [-60 + 24 * i, 0];
    const { xy, hdg } = sail(start, waypoints, 120 + 25 * i, 3 + 0.05 * i);
    const n = xy.length + 1;
    const t = new Float64Array(n);
    const lat = new Float64Array(n);
    const lon = new Float64Array(n);
    const sog = new Float32Array(n);
    const heading = new Float32Array(n);
    // One fix 30 s before the gun on the line, then 1 Hz from the gun.
    [start, ...xy].forEach((p, k) => {
      const ll = toLatLon(p);
      t[k] = k === 0 ? gun - 30_000 : gun + (k - 1) * 1000;
      lat[k] = ll.lat;
      lon[k] = ll.lon;
      sog[k] = 6;
      heading[k] = k === 0 ? 0 : hdg[k - 1];
    });
    out.push({ id: `B${i}`, sail: `B${i}`, name: `Boat ${i}`, bowOffsetM: 0, track: { t, lat, lon, sog, heading }, finishMs: t[n - 1] });
  }
  const marks: CourseMark[] = course.map((m) => ({ id: m.name, name: m.name, kind: 'mark', positions: [toLatLon(m.at)] }));
  return {
    source: { kind: 'fixture', label: 'synthetic' },
    eventName: 'Synthetic',
    division: 'X',
    boatClass: 'X',
    raceNumber: 1,
    gunMs: gun,
    tzOffsetMs: 0,
    startLine: { left: toLatLon([-100, 0]), right: toLatLon([100, 0]) },
    finishLine: null,
    course: marks,
    boats: out,
  };
}

describe('synthetic courses', () => {
  const W: Vec = [0, 1500];
  const L: Vec = [0, 100];

  it('W/L two laps with an upwind finish just above the leeward mark, no trackers', () => {
    const a = analyzeRace(syntheticRace([W, L, W, L, [0, 400]], []));
    expect(names(a)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2', 'Beat 3']);
    expect(a.legs.map((l) => l.to)).toEqual(['Windward mark', 'Leeward mark', 'Windward mark', 'Leeward mark', 'Finish']);
    expect(a.legSource).toBe('fleet');
    expect(a.wind.method).toBe('tacks');
    expect(Math.abs(wrap180(a.wind.twdAtGunDeg))).toBeLessThan(5);
    expectContiguous(a);
  });

  it('snaps turns to a tracked mark when the course list is out of order', () => {
    // Trackers listed leeward-first: in feed order the legs would be nonsense.
    const a = analyzeRace(syntheticRace([W, L, W, L], [{ name: 'Leeward', at: L }, { name: 'Windward', at: W }]));
    expect(a.legSource).toBe('fleet');
    expect(names(a)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
    expect(a.legs.map((l) => l.to)).toEqual(['Windward', 'Leeward', 'Windward', 'Finish']);
    expect(a.marks.some((m) => m.estimated)).toBe(false);
  });

  it('keeps a genuine reach to a wing mark (triangle, trackers in order)', () => {
    const wing: Vec = [-1000, 1000];
    const a = analyzeRace(
      syntheticRace(
        [W, wing, L, W, L],
        [
          { name: 'Windward', at: W },
          { name: 'Wing', at: wing },
          { name: 'Leeward', at: L },
          { name: 'Windward', at: W },
        ],
      ),
    );
    expect(a.legSource).toBe('course');
    expect(names(a)).toEqual(['Beat 1', 'Reach 1', 'Run 1', 'Beat 2', 'Run 2']);
    expect(a.legs.map((l) => l.to)).toEqual(['Windward', 'Wing', 'Leeward', 'Windward', 'Finish']);
  });
});

describe('telemetry with no rows', () => {
  it('skips null pages', () => {
    expect(parseTelemetry([{ Fields: null, Rows: null }])).toEqual([]);
  });

  it('reports no boat tracks rather than crashing', () => {
    const f = loadFixture();
    expect(() => buildRaceData(f.regatta, { division: 'J70', raceNumber: 8 }, [{ Fields: null, Rows: null }])).toThrow(
      'No boat tracks in the telemetry for this race',
    );
  });
});
