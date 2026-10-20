/**
 * The Coach's leg stories (analysis/coach/legStory.ts): under the opportunity
 * cards, one collapsed card per leg. Closed, a card shows the leg, which side
 * paid and the coached boat's places; open, one line of chips per item —
 * movers, side, the windward-mark exit (runs), leg times — ⚠ caveats, and one
 * templated sentence. The rules sit behind the section's one ⓘ.
 */
import { GROUP_LABEL } from './coach';
import type { Group } from '../analysis/coach/groups';
import { ROUND_LEAD_MS, ROUND_WINDOW_MS, SIDE_MIN_BOATS, SIDE_MIN_EFFECT, STORY_LOW_COVERAGE, STORY_MIN_GROUP, type LegStory } from '../analysis/coach/legStory';
import type { RaceAnalysis } from '../analysis/types';
import { duration, esc, ordinal, pct } from './format';
import { infoHtml } from './info';

export const LEG_STORY_BULLETS: readonly string[] = [
  'Places: order at the marks, re-ranked inside the group you compare with (and you).',
  `Side: each boat's mean position across the wind over the leg, left/right looking upwind.`,
  `Left/Right paid: that third of the boats gained ${SIDE_MIN_EFFECT}+ places more than the other third (${SIDE_MIN_BOATS}+ boats).`,
  `Gybe-set: a gybe ${ROUND_LEAD_MS / 1000} s before to ${ROUND_WINDOW_MS / 1000} s after the windward mark; else a bear-away.`,
  `Under ${STORY_MIN_GROUP} boats with data in the group: worked out on the whole fleet (chip says so).`,
];

/** Signed, one decimal, with a true minus: "+1.1", "−0.4". */
const signed1 = (x: number): string => `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(1)}`;
/** "+3" / "−2" places. */
const signedN = (n: number): string => `${n < 0 ? '−' : '+'}${Math.abs(n)}`;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "Mirage", or the sail when the boat is unnamed. */
export function shortName(a: RaceAnalysis, id: string): string {
  const b = a.boats.find((x) => x.id === id);
  return b?.name && b.name !== `#${b.sail}` ? b.name : (b?.sail ?? id);
}

const FLEET_CHIP = 'whole fleet: group too small';

export interface LegStoryText {
  /** Shown closed: side verdict, your places. */
  summary: string[];
  /** One line of chips per item; `me` marks the coached boat's chip, `warn` a caveat, `muted` a note. */
  lines: { text: string; cls?: 'me' | 'warn' | 'muted' }[][];
  sentence: string;
}

/** The leg's chips and its one sentence (conditional fragments, no free text). */
export function legStoryText(s: LegStory, a: RaceAnalysis, boat: string): LegStoryText {
  const name = (id: string): string => shortName(a, id);
  const me = s.mine;
  const lines: LegStoryText['lines'] = [];
  const summary: string[] = [];

  // Movers.
  const movers: LegStoryText['lines'][number] = [
    ...s.gainers.map((m) => ({ text: `▲ ${m.id === boat ? 'you' : name(m.id)} ${signedN(m.gain)}`, cls: m.id === boat ? ('me' as const) : undefined })),
    ...s.losers.map((m) => ({ text: `▼ ${m.id === boat ? 'you' : name(m.id)} ${signedN(m.gain)}`, cls: m.id === boat ? ('me' as const) : undefined })),
  ];
  if (me && !s.gainers.concat(s.losers).some((m) => m.id === boat)) {
    movers.push({ text: me.gain ? `${me.gain > 0 ? '▲' : '▼'} you ${signedN(me.gain)}` : `you held ${ordinal(me.to)}`, cls: 'me' });
  }
  if (!movers.length) movers.push({ text: 'no place changes' });
  if (s.moversFleet) movers.push({ text: FLEET_CHIP, cls: 'muted' });
  lines.push(movers);

  // Side.
  const side = s.side;
  if (side) {
    const verdict = side.verdict === 'none' ? 'No side paid' : `${cap(side.verdict)} paid`;
    summary.push(verdict);
    const l: LegStoryText['lines'][number] = [{ text: verdict }];
    if (side.verdict !== 'none') l.push({ text: `${side.n} furthest ${side.verdict} ${signed1(side.verdict === 'right' ? side.right : side.left)} places` });
    if (side.mineM != null) l.push({ text: `you ${Math.round(Math.abs(side.mineM))} m ${side.mineM >= 0 ? 'right' : 'left'}`, cls: 'me' });
    if (side.fleet) l.push({ text: FLEET_CHIP, cls: 'muted' });
    lines.push(l);
  }

  // Leaving the windward mark.
  const r = s.rounding;
  if (r) {
    const l: LegStoryText['lines'][number] = [];
    // A place delta only means something when both exits were used.
    const both = r.gybeSet.n > 0 && r.bearAway.n > 0;
    for (const [k, v, label] of [
      ['gybe-set', r.gybeSet, 'gybe-set'],
      ['bear-away', r.bearAway, 'bear-away'],
    ] as const) {
      if (v.n) l.push({ text: `${label} ${v.n} of ${r.of}${both && v.gain != null ? ` · ${signed1(v.gain)}` : ''}`, cls: r.mine === k ? 'me' : undefined });
    }
    if (r.fleet) l.push({ text: FLEET_CHIP, cls: 'muted' });
    lines.push(l);
  }

  // Leg times.
  const times: LegStoryText['lines'][number] = [];
  if (s.fastest) times.push({ text: `fastest ${name(s.fastest.id)} ${duration(s.fastest.timeS)}`, cls: s.fastest.id === boat ? 'me' : undefined });
  if (s.myTime && s.fastest?.id !== boat) times.push({ text: `your time ${ordinal(s.myTime.rank)} of ${s.myTime.of}`, cls: 'me' });
  if (times.length) lines.push(times);

  // Caveats.
  const warn: LegStoryText['lines'][number] = [];
  if (s.coverage != null && s.coverage < STORY_LOW_COVERAGE) warn.push({ text: `data ${pct(s.coverage)} on this leg`, cls: 'warn' });
  if (s.coverage == null) warn.push({ text: 'no tracked time on this leg', cls: 'warn' });
  if (s.marksEstimated) warn.push({ text: 'marks est.', cls: 'warn' });
  if (warn.length) lines.push(warn);

  if (me) summary.push(me.gain ? `you ${ordinal(me.from)} → ${ordinal(me.to)}` : `you held ${ordinal(me.to)}`);

  // The sentence: side (or the top mover), the exit from the mark, the coached boat.
  const parts: string[] = [];
  if (side && side.verdict !== 'none') {
    const g = side.verdict === 'right' ? side.right : side.left;
    parts.push(`${cap(side.verdict)} paid: the ${side.n} boats furthest ${side.verdict} ${g >= 0 ? 'gained' : 'lost'} ${Math.abs(g).toFixed(1)} places on average`);
  } else if (side) parts.push('No side paid');
  else if (s.gainers[0]) parts.push(`${name(s.gainers[0].id)} gained most (${signedN(s.gainers[0].gain)})`);
  if (r && r.gybeSet.n && r.bearAway.n && r.gybeSet.gain != null && r.bearAway.gain != null) {
    parts.push(`gybe-setters ${signed1(r.gybeSet.gain)} places, bear-aways ${signed1(r.bearAway.gain)}`);
  } else if (r) parts.push(r.gybeSet.n ? `all ${r.gybeSet.n} gybe-set` : `all ${r.bearAway.n} bore away`);
  if (me) parts.push(me.gain > 0 ? `you gained ${me.gain} (${ordinal(me.from)} → ${ordinal(me.to)})` : me.gain < 0 ? `you lost ${-me.gain} (${ordinal(me.from)} → ${ordinal(me.to)})` : `you held ${ordinal(me.to)}`);
  const sentence = parts.length ? `${parts.join('; ')}.` : 'Too little data on this leg.';
  return { summary, lines, sentence };
}

const li = (c: { text: string; cls?: string }): string =>
  c.cls === 'warn'
    ? `<li class="chip warn"><span aria-hidden="true">⚠ </span><span class="vh">Warning: </span>${esc(c.text)}</li>`
    : `<li class="chip${c.cls ? ` ${c.cls}` : ''}">${esc(c.text)}</li>`;

/** One leg's card: a `<details>`, closed unless its leg is in `open`. */
export function legStoryHtml(s: LegStory, a: RaceAnalysis, boat: string, open = false): string {
  const t = legStoryText(s, a, boat);
  return `<details class="card coach-leg" data-leg="${s.leg}"${open ? ' open' : ''}>
    <summary><span class="leg-name">${esc(s.name)}</span><ul class="chips">${t.summary.map((x) => li({ text: x })).join('')}</ul></summary>
    ${t.lines.map((l) => `<ul class="chips">${l.map(li).join('')}</ul>`).join('')}
    <p class="leg-what">${esc(t.sentence)}</p>
  </details>`;
}

/** The section: a short heading with the group and the ⓘ, then the legs (all closed unless in `open`). */
export function legStoriesHtml(stories: LegStory[], a: RaceAnalysis, boat: string, g: Group, open: ReadonlySet<number> = new Set(), infoOpen = false): string {
  if (!stories.length) return '';
  return `<div class="coach-legs-head"><h3 id="coach-legs-title">Leg by leg</h3><ul class="chips"><li class="chip">vs ${esc(GROUP_LABEL[g.kind])}</li><li class="chip-info">${infoHtml(LEG_STORY_BULLETS, { open: infoOpen })}</li></ul></div>
  ${stories.map((s) => legStoryHtml(s, a, boat, open.has(s.leg))).join('')}`;
}
