import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { SOG_GAP_MS } from '../src/analysis/smooth';
import { sogAt, startSogSeries, type StartSogSeries } from '../src/analysis/startSog';
import { START_SOG_PRE_MS, type RaceAnalysis } from '../src/analysis/types';
import { PRE_START_FETCH_MS } from '../src/data/racesense/adapter';
import { readPref, writePref } from '../src/ui/speed';
import {
  START_SOG_WINDOW_KEY,
  parseStartSogWindow,
  secsLabel,
  startSogChart,
  startSogControls,
  startSogHover,
  startSogKey,
  startSogLayout,
} from '../src/ui/startSog';
import { c31Race, fixtureRace, m24Race } from './helpers';

const j70 = analyzeRace(fixtureRace());
const c31 = analyzeRace(c31Race());
const gapS = SOG_GAP_MS / 1000;

/** Every boat one run (or none), its fixes in time order: one line however far apart they are. */
function expectOneLine(s: StartSogSeries): void {
  for (const b of s.boats) {
    expect(b.runs.length).toBeLessThanOrEqual(1);
    expect(b).not.toHaveProperty('gaps');
    for (const r of b.runs) for (let i = 1; i < r.t.length; i++) expect(r.t[i]).toBeGreaterThan(r.t[i - 1]);
  }
}

/** A copy of the analysis with one boat's fixes between `from` and `to` s from the gun removed (a telemetry hole). */
function withHole(a: RaceAnalysis, id: string, from: number, to: number): RaceAnalysis {
  const gun = a.meta.gunMs;
  return {
    ...a,
    drawings: a.drawings.map((d) => {
      if (d.id !== id) return d;
      const keep = [...d.startSog.t.keys()].filter((i) => {
        const s = (d.startSog.t[i] - gun) / 1000;
        return s < from || s > to;
      });
      return { ...d, startSog: { t: Float64Array.from(keep.map((i) => d.startSog.t[i])), sog: Float32Array.from(keep.map((i) => d.startSog.sog[i])) } };
    }),
  };
}

describe('startSogSeries', () => {
  it('keeps the full-rate track for the longest window, and the live fetch covers it', () => {
    expect(START_SOG_PRE_MS).toBe(120_000);
    expect(PRE_START_FETCH_MS).toBeGreaterThanOrEqual(START_SOG_PRE_MS + 2_000);
    for (const d of j70.drawings) {
      const s = (d.startSog.t[0] - j70.meta.gunMs) / 1000;
      expect(s).toBeLessThanOrEqual(-119);
      expect((d.startSog.t.at(-1)! - j70.meta.gunMs) / 1000).toBeGreaterThanOrEqual(19);
    }
  });

  for (const w of [30, 60, 120] as const) {
    it(`window ${w} s: −${w} s to +20 s on the J/70 fixture`, () => {
      const s = startSogSeries(j70, w);
      expect(s).toMatchObject({ t0: -w, t1: 20, clamped: false });
      expect(s.boats).toHaveLength(j70.boats.length);
      const ts = s.boats.flatMap((b) => b.runs.flatMap((r) => r.t));
      expect(Math.min(...ts)).toBeGreaterThanOrEqual(-w);
      expect(Math.min(...ts)).toBeLessThan(-w + 1);
      expect(Math.max(...ts)).toBeLessThanOrEqual(20);
      expectOneLine(s);
    });
  }

  it('clamps to the earliest data and says so', () => {
    let a = j70;
    for (const d of j70.drawings) a = withHole(a, d.id, -200, -90.5);
    const s = startSogSeries(a, 120);
    expect(s.clamped).toBe(true);
    expect(s.t0).toBe(-91);
    // A visible ⚠ chip; the why in the ⓘ.
    const k = startSogKey(s, 120);
    expect(k.chips[0]).toMatchObject({ text: 'starts at −91.0 s', warn: true });
    expect(k.bullets.join(' ')).toContain('The tracks start at −91.0 s here');
    const s60 = startSogSeries(a, 60);
    expect(s60.clamped).toBe(false);
    // Not clamped: no window pill (the Window control above says it), the dot swatch first.
    expect(startSogKey(s60, 60).chips[0]).toEqual({ text: 'crossed the line', swatch: 'dot' });
    expect(startSogKey(s60, 60).chips.map((c) => c.text).join(' ')).not.toContain('→');
  });

  it('keys the crossing dot, and nothing about holes even on the patchy C31 feed', () => {
    const swatches = (s: StartSogSeries): (string | undefined)[] => startSogKey(s, 120).chips.map((c) => c.swatch);
    const patchy = startSogSeries(c31, 120);
    expect(swatches(patchy)).toEqual(['dot']);
    const k = startSogKey(patchy, 120);
    expect([...k.chips.map((c) => c.text), ...k.bullets].join(' ')).not.toMatch(/no data|gray dashed|apart|gap/i);
    expect(k.bullets.length).toBeLessThanOrEqual(6);
  });

  it('one line through every fix of the patchy C31 feed, its holes bridged, dropping no fix', () => {
    const s = startSogSeries(c31, 120);
    expectOneLine(s);
    // The feed has holes over SOG_GAP_MS in the window: drawn straight across.
    expect(s.boats.some((b) => b.runs[0].t.some((t, i) => i > 0 && t - b.runs[0].t[i - 1] > gapS))).toBe(true);
    for (const b of s.boats) {
      const d = c31.drawings.find((x) => x.id === b.id)!;
      const inWin = [...d.startSog.t].filter((t) => (t - c31.meta.gunMs) / 1000 >= -120 && (t - c31.meta.gunMs) / 1000 <= 20);
      expect(b.runs.reduce((n, r) => n + r.t.length, 0)).toBe(inWin.length);
    }
  });

  it('a synthetic 10 s hole: one run straight across it, the speed there on that line; nothing dashed', () => {
    const id = j70.boats[0].id;
    const s = startSogSeries(withHole(j70, id, -20, -10), 60);
    const b = s.boats.find((x) => x.id === id)!;
    expect(b.runs).toHaveLength(1);
    const r = b.runs[0];
    const k = r.t.findIndex((t) => t > -10);
    const [t0, t1, v0, v1] = [r.t[k - 1], r.t[k], r.sog[k - 1], r.sog[k]];
    expect([t0 < -20, t1 > -10]).toEqual([true, true]);
    expect(sogAt(b, -15)).toBeCloseTo(v0 + ((v1 - v0) * (-15 - t0)) / (t1 - t0), 6);
    expect(sogAt(b, -30)).not.toBeNull();
    expectOneLine(s);
    const svg = startSogChart({ ...j70, drawings: withHole(j70, id, -20, -10).drawings }, null, 60);
    const g = new RegExp(`<g class="ss-boat" data-id="${id}">.*?</g>`).exec(svg)![0];
    expect(g).not.toContain('ss-gap');
    expect((/class="ss-line" d="([^"]*)"/.exec(g)![1].match(/M/g) ?? []).length).toBe(1);
  });

  it('crossing markers sit at the start table late seconds', () => {
    const s = startSogSeries(j70, 60);
    let n = 0;
    for (const b of s.boats) {
      const late = j70.boats.find((x) => x.id === b.id)!.start?.lateS ?? null;
      if (late == null || late > 20) {
        expect(b.cross).toBeNull();
        continue;
      }
      n++;
      expect(b.cross!.tS).toBe(late);
      expect(b.cross!.sogKn).toBe(sogAt(b, late));
    }
    expect(n).toBeGreaterThan(3);
    const svg = startSogChart(j70, null, 60);
    const b = s.boats.find((x) => x.cross)!;
    expect(svg).toContain(`crossed ${secsLabel(b.cross!.tS)} at ${b.cross!.sogKn.toFixed(1)} kn`);
  });
});

describe('the chart', () => {
  it('one line per racing boat; Not racing boats left out', () => {
    const m24 = analyzeRace(m24Race());
    const svg = startSogChart(m24, null, 60);
    expect((svg.match(/<path class="ss-line"/g) ?? []).length).toBe(m24.boats.length);
    for (const e of m24.excluded) expect(svg).not.toContain(`data-id="${e.result.id}"`);
    expect(svg).toContain('>Gun</text>');
  });

  it('highlights the selected boat and fades the rest; none selected, none faded', () => {
    const id = j70.boats[2].id;
    const svg = startSogChart(j70, id, 60);
    expect(svg.match(/class="ss-boat on"/g)).toHaveLength(1);
    expect(svg.match(/class="ss-boat dim"/g)).toHaveLength(j70.boats.length - 1);
    expect(startSogChart(j70, null, 60)).not.toMatch(/ss-boat (on|dim)/);
  });

  it('ticks every 10 s, every 5 s in the 30 s window', () => {
    const ticks = (svg: string): number => (svg.match(/class="ss-tick"/g) ?? []).length;
    expect(ticks(startSogChart(j70, null, 60))).toBe(9); // −60 … +20
    expect(ticks(startSogChart(j70, null, 30))).toBe(11); // −30 … +20
    expect(ticks(startSogChart(j70, null, 120))).toBe(15);
  });

  it('fits a 390 px phone', () => {
    const svg = startSogChart(j70, null, 60, { widthPx: 390 });
    expect(svg).toContain('viewBox="0 0 390 230"');
  });

  it('hover: the selected boat speed at the time, else the nearest line; in a hole, the line drawn there', () => {
    const s = startSogSeries(j70, 60);
    const L = startSogLayout(s, 720);
    const id = j70.boats[1].id;
    const b = s.boats.find((x) => x.id === id)!;
    const h = startSogHover(s, L, L.x(-10), 0, id)!;
    expect(h.id).toBe(id);
    expect(h.sogKn).toBe(sogAt(b, h.tS));
    // No selection: some line at the pointer's height (b's own, or one closer still).
    const py = L.y(sogAt(b, -10)!);
    const near = startSogHover(s, L, L.x(-10), py, null)!;
    expect(Math.abs(L.y(near.sogKn) - py)).toBeLessThanOrEqual(Math.abs(L.y(sogAt(b, -10)!) - py) + 1e-9);
    expect(startSogHover(s, L, L.x(-10), -500, null)).toBeNull();
    const holed = startSogSeries(withHole(j70, id, -20, -10), 60);
    const hh = startSogHover(holed, startSogLayout(holed, 720), L.x(-15), 0, id)!;
    expect(hh.sogKn).toBeCloseTo(sogAt(holed.boats.find((x) => x.id === id)!, hh.tS)!, 9);
  });
});

describe('Window preference', () => {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  const saved = g.localStorage;
  afterEach(() => {
    g.localStorage = saved;
    store.clear();
  });

  it('round-trips recall.startSogWindow; anything else is 60', () => {
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(START_SOG_WINDOW_KEY).toBe('recall.startSogWindow');
    expect(parseStartSogWindow(readPref(START_SOG_WINDOW_KEY))).toBe(60);
    for (const w of [30, 60, 120] as const) {
      writePref(START_SOG_WINDOW_KEY, String(w));
      expect(parseStartSogWindow(readPref(START_SOG_WINDOW_KEY))).toBe(w);
    }
    for (const bad of [null, '', '45', 'abc', '60.5', ' 30', '1e2', '-30', '030x']) expect(parseStartSogWindow(bad)).toBe(60);
  });

  it('falls back to 60 when storage throws', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => writePref(START_SOG_WINDOW_KEY, '30')).not.toThrow();
    expect(parseStartSogWindow(readPref(START_SOG_WINDOW_KEY))).toBe(60);
  });

  it('controls: a pressed button for the current window', () => {
    const html = startSogControls(120);
    expect(html).toContain('aria-label="Window before the gun"');
    expect(html).toContain('data-sog-window="120" aria-pressed="true"');
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
  });
});
