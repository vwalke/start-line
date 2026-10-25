import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw, rivalLadder } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { placeChanges } from '../src/analysis/places';
import { startReplays } from '../src/analysis/startReplay';
import type { RaceAnalysis } from '../src/analysis/types';
import type { RaceData } from '../src/data/types';
import { boatsAt, scrubFrame, startSnapshot, trackMap, trackPoints } from '../src/ui/charts';
import { ladderChart } from '../src/ui/coach';
import { fillRuleOf, fillTrack } from '../src/ui/gapFill';
import { laneScrub } from '../src/ui/laneSnapshots';
import { laneScrubHtml } from '../src/ui/laneSnapshotsView';
import { c31Race, gateRace, j105Race } from './helpers';

/**
 * The filled-in short gaps (ui/gapFill.ts) are display only: drawing every track view with them leaves the analysis,
 * its inputs and every Coach card and finding exactly as they were, and nothing outside the drawing code imports it.
 */

/** Everything the results and the Coach read for a race, worked out from scratch. */
function results(data: RaceData) {
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null, raw.turns ?? null, raw.overStart ?? null)!;
  const debriefs = a.boats.map((b) => coachDebrief(a, m, b.id));
  return { a, raw, m, debriefs, places: placeChanges(a), replays: startReplays(a, data) };
}

/** The boats whose tracks the fill draws in (holes judged on the feed's own fixes: the drawing's FillRule). */
function filledBoats(a: RaceAnalysis): string[] {
  const filled = (s: Parameters<typeof fillTrack>[0], d: RaceAnalysis['drawings'][number], thinned: boolean): boolean => !!fillTrack(s, fillRuleOf(d), thinned).est;
  return a.drawings.filter((d) => d.segments.some((s) => filled(s, d, true)) || (d.pre != null && filled(d.pre, d, false))).map((d) => d.id);
}

/** Every track view, drawn with the fill: the Race Viewer (static, scrubbed with trails, the point lookup), the start chart, Start Playback, the Coach chart. */
function drawEverything(r: ReturnType<typeof results>, ids: string[]): string {
  const { a, m } = r;
  let out = trackMap(a, null) + trackMap(a, ids[0], null, { colour: 'rank' }) + trackMap(a, ids[0], null, { colour: 'sog' });
  trackPoints(a, null);
  const gun = a.meta.gunMs;
  for (const s of [-60, 0, 30, 90, 300, 900, 1800]) {
    const t = gun + s * 1000;
    const f = scrubFrame(a, ids[0], null, { scrub: true }, { t, win: [t - 120_000, t], trailMs: 120_000 });
    out += f.dots + f.trails.map((x) => [...x.d, ...(x.est ?? [])].join('')).join('');
    boatsAt(a, ids[0], t);
  }
  out += startSnapshot(a, ids[0]) + startSnapshot(a, null, undefined, 'speed');
  const L = laneScrub(a, { me: ids[0], replays: r.replays });
  for (const s of [-90, -30, 0, 45, 120, 180]) out += laneScrubHtml(a, L, undefined, s);
  for (const id of ids.slice(0, 3)) {
    const lad = rivalLadder(m, a, id, { kind: 'leaders' });
    if (lad) out += ladderChart(a, m, lad, { kind: 'leaders' });
  }
  return out;
}

// Races with short gaps to fill (IC37 race 5, the Coach start case, is dense: none by the map's rule).
const RACES: [string, () => RaceData][] = [
  ['J/105 CBC race 1 (USA 96, a sparse tracker, filled across the gun)', () => j105Race(1)],
  ['J/105 CBC race 2 (USA 96, a sparse tracker)', () => j105Race(2)],
  ['IC37 race 2 (1 Hz around the gate)', () => gateRace('ic37r2')],
  ['C31 Gold Cup race 10 (holes across the gun)', () => c31Race()],
];

describe('gap fill is display only', () => {
  for (const [name, make] of RACES) {
    it(`${name}: results, OCS, start crossings, places, penalties and every Coach card and finding are the same after drawing with the fill`, () => {
      const data = make();
      const before = structuredClone(data.boats);
      const r = results(data);
      const ids = filledBoats(r.a);
      // The race has short gaps to fill, and the fill is drawn (lighter, solid).
      expect(ids.length).toBeGreaterThan(0);
      const svg = drawEverything(r, [...ids, ...r.a.boats.map((b) => b.id)]);
      expect(svg).toMatch(/class="[^"]*\b(trk-est|trail-est|sog-est|lane-est)\b/);
      // The inputs and the analysis drawn from are untouched…
      expect(data.boats).toEqual(before);
      const again = results(data);
      expect(r.a).toEqual(again.a);
      // …and so is everything worked out from them: finishes and places, OCS and start-line crossings, penalty turns,
      // the bump chart's places, each boat's Coach cards, findings and Went well.
      expect(r.raw).toEqual(again.raw);
      expect(r.replays).toEqual(again.replays);
      expect(r.places).toEqual(again.places);
      expect(r.debriefs).toEqual(again.debriefs);
      expect(r.debriefs.some((d) => d && d.cards.length)).toBe(true);
    });
  }

  it('nothing in src/analysis or src/data (nor the workers) imports the display fill', () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|mts|js|mjs)$/.test(f)) files.push(p);
      }
    };
    walk(join(root, 'analysis'));
    walk(join(root, 'data'));
    files.push(join(root, 'worker.ts'), join(root, 'vkxWorker.ts'));
    expect(files.length).toBeGreaterThan(40);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from '[^']*gapFill'|import\([^)]*gapFill/);
    // The feed's holes the drawings carry for the maps (analysis/rawHoles.ts) are made in analyze.ts and moved by transfer.ts; nothing else there reads them.
    const rel = (f: string): string => f.slice(root.length);
    expect(files.filter((f) => /\.holes\b/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual(['analysis/transfer.ts']);
    expect(files.filter((f) => /from '\.\/rawHoles'/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual(['analysis/analyze.ts']);
    // Only the drawing code (src/ui) uses it.
    const users: string[] = [];
    const walkAll = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walkAll(p);
        else if (/\.ts$/.test(f) && /from '\.{1,2}\/(ui\/)?gapFill'/.test(readFileSync(p, 'utf8'))) users.push(p.slice(root.length));
      }
    };
    walkAll(root);
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) expect(u).toMatch(/^ui\//);
  });
});
