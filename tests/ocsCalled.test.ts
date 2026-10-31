/**
 * Over early only as race control calls it. IC37 R5: USA 017 and USA 019 were on the course side at the gun by their
 * tracks and their Vakaros figures, and RaceSense flagged them OCS. Unlinked, the flag stands: they are over early,
 * with the card, the replay and the table's "over". Linked to the official results they are scored AOK (the
 * flag is cleared), and nothing calls them over: no finding, no card, no replay, no "over" in the table, only
 * their distances as numbers.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildCoach, coachRaw } from '../src/analysis/coach';
import { coachDebrief } from '../src/analysis/coach/debrief';
import { startReplays } from '../src/analysis/startReplay';
import type { RaceData } from '../src/data/types';
import { cardText } from '../src/ui/coachCards';
import { startReplayLinks, replayControls } from '../src/ui/replay';
import { startTable } from '../src/ui/table';
import { ic37LinkedRace, ic37Race } from './helpers';

const OVER = ['USA 017', 'USA 019'];

function race(data: RaceData) {
  const a = analyzeRace(data);
  const raw = coachRaw(a, data);
  const m = buildCoach(a, raw.wind, raw.crossMs, raw.zones ?? null, raw.heel ?? null)!;
  const replays = startReplays(a, data);
  return { a, m, replays, boat: (sail: string) => a.boats.find((b) => b.sail === sail)! };
}

describe('IC37 R5: RaceSense flagged USA 017 and USA 019 OCS', () => {
  const r = race(ic37Race());

  it('they are over early: the finding, the card, the replay and the table say so', () => {
    for (const sail of OVER) {
      const b = r.boat(sail);
      expect(b.start).toMatchObject({ ocs: true, over: true, startPlace: null });
      expect(r.a.findings.map((f) => f.text)).toContain(`#${sail} (${b.name}) was flagged OCS by race control.`);
      const d = coachDebrief(r.a, r.m, b.id)!;
      expect(d.cards.find((c) => c.kind === 'D1')?.variant).toBe('ocs');
    }
    expect(r.replays.map((x) => r.a.boats.find((b) => b.id === x.boat)!.sail).sort()).toEqual(OVER);
    expect(startReplayLinks(r.a, r.replays, null)).toContain('Over early:');
    expect(startTable(r.a, null).match(/class="rk-over">over</g)).toHaveLength(2);
  });
});

describe('IC37 R5 linked: USA 017 and USA 019 scored AOK', () => {
  const r = race(ic37LinkedRace());

  it('their distances are negative numbers, and nothing calls them over', () => {
    for (const sail of OVER) {
      const b = r.boat(sail);
      expect(b.start!.rank!.m).toBeLessThan(0);
      expect(b.start).toMatchObject({ ocs: false, over: false });
      expect(b.start!.startPlace).not.toBeNull();
      const d = coachDebrief(r.a, r.m, b.id)!;
      expect(d.cards.some((c) => c.variant === 'ocs')).toBe(false);
      expect(d.cards.map((c) => cardText(c).title).join(' ')).not.toMatch(/Over early/);
    }
    expect(r.a.findings.map((f) => f.text).join(' ')).not.toMatch(/OCS|over early|over \d|not flagged|may have been over/i);
    expect(r.replays).toEqual([]);
    expect(replayControls(r.a, r.replays, null, null)).toBe('');
    expect(startReplayLinks(r.a, r.replays, null)).toBe('');
    const table = startTable(r.a, null);
    expect(table).not.toContain('rk-over');
    expect(table).not.toContain('>OCS<');
  });
});
