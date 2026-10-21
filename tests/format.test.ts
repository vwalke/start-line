import { describe, expect, it } from 'vitest';
import { gunTimeLine, legCount, tzLabel } from '../src/ui/format';

const GUN = Date.parse('2026-10-17T11:40:01.000Z');
const UTC2 = 2 * 3_600_000;

describe('gun time line', () => {
  it('labels the venue clock local and omits a matching viewer clock', () => {
    expect(gunTimeLine(GUN, UTC2, UTC2)).toBe('Sat 17 Oct 2026 13:40:01 (local)');
    expect(tzLabel(0)).toBe('UTC');
  });

  it('adds the viewer clock when the zone differs', () => {
    expect(gunTimeLine(GUN, UTC2, 0)).toBe('Sat 17 Oct 2026 13:40:01 (local) · 11:40:01 where you are (UTC)');
  });

  it('repeats the date when the viewer is on another calendar day', () => {
    const utcMinus12 = -12 * 3_600_000;
    expect(gunTimeLine(GUN, UTC2, utcMinus12)).toBe('Sat 17 Oct 2026 13:40:01 (local) · Fri 16 Oct 2026 23:40:01 where you are (UTC−12)');
  });

  it('never says Gun or the venue offset', () => {
    for (const v of [UTC2, 0]) expect(gunTimeLine(GUN, UTC2, v)).not.toMatch(/Gun|venue|UTC\+2/);
  });
});

describe('leg count', () => {
  it('counts the legs, singular for one', () => {
    expect(legCount(4)).toBe('4 legs');
    expect(legCount(1)).toBe('1 leg');
  });
});
