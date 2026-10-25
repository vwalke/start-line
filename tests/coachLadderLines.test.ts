/**
 * The gap chart's thin lines when the chosen boat finished in the top 3 (Fall Brawl J/70 race 3, official results):
 * the group never includes it, and every rival's line is drawn over the bold group line (the mean of the three), so
 * a rival that runs along it stays visible instead of vanishing under it.
 */
import { describe, expect, it } from 'vitest';
import { rivalLadder } from '../src/analysis/coach';
import { groupIds } from '../src/analysis/coach/groups';
import { ladderChart } from '../src/ui/coach';
import { coachRace, fallbrawlOfficial, fallbrawlRace } from './helpers';

describe('Coach gap chart: a top-3 boat vs Top 3', () => {
  const { a, m } = coachRace(fallbrawlRace('j70r3', fallbrawlOfficial('j70r3')));
  const me = a.boats.find((b) => b.finishPos === 3)!;
  const top = a.boats
    .filter((b) => b.id !== me.id && b.finishPos != null)
    .sort((p, q) => p.finishPos! - q.finishPos!)
    .slice(0, 3)
    .map((b) => b.id);

  it('every group leaves out the chosen boat; Top 3 is the three other leaders', () => {
    expect(a.boats.length).toBeGreaterThanOrEqual(5);
    expect(groupIds(a.boats, me.id, { kind: 'leaders' })).toEqual(top);
    expect(groupIds(a.boats, me.id, { kind: 'near' })).not.toContain(me.id);
    expect(groupIds(a.boats, me.id, { kind: 'fleet' })).not.toContain(me.id);
    expect(groupIds(a.boats, me.id, { kind: 'fleet' })).toHaveLength(a.boats.length - 1);
    expect(groupIds(a.boats, me.id, { kind: 'custom', ids: [me.id, ...top] })).toEqual(top);
  });

  it('each rival has a thin line, drawn after the group line, which is the mean of the three and no single rival', () => {
    const l = rivalLadder(m, a, me.id, { kind: 'leaders' })!;
    expect(l.group).toEqual(top);
    // The mean of three is no rival's own line: hardly any point has the bold line on a thin one (the median, the middle
    // of three, was on one at most points).
    const drawn = l.points.filter((p) => p.behindS != null);
    const onOne = drawn.filter((p) => p.each.some((e) => e === p.behindS)).length;
    expect(onOne).toBeLessThan(drawn.length / 10);
    const svg = ladderChart(a, m, l, { kind: 'leaders' }, { widthPx: 900, each: true });
    const med = svg.indexOf('class="cl-med"');
    expect(med).toBeGreaterThan(-1);
    for (const id of top) {
      const at = svg.indexOf(`class="cl-each" data-boat="${id}"`);
      expect(at, id).toBeGreaterThan(med);
    }
  });
});
