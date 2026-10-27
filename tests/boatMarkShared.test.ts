import { describe, expect, it, vi } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { boatMark } from '../src/ui/boatShape';
import { scrubFrame } from '../src/ui/charts';
import { laneScrub } from '../src/ui/laneSnapshots';
import { laneScrubHtml } from '../src/ui/laneSnapshotsView';
import { scrubWindow, trailWindow } from '../src/ui/scrub';
import { BOAT_TRAIL_MS } from '../src/ui/trail';
import { j105Race } from './helpers';

// Every importer of ui/boatShape.ts sees boatMark through a spy (the real rule underneath).
vi.mock('../src/ui/boatShape', async (orig) => {
  const m = await orig<typeof import('../src/ui/boatShape')>();
  return { ...m, boatMark: vi.fn(m.boatMark) };
});

describe('one boat rule for both maps (ui/boatShape.ts boatMark)', () => {
  const a = analyzeRace(j105Race(1));
  const spy = vi.mocked(boatMark);

  it('the Race Viewer draws every boat through it', () => {
    spy.mockClear();
    const t = a.meta.gunMs + 480_000;
    const f = scrubFrame(a, null, null, {}, { t, win: trailWindow(t, '120', scrubWindow(a)), trailMs: BOAT_TRAIL_MS });
    expect(f.boats.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(f.boats.length);
    // With each boat's freshness and last heading.
    for (const [o] of spy.mock.calls) expect(o).toHaveProperty('stale');
    expect(spy.mock.calls.some(([o]) => 'lastDir' in o)).toBe(true);
  });

  it('Around the gun draws every boat through it too', () => {
    spy.mockClear();
    const me = a.boats[0].id;
    const L = laneScrub(a, { me });
    laneScrubHtml(a, L, 60);
    const placed = L.frame(60).boats.filter((b) => b.pos).length;
    expect(placed).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(placed);
    for (const [o] of spy.mock.calls) expect(o).toHaveProperty('stale');
  });
});
