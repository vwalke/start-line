import { describe, expect, it } from 'vitest';
import { gunTimeLine, tzLabel } from '../src/ui/format';

const GUN = Date.parse('2026-10-17T11:40:01.000Z');
const UTC2 = 2 * 3_600_000;

describe('gun time line', () => {
  it('labels the venue zone and omits a matching viewer clock', () => {
    expect(gunTimeLine(GUN, UTC2, UTC2)).toBe('Gun Sat 17 Oct 2026 13:40:01 (venue UTC+2)');
    expect(tzLabel(0)).toBe('UTC');
  });

  it('adds the viewer clock when the zone differs', () => {
    expect(gunTimeLine(GUN, UTC2, 0)).toBe(
      'Gun Sat 17 Oct 2026 13:40:01 (venue UTC+2) · 11:40:01 where you are (UTC)',
    );
  });

  it('repeats the date when the viewer is on another calendar day', () => {
    const utcMinus6 = -6 * 3_600_000;
    expect(gunTimeLine(GUN, UTC2, utcMinus6)).toBe(
      'Gun Sat 17 Oct 2026 13:40:01 (venue UTC+2) · Fri 16 Oct 2026 05:40:01 where you are (UTC−6)',
    );
  });
});
