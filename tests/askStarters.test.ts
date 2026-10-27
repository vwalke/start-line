import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { CoachDebrief } from '../src/analysis/coach/debrief';
import type { BoatResult } from '../src/analysis/types';
import { ASK_SUGGESTIONS, askStarters, askStartersHtml, STARTERS } from '../src/ui/coachAsk';
import { fixtureRace } from './helpers';

const a = analyzeRace(fixtureRace());
const base = a.boats.find((b) => b.start && b.legs.length === a.legs.length && b.legs.every(Boolean))!;

/** The boat with its start place and the rank at the end of each leg set. */
function boat(startPlace: number | null, ranks: (number | null)[], start: Partial<NonNullable<BoatResult['start']>> = {}): BoatResult {
  return { ...base, start: { ...base.start!, startPlace, ...start }, legs: base.legs.map((l, i) => (l ? { ...l, rankAtEnd: ranks[i] ?? null } : l)) };
}
/** A debrief whose top card sits in the middle of leg `i`. */
function debOn(i: number): Pick<CoachDebrief, 'cards' | 'noData'> {
  const l = base.legs[i]!;
  const mid = (l.startMs + l.endMs) / 2;
  return { noData: false, cards: [{ t0: mid - 10_000, t1: mid + 10_000 } as CoachDebrief['cards'][number]] };
}

describe('Ask Coach starter questions', () => {
  it('names the top card’s leg: places lost there, else time', () => {
    expect(a.legs.map((l) => l.name)).toEqual(['Beat 1', 'Run 1', 'Beat 2', 'Run 2']);
    // 3rd off the line, 6th after Beat 1: places lost on Beat 1.
    expect(askStarters('race', a, boat(3, [6, 6, 5, 5]), debOn(0))).toEqual(['Why did I lose places on Beat 1?', 'What cost me the most?', 'How was my start?']);
    // The card on Run 1, no places lost there: time.
    expect(askStarters('race', a, boat(3, [6, 6, 5, 5]), debOn(1))[0]).toBe('Where did I lose time on Run 1?');
  });

  it('with no card on a leg, the leg where the most places went', () => {
    expect(askStarters('race', a, boat(2, [2, 3, 6, 6]), null)[0]).toBe('Why did I lose places on Beat 2?');
    expect(askStarters('race', a, boat(2, [2, 3, 6, 6]), { cards: [], noData: true })[0]).toBe('Why did I lose places on Beat 2?');
  });

  it('asks what being over early cost', () => {
    expect(askStarters('race', a, boat(null, [5, 5, 5, 5], { over: true }), null)).toContain('How much did being over early cost me?');
  });

  it('falls back to the general questions: no places lost, no start, no boat, the regatta view', () => {
    const flat = askStarters('race', a, boat(1, [1, 1, 1, 1]), null);
    expect(flat).toEqual(['What cost me the most?', 'How was my start?', ASK_SUGGESTIONS.race[0]]);
    const noStart = askStarters('race', a, { ...boat(1, []), start: null }, null);
    expect(noStart).toHaveLength(STARTERS);
    expect(noStart).not.toContain('How was my start?');
    expect(askStarters('race', null, null, null)).toEqual(ASK_SUGGESTIONS.race.slice(0, STARTERS));
    expect(askStarters('regatta', a, base, debOn(0))).toEqual(ASK_SUGGESTIONS.regatta.slice(0, STARTERS));
  });

  it('always three distinct questions, with no names in them', () => {
    for (const q of [askStarters('race', a, boat(3, [6, 6, 5, 5]), debOn(0)), askStarters('race', a, boat(1, [1, 1, 1, 1]), null)]) {
      expect(q).toHaveLength(STARTERS);
      expect(new Set(q).size).toBe(STARTERS);
      for (const x of q) expect(x).not.toContain(base.name);
    }
  });

  it('chips send the question (data-ask-suggest), disabled while busy', () => {
    const html = askStartersHtml(['Why did I lose places on Beat 1?']);
    expect(html).toBe('<li><button type="button" class="chip ask-sug act act-chip" data-ask-suggest="Why did I lose places on Beat 1?">Why did I lose places on Beat 1?</button></li>');
    expect(askStartersHtml(['x'], true)).toContain(' disabled>');
  });
});

describe('index.html: the Ask Coach panel', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  it('sits at the top of the Coach tab, before the ladder and the cards', () => {
    const at = html.indexOf('id="coach-ask"');
    expect(at).toBeGreaterThan(html.indexOf('id="coach-head-card"'));
    for (const id of ['coach-ladder-card', 'coach-cards', 'coach-regatta', 'coach-legs']) expect(at).toBeLessThan(html.indexOf(`id="${id}"`));
  });

  it('is empty and hidden until the status says it is on (off: nothing shows)', () => {
    expect(html).toContain('<section id="coach-ask" class="card coach-ask" aria-labelledby="coach-ask-title" hidden></section>');
  });
});
