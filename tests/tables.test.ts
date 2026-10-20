import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { RaceAnalysis } from '../src/analysis/types';
import { THOUSANDS, fM, pct } from '../src/ui/format';
import { attachTopScroll, type ScrollEl } from '../src/ui/hscroll';
import { dqCell, legsNotesHtml, legsTable, legsTableKey, sortTable, startTable, startTableKey, toggleSort } from '../src/ui/table';
import { c31Race, fixtureRace } from './helpers';

const keysOf = (html: string): string[] => [...html.matchAll(/data-sort="([^"]+)"/g)].map((m) => m[1]);
const rowIds = (html: string): string[] => [...html.matchAll(/<tr data-id="([^"]+)"/g)].map((m) => m[1]);
/** The inner HTML of each <td> in a boat's row. */
const cells = (html: string, id: string): string[] =>
  [...new RegExp(`<tr data-id="${id}"[^>]*>(.*?)</tr>`).exec(html)![1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
/** A cell by column key, without its ▲/▼ mark. */
const cellOf = (html: string, id: string, key: string): string =>
  cells(html, id)[keysOf(html).indexOf(key)].replace(/^<span class="ic" aria-label="(best|worst)">[▲▼]<\/span>/, '');

describe('format', () => {
  it('writes whole metres with a narrow no-break thousands separator', () => {
    expect(THOUSANDS).toBe(' ');
    expect(fM(845.4)).toBe('845');
    expect(fM(1234.6)).toBe(`1${THOUSANDS}235`);
    expect(fM(1_234_567)).toBe(`1${THOUSANDS}234${THOUSANDS}567`);
    expect(fM(null)).toBe('—');
  });

  it('writes coverage as a whole percent, never rounding up to 100%', () => {
    expect(pct(1)).toBe('100%');
    expect(pct(0.999)).toBe('99%');
    expect(pct(0.72)).toBe('72%');
    expect(pct(undefined)).toBe('—');
  });
});

describe('C31 race 10: the start and legs tables', () => {
  const a = analyzeRace(c31Race());
  const start = startTable(a, null);
  const legs = legsTable(a, null);

  it('the start table has the start columns only', () => {
    expect(keysOf(start)).toEqual(['s.fin', 's.boat', 'start', 'rc', 'ours', 'late', 'line', 'speed', 'twa', 's.heel']);
    expect(start).not.toMatch(/data-sort="L\d/);
    expect(start).toContain('data-table="start"');
    // One header row: no groups.
    expect(start.match(/<tr>/g)).toHaveLength(1);
  });

  it('the legs table keeps the start place but none of the other start columns', () => {
    const keys = keysOf(legs);
    expect(keys.slice(0, 3)).toEqual(['fin', 'boat', 'lstart']);
    for (const k of ['start', 'rc', 'ours', 'late', 'line', 'speed', 'twa']) expect(keys).not.toContain(k);
    expect(cellOf(legs, 'ITA 78', 'lstart')).toBe(cellOf(start, 'ITA 78', 'start'));
  });

  it('keys are unique across both tables, and each table owns its own', () => {
    const s = keysOf(start);
    const l = keysOf(legs);
    expect(new Set([...s, ...l]).size).toBe(s.length + l.length);
    for (const k of s) expect(sortTable(a, k)).toBe('start');
    for (const k of l) expect(sortTable(a, k)).toBe('legs');
    expect(sortTable(a, 'nope')).toBeNull();
  });

  it('upwind / downwind cells are the Phase 3 aggregates', () => {
    for (const b of a.boats) {
      const up = b.upwind!;
      const dn = b.downwind!;
      expect(cellOf(legs, b.id, 'up.vmg')).toBe(`<b>${up.vmgKn.toFixed(2)}</b>`);
      expect(cellOf(legs, b.id, 'up.sog')).toBe(up.sogKn.toFixed(1));
      expect(cellOf(legs, b.id, 'up.twa')).toBe(`${Math.round(up.twaDeg)}°`);
      expect(cellOf(legs, b.id, 'up.dist')).toContain(fM(up.distM));
      expect(cellOf(legs, b.id, 'up.time')).toMatch(new RegExp(`^\\d+:\\d\\d <small class="rk">${up.place}(st|nd|rd|th)</small>$`));
      expect(cellOf(legs, b.id, 'up.tacks')).toContain(String(up.tacks));
      expect(cellOf(legs, b.id, 'dn.gybes')).toContain(String(dn.gybes));
      expect(cellOf(legs, b.id, 'dn.dq')).toContain(pct(dn.coverage));
    }
  });

  it('flags the C31 legs that are mostly holes as low data, with the gap in the title', () => {
    const b = a.boats.find((x) => x.sail === 'FRA 901')!;
    const l = b.legs[0]!;
    expect(cellOf(legs, b.id, 'L0.dq')).toBe(
      `<span class="dq-low" title="Data for ${pct(l.coverage)} of the leg; longest gap ${Math.round(l.maxGapS)} s" aria-label="Low data: Data for ${pct(l.coverage)} of the leg; longest gap ${Math.round(l.maxGapS)} s">⚠ ${pct(l.coverage)}</span>`,
    );
    // Tacks across holes: ~ with an explanation.
    expect(cellOf(legs, b.id, 'L0.tacks')).toMatch(/^<span class="gap" title="Approximate: a tack or gybe here bridges a telemetry gap[^"]*"[^>]*>~4<\/span>$/);
    expect(cellOf(legs, b.id, 'L2.tacks')).toBe('2');
    expect(cellOf(legs, b.id, 'tacks')).toContain(`~${b.legs.reduce((s, x) => s + x!.tacks, 0)}`);
    expect(cellOf(legs, b.id, 'dq')).toContain('class="dq-low"');
  });
});

describe('Benelux J70 r8: legs table', () => {
  const a = analyzeRace(fixtureRace());
  const legs = legsTable(a, null);

  it('distances are whole metres, with the thousands separator', () => {
    const b = a.boats[0];
    expect(b.distM!).toBeGreaterThan(1000);
    expect(cellOf(legs, b.id, 'dist')).toBe(fM(b.distM));
    expect(cellOf(legs, b.id, 'dist')).toContain(THOUSANDS);
    expect(cellOf(legs, b.id, 'L0.dist')).toBe(fM(b.legs[0]!.distM));
    expect(legs).toContain('Dist<br><small>m</small>');
    expect(legs).not.toContain('<small>nm</small>');
  });

  it('shows tacks on beats and gybes on runs, and full data plainly', () => {
    const b = a.boats.find((x) => x.sail === '5')!;
    expect(cellOf(legs, b.id, 'L0.tacks')).toBe('4');
    expect(cellOf(legs, b.id, 'L1.gybes')).toBe('3');
    expect(keysOf(legs)).not.toContain('L0.gybes');
    expect(keysOf(legs)).not.toContain('L1.tacks');
    expect(cellOf(legs, b.id, 'L0.dq')).toBe('<span title="Data for 100% of the leg">100%</span>');
    expect(cellOf(legs, b.id, 'tacks')).toBe(String(b.legs.reduce((s, l) => s + l!.tacks, 0)));
  });

  it('marks an incomplete upwind summary partial, with no place and no ▲/▼', () => {
    const b = a.boats[2];
    const cut: RaceAnalysis = {
      ...a,
      boats: a.boats.map((x) => (x.id === b.id ? { ...x, upwind: { ...x.upwind!, legs: 1, complete: false, place: null } } : x)),
    };
    const html = legsTable(cut, null);
    expect(cellOf(html, b.id, 'up.time')).toMatch(/^<span class="partial" title="Partial: 1 of 2 upwind legs">\d+:\d\d <small class="rk">partial 1\/2<\/small><\/span>$/);
    expect(cellOf(html, b.id, 'up.vmg')).toMatch(/^<span class="partial"/);
  });

  it('sorts each table on its own', () => {
    const legsSort = toggleSort(a, null, 'L0.sog')!;
    const startSort = toggleSort(a, null, 'speed')!;
    expect(startSort).toEqual({ key: 'speed', dir: 'desc' });
    const byStart = [...a.boats].sort((x, y) => y.start!.speedKn - x.start!.speedKn).map((b) => b.id);
    const byLeg = [...a.boats].sort((x, y) => y.legs[0]!.sogKn - x.legs[0]!.sogKn).map((b) => b.id);
    expect(rowIds(startTable(a, null, startSort))).toEqual(byStart);
    expect(rowIds(legsTable(a, null, legsSort))).toEqual(byLeg);
    // A sort meant for the other table leaves this one in finish order, with no indicator.
    expect(rowIds(legsTable(a, null, startSort))).toEqual(a.boats.map((b) => b.id));
    expect(startTable(a, null, legsSort)).not.toContain('aria-sort');
  });

  it('selects the same row in both tables', () => {
    const id = a.boats[3].id;
    for (const html of [startTable(a, id), legsTable(a, id)]) {
      expect(html).toContain(`<tr data-id="${id}" class="sel" tabindex="0">`);
      expect(html.match(/class="sel"/g)).toHaveLength(1);
    }
  });

  it('promotes the race-wide Vakaros DTL warning to a ⚠ chip by the start table', () => {
    expect(startTableKey(a).chips.some((c) => c.text === 'Vakaros DTL off vs GPS')).toBe(false);
    const w = 'Vakaros DTL differs from the GPS tracks by a median 5 m for this start; treat the DTL columns with caution.';
    expect(startTableKey({ ...a, notes: [{ kind: 'dtl-off', text: w, medianM: 5 }] }).chips[0]).toEqual({ text: 'Vakaros DTL off vs GPS', warn: true, title: w });
  });

  it('explains Data % and its threshold in the ⓘ', () => {
    expect(legsTableKey().bullets).toContain('Data: share with fixes ≤ 5 s apart; ⚠ under 90%; ~ bridges a gap.');
    expect(legsNotesHtml()).toContain('<details class="info"><summary>');
  });

  it('keeps only the key line visible: TWA/VMG est., and ~ / partial / ⚠ low data only when present', () => {
    const texts = (x: RaceAnalysis): string[] => legsTableKey(x).chips.map((c) => `${c.warn ? '⚠ ' : ''}${c.text}`);
    const clean = {
      ...a,
      boats: a.boats.map((b) => ({
        ...b,
        distApprox: false,
        coverage: 1,
        legs: b.legs.map((l) => l && { ...l, coverage: 1, heelCoverage: 1, distGapS: null, manoeuvreGap: false }),
        upwind: b.upwind && { ...b.upwind, coverage: 1, heelCoverage: 1, complete: true },
        downwind: b.downwind && { ...b.downwind, coverage: 1, heelCoverage: 1, complete: true },
      })),
    };
    expect(texts(clean)).toEqual(['TWA/VMG est.']);
    const holey = { ...clean, boats: clean.boats.map((b, i) => (i ? b : { ...b, legs: b.legs.map((l, j) => (j || !l ? l : { ...l, coverage: 0.5, distGapS: 30 })) })) };
    expect(texts(holey)).toEqual(['TWA/VMG est.', '⚠ low data', '~ across a gap']);
    const assumed = { ...clean, wind: { ...clean.wind, method: 'course' as const } };
    expect(texts(assumed)).toEqual(['⚠ TWA/VMG: wind assumed']);
  });
});

describe('dqCell', () => {
  it('flags a synthetic low-coverage leg', () => {
    expect(dqCell(0.72, 48, 'leg')).toBe(
      '<span class="dq-low" title="Data for 72% of the leg; longest gap 48 s" aria-label="Low data: Data for 72% of the leg; longest gap 48 s">⚠ 72%</span>',
    );
    expect(dqCell(0.9, 12, 'leg')).toBe('<span title="Data for 90% of the leg; longest gap 12 s">90%</span>');
    expect(dqCell(0.97, 2, 'race')).toBe('<span title="Data for 97% of the race">97%</span>');
    expect(dqCell(null, null, 'leg')).toBe('—');
  });
});

describe('attachTopScroll', () => {
  function el(scrollWidth: number, clientWidth: number) {
    const fns: (() => void)[] = [];
    const e = {
      scrollWidth,
      clientWidth,
      hidden: false,
      _left: 0,
      get scrollLeft() {
        return this._left;
      },
      set scrollLeft(v: number) {
        this._left = Math.max(0, Math.min(v, this.scrollWidth - this.clientWidth));
        for (const f of fns) f(); // the browser fires scroll on a change
      },
      addEventListener: (_t: 'scroll', f: () => void) => void fns.push(f),
      removeEventListener: (_t: 'scroll', f: () => void) => {
        const i = fns.indexOf(f);
        if (i >= 0) fns.splice(i, 1);
      },
    };
    return e as ScrollEl & { _left: number };
  }

  it('sizes the spacer to the table and hides the bar when nothing overflows', () => {
    const spacer = { style: { width: '' } };
    const mirror = el(1500, 400);
    const wide = attachTopScroll(mirror, spacer, el(1500, 400));
    wide.update();
    expect(mirror.hidden).toBe(false);
    expect(spacer.style.width).toBe('1500px');
    const narrowMirror = el(400, 400);
    attachTopScroll(narrowMirror, { style: { width: '' } }, el(400, 400)).update();
    expect(narrowMirror.hidden).toBe(true);
  });

  it('keeps the two scrollers in step both ways', () => {
    const mirror = el(1500, 400);
    const wrap = el(1500, 400);
    attachTopScroll(mirror, { style: { width: '' } }, wrap).update();
    wrap.scrollLeft = 300;
    expect(mirror.scrollLeft).toBe(300);
    mirror.scrollLeft = 120;
    expect(wrap.scrollLeft).toBe(120);
  });

  it('disconnect drops the scroll listeners so the two sides stop following', () => {
    const mirror = el(1500, 400);
    const wrap = el(1500, 400);
    const bar = attachTopScroll(mirror, { style: { width: '' } }, wrap);
    bar.update();
    bar.disconnect();
    wrap.scrollLeft = 300;
    expect(mirror.scrollLeft).toBe(0);
    mirror.scrollLeft = 120;
    expect(wrap.scrollLeft).toBe(300);
  });
});
