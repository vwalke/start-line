import { describe, expect, it } from 'vitest';
import { GAP_MS, SPAN_MS, assessStart, calledOver, rankingValue, sampleGap, startNotes } from '../src/analysis/validity';
import type { StartResult } from '../src/analysis/types';
import { LINE_MATCH_M, RC_NO_DISTANCE, currentDoc, findRace, lineEndsMatch, rcDistanceM, rcStartFix } from '../src/data/racesense/adapter';
import type { StartingStat } from '../src/data/racesense/types';
import { c31Fixture } from './helpers';

describe('Vakaros mask parsing (rcDistanceM)', () => {
  it('bit 1 set: the distance is reported, including a genuine 0', () => {
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: 0, mask: { value: 1 } })).toBe(0);
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: 0, mask: { value: 15 } })).toBe(0);
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: 434, mask: { value: 5 } })).toBe(0.434);
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: -3650, mask: { value: 15 } })).toBe(-3.65);
  });

  it('bit 1 unset: no distance, whatever dtlMm says', () => {
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: 0, mask: { value: 8 } })).toBeNull();
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: 0, mask: { value: 12 } })).toBeNull();
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: 0, mask: { value: 0 } })).toBeNull();
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: 1200, mask: { value: 14 } })).toBeNull();
  });

  it('no mask: null or 0 is missing (unconfirmable), anything else is valid', () => {
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: null })).toBeNull();
    expect(rcDistanceM({ sailNumber: 'x' })).toBeNull();
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: 0 })).toBeNull();
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: 0, mask: null })).toBeNull();
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: 2156 })).toBe(2.156);
    expect(rcDistanceM({ sailNumber: 'x', dtlMm: -800 })).toBe(-0.8);
  });
});

describe('stale Vakaros rows (rcStartFix)', () => {
  const doc = currentDoc(c31Fixture().regatta);
  const { div, race } = findRace(doc, { division: 'C31', raceNumber: 10 });
  const st = race.starts[race.starts.length - 1];
  const row = (sail: string): StartingStat => structuredClone(st.startingStats!.find((s) => s.sailNumber === sail)!);
  const fix = (s: StartingStat | undefined) => rcStartFix(s, div, race, st);
  // Race 10's line: left 43.2793446,6.6662361; right 43.2830638,6.6702316. Feed points are [lon, lat].
  const r10Left: [number, number] = [6.6662361, 43.2793446];
  const r10Right: [number, number] = [6.6702316, 43.2830638];
  const r9Left: [number, number] = [6.665652, 43.2798261];
  const r9Right: [number, number] = [6.6701927, 43.2830349];

  it('a row carrying another race number is stale, named by that race', () => {
    expect(fix(row('GER42'))).toEqual({
      status: 'stale',
      dtlM: null,
      staleRace: 9,
      note: 'Vakaros reported no start fix (stale race 9 data)',
    });
    expect(fix(row('MON2211')).note).toBe('Vakaros reported no start fix (stale race 9 data)');
    // Stale wins over "missing": GER 3183's mask-8 row is race 9's.
    expect(fix(row('GER 3183')).status).toBe('stale');
  });

  it('matching race number but another start’s line: named by the race whose line matches', () => {
    const s = row('FRA 901');
    s.lineLeftLocation = { coordinates: r9Left };
    s.lineRightLocation = { coordinates: r9Right };
    expect(fix(s)).toMatchObject({ status: 'stale', staleRace: 9, note: 'Vakaros reported no start fix (stale race 9 data)' });
  });

  it('a line from no known start is stale data from another start', () => {
    const s = row('FRA 901');
    s.lineLeftLocation = { coordinates: [6.6662361, 43.2803446] }; // ~110 m north
    expect(fix(s)).toMatchObject({ status: 'stale', staleRace: null, note: 'Vakaros reported no start fix (stale data from another start)' });
  });

  it(`line ends within ${LINE_MATCH_M} m match; [0, 0] ends are never compared`, () => {
    const line = st.startLine!;
    const at = (left: [number, number], right: [number, number]): StartingStat => ({
      sailNumber: 'x',
      lineLeftLocation: { coordinates: left },
      lineRightLocation: { coordinates: right },
    });
    expect(lineEndsMatch(at(r10Left, r10Right), line)).toBe(true);
    // ~8.9 m and ~11.1 m north of the left end.
    expect(lineEndsMatch(at([6.6662361, 43.2794246], r10Right), line)).toBe(true);
    expect(lineEndsMatch(at([6.6662361, 43.2794446], r10Right), line)).toBe(false);
    expect(lineEndsMatch(at([0, 0], r10Right), line)).toBe(true);
    expect(lineEndsMatch(at([0, 0], r9Right), line)).toBe(true); // r9's right end is ~3 m from r10's
    expect(lineEndsMatch(at(r9Left, [0, 0]), line)).toBe(false); // ~70 m apart
    expect(lineEndsMatch(at([0, 0], [0, 0]), line)).toBeNull();
    expect(fix(row('TUR3150'))).toEqual({ status: 'ok', dtlM: 3.428 }); // mask 1, no line ends
  });

  it('a start time more than 1 s off is stale; within 1 s is fine', () => {
    const s = row('FRA 901');
    s.startTime = st.startTime! + 900;
    expect(fix(s).status).toBe('ok');
    s.startTime = st.startTime! - 3_900_000; // race 9's gun
    expect(fix(s)).toMatchObject({ status: 'stale', staleRace: 9 });
    s.startTime = st.startTime! + 5_000;
    expect(fix(s)).toMatchObject({ status: 'stale', staleRace: null });
  });

  it('missing distances and genuine zeros', () => {
    expect(fix(row('AUT 3165'))).toEqual({ status: 'missing', dtlM: null, note: RC_NO_DISTANCE });
    expect(RC_NO_DISTANCE).toBe('Vakaros reported no distance for this boat');
    expect(fix(row('GER 21')).status).toBe('missing');
    expect(fix(row('HUN 63')).status).toBe('missing');
    expect(fix(row('ITA 78'))).toEqual({ status: 'ok', dtlM: 0.434 });
    const zero = row('FRA 901');
    zero.dtlMm = 0;
    expect(fix(zero)).toEqual({ status: 'ok', dtlM: 0 });
    delete zero.mask;
    expect(fix(zero).status).toBe('missing');
    expect(fix(undefined)).toEqual({ status: 'none', dtlM: null });
  });
});

describe('gaps in our check (sampleGap)', () => {
  const t = [0, 500, 1000, 18_100, 18_600];
  it(`is fine when a real point is within ${GAP_MS} ms and the hole is at most ${SPAN_MS} ms`, () => {
    expect(sampleGap(t, 750)).toBeNull();
    expect(sampleGap(t, 0)).toBeNull();
    expect(sampleGap(t, 19_000)).toBeNull();
    // Neighbour within 2 s, hole of exactly 5 s: still a real enough sample.
    expect(sampleGap([0, SPAN_MS], 1800)).toBeNull();
  });
  it('reports the bracketing gap when the nearest point is too far', () => {
    expect(sampleGap(t, 9000)).toEqual({ gapS: 17.1, note: 'interpolated across a 17 s data gap' });
    expect(sampleGap(t, 3001)?.gapS).toBe(17.1);
  });
  it(`treats a hole longer than ${SPAN_MS / 1000} s as interpolated even when a neighbour is within ${GAP_MS} ms`, () => {
    // Same series: 3.0 s and 16.1 s sit 2.0 s from an edge of the 17.1 s hole.
    expect(sampleGap(t, 3000)).toEqual({ gapS: 17.1, note: 'interpolated across a 17 s data gap' });
    expect(sampleGap(t, 16_100)).toEqual({ gapS: 17.1, note: 'interpolated across a 17 s data gap' });
    expect(sampleGap([0, SPAN_MS + 1], 1800)?.note).toBe('interpolated across a 5 s data gap');
  });
  it('MON 3159 (C31 Gold Cup race 10): 22 s hole from −2.7 s to +19.4 s, sample ~0.9 s before the gun', () => {
    // Last real point 2.7 s before the gun, next 19.4 s after. The start-fix sample
    // is 0.9 s before the gun — 1.8 s from the nearest point, so the 2 s rule
    // alone would keep it and award a Late from the interpolation.
    const gun = 10_000;
    const tMon = [gun - 2700, gun + 19_400];
    const ts = gun - 900;
    expect(Math.min(ts - tMon[0], tMon[1] - ts)).toBe(1800);
    expect(tMon[1] - tMon[0]).toBe(22_100);
    expect(sampleGap(tMon, ts)).toEqual({ gapS: 22.1, note: 'interpolated across a 22 s data gap' });
    expect(sampleGap(tMon, tMon[0])).toBeNull();
  });
  it('flags samples the track does not cover', () => {
    expect(sampleGap(t, -5000)?.note).toBe('our track starts 5 s after the start fix');
    expect(sampleGap(t, 25_000)?.note).toBe('our track ends 6 s before the start fix');
  });
});

describe('over early and ranking rules', () => {
  it('ranks by Vakaros, else ours without a gap, else not at all', () => {
    expect(rankingValue(0.434, -6, true)).toEqual({ m: 0.434, source: 'vakaros' });
    expect(rankingValue(0, 5, false)).toEqual({ m: 0, source: 'vakaros' });
    expect(rankingValue(null, 2.1, false)).toEqual({ m: 2.1, source: 'ours' });
    expect(rankingValue(null, -3.1, true)).toBeNull();
  });

  it('calls a boat over early only when race control did: its OCS flag, or a scored OCS / UFD / BFD', () => {
    expect(calledOver(true, null)).toBe(true);
    for (const code of ['OCS', 'UFD', 'BFD', 'ocs']) expect(calledOver(false, code)).toBe(true);
    for (const code of ['DNF', 'DSQ', 'DPI', null, undefined]) expect(calledOver(false, code)).toBe(false);
  });

  it('assesses a start: never over from a distance figure, Vakaros or ours', () => {
    const base = { rcDtlM: 7.604, dtlM: 14.9, dtlGapS: null, secsLate: 9, ocs: false };
    expect(assessStart(base)).toEqual({ lateS: 9, rank: { m: 7.604, source: 'vakaros' }, over: false });
    // A gap-interpolated check never ranks and has no Late.
    expect(assessStart({ ...base, rcDtlM: null, dtlM: -3.1, dtlGapS: 17.1 })).toEqual({ lateS: null, rank: null, over: false });
    // Negative distances are numbers, not calls.
    expect(assessStart({ ...base, rcDtlM: -0.5 })).toMatchObject({ rank: { m: -0.5, source: 'vakaros' }, over: false });
    expect(assessStart({ ...base, rcDtlM: null, dtlM: -2.2 })).toMatchObject({ rank: { m: -2.2, source: 'ours' }, over: false });
    expect(assessStart({ ...base, ocs: true }).over).toBe(true);
    expect(assessStart(base, 'UFD').over).toBe(true);
    expect(assessStart(base, 'DNF').over).toBe(false);
  });

  it('lists the Vakaros note; our check across a hole is no caveat (shown plainly)', () => {
    const s = { rcNote: 'Vakaros reported no start fix (stale race 9 data)', dtlNote: 'interpolated across a 17 s data gap' } as StartResult;
    expect(startNotes(s)).toEqual(['Vakaros reported no start fix (stale race 9 data)']);
  });
});
