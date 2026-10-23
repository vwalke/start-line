import { describe, expect, it } from 'vitest';
import type { RaceData } from '../src/data/types';
import { coachRace, d17Tally, fixtureRace, gateRace, ic37Race, j105Race } from './helpers';

/**
 * D17 over every boat of each committed fixture: its cards in the top 3, all it found (before the ranking and the
 * minimums) and its Went well lines. Cascais R2 / R3 are in coachCascais.test.ts (its debriefs, shared). Few legs
 * have turns measured on both sides on the public feed; J/24 R2 is dense on Beat 2.
 */
const FIXTURES: { name: string; data: () => RaceData; cards: number; found: number; plus: number }[] = [
  { name: 'Melges 24 R5', data: () => gateRace('m24r5'), cards: 0, found: 0, plus: 0 },
  { name: 'IC37 R5', data: () => ic37Race(), cards: 0, found: 0, plus: 0 },
  { name: 'Benelux R8', data: () => fixtureRace(), cards: 0, found: 0, plus: 0 },
  { name: 'J/105 R3', data: () => j105Race(3), cards: 0, found: 0, plus: 0 },
  { name: 'Viper R2', data: () => gateRace('viperr2'), cards: 0, found: 0, plus: 0 },
  // USA 3359's "Too many tacks on Beat 2" (11 s, medium; outranked in its top 3); USA 1938 and USA 5354's ➕.
  { name: 'J/24 R2', data: () => gateRace('j24r2'), cards: 0, found: 1, plus: 2 },
];

describe('D17 across the committed fixtures: cards, findings and Went well lines', () => {
  for (const f of FIXTURES) {
    it(`${f.name}: ${f.cards} in the top 3, ${f.found} found, ${f.plus} ➕`, () => {
      const { a, m } = coachRace(f.data());
      expect(d17Tally(a, m)).toEqual({ cards: f.cards, found: f.found, plus: f.plus });
    }, 120_000);
  }
});
