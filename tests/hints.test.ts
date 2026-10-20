import { describe, expect, it } from 'vitest';
import { HINTS_KEY, dismissHint, dismissedHints, isTouch, showHint, type TouchEnv } from '../src/ui/hints';

const coarse: TouchEnv = { matchMedia: (q) => ({ matches: q === '(pointer: coarse)' }) };
const fine: TouchEnv = { matchMedia: () => ({ matches: false }) };

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const throwing = {
  getItem: (): string | null => {
    throw new Error('SecurityError');
  },
  setItem: (): void => {
    throw new Error('QuotaExceededError');
  },
};

describe('isTouch', () => {
  it('is a coarse primary pointer', () => {
    expect(isTouch(coarse)).toBe(true);
    expect(isTouch(fine)).toBe(false);
  });
  it('a desktop with a touch screen but a fine pointer is not touch', () => {
    expect(isTouch({ ...fine, ontouchstart: null })).toBe(false);
  });
  it('falls back to touch events without matchMedia, or when it throws', () => {
    expect(isTouch({ ontouchstart: null })).toBe(true);
    expect(isTouch({})).toBe(false);
    expect(isTouch(undefined)).toBe(false);
    const broken: TouchEnv = {
      matchMedia: () => {
        throw new Error('no');
      },
    };
    expect(isTouch(broken)).toBe(false);
    expect(isTouch({ ...broken, ontouchstart: null })).toBe(true);
  });
});

describe('the pinch hint', () => {
  it('shows on touch only, until dismissed', () => {
    const s = memStore();
    expect(showHint('pinch', fine, s)).toBe(false);
    expect(showHint('pinch', coarse, s)).toBe(true);
    dismissHint(s, 'pinch');
    expect(s.m.get(HINTS_KEY)).toBe('["pinch"]');
    expect(showHint('pinch', coarse, s)).toBe(false);
    dismissHint(s, 'pinch');
    expect(s.m.get(HINTS_KEY)).toBe('["pinch"]'); // once
  });
  it('keeps other dismissed hints and ignores junk', () => {
    const s = memStore({ [HINTS_KEY]: '["rotate", 3, null]' });
    expect([...dismissedHints(s)]).toEqual(['rotate']);
    dismissHint(s, 'pinch');
    expect(JSON.parse(s.m.get(HINTS_KEY)!)).toEqual(['rotate', 'pinch']);
    expect(dismissedHints(memStore({ [HINTS_KEY]: '{not json' })).size).toBe(0);
    expect(dismissedHints(memStore({ [HINTS_KEY]: '{"pinch":1}' })).size).toBe(0);
  });
  it('never throws on missing or blocked storage (the hint just shows again)', () => {
    expect(showHint('pinch', coarse, throwing)).toBe(true);
    expect(() => dismissHint(throwing, 'pinch')).not.toThrow();
    expect(showHint('pinch', coarse, null)).toBe(true);
    expect(() => dismissHint(null, 'pinch')).not.toThrow();
    expect(showHint('pinch', fine, throwing)).toBe(false);
  });
});
