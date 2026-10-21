/**
 * The Coach's leg stories (analysis/coach/legStory.ts): under the opportunity
 * cards, one collapsed card per leg. Closed, a card shows the leg, which side
 * paid, the coached boat's places gained or lost in the whole fleet with its
 * place at the leg's end (always out of the same fleet), its seconds against
 * the group's median leg time (Top 3, Near), and a ⚠ coverage chip when the
 * tracker is thin; open, one line of chips per item — movers, side,
 * the windward-mark exit (runs), leg times — and ⚠ caveats. The rules sit
 * behind the section's one ⓘ. No restating sentence: chips carry the facts.
 */
import { GROUP_LABEL } from './coach';
import type { Group } from '../analysis/coach/groups';
import { ROUND_LEAD_MS, ROUND_WINDOW_MS, SIDE_MIN_BOATS, SIDE_MIN_EFFECT, STORY_LOW_COVERAGE, STORY_MIN_GROUP, type LegStory } from '../analysis/coach/legStory';
import type { RaceAnalysis } from '../analysis/types';
import { duration, esc, ordinal, pct } from './format';
import { infoHtml } from './info';

export const LEG_STORY_BULLETS: readonly string[] = [
  'Places: in the whole fleet, out of every boat that started, the same all race.',
  'A boat missing at a mark is placed from its times either side (~); none drop out.',
  'Vs Top 3 / Near: your leg time against the median of theirs.',
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

/** Short group label on a seconds chip: "vs Top 3". */
const vsLabel = (g: Group): string =>
  g.kind === 'leaders' ? 'Top 3' : g.kind === 'near' ? 'Near ±3' : g.kind === 'fleet' ? 'fleet' : 'your group';

/** "gained 3" / "lost 5" / "even": places on a leg. */
export const placesWord = (gain: number): string => (gain > 0 ? `gained ${gain}` : gain < 0 ? `lost ${-gain}` : 'even');

export type StoryChip = { text: string; cls?: 'me' | 'warn' | 'muted' };

export interface LegStoryText {
  /** Shown closed: side verdict, your group places, ⚠ coverage when the tracker is thin. */
  summary: StoryChip[];
  /** One line of chips per item; `me` marks the coached boat's chip, `warn` a caveat, `muted` a note. */
  lines: StoryChip[][];
  /** Empty when the chips already say it; only a last-resort line. */
  sentence: string;
}

/** The boat's fleet places on the leg and its place at the leg's end, out of the fixed fleet: "gained 3 · 12th of 33" (~ when estimated). */
export function placeChip(s: Pick<LegStory, 'mine' | 'placeOf'>): string | null {
  const me = s.mine;
  if (!me) return null;
  return `${placesWord(me.gain)} · ${me.est ? '~' : ''}${ordinal(me.to)} of ${s.placeOf}`;
}

/** Against a group: "lost 12 s vs Top 3" / "gained 8 s vs Top 3" / "even with Top 3" (the leg time vs the group's median). */
export function groupSecondsChip(s: Pick<LegStory, 'vsGroup'>, g: Group): string | null {
  const v = s.vsGroup;
  if (!v || g.kind === 'fleet') return null;
  const d = Math.round(v.deltaS);
  return d > 0 ? `lost ${d} s vs ${vsLabel(g)}` : d < 0 ? `gained ${-d} s vs ${vsLabel(g)}` : `even with ${vsLabel(g)}`;
}

/** The leg's chips. Explanations sit in the section ⓘ; caveats are ⚠ chips, not a paragraph. */
export function legStoryText(s: LegStory, a: RaceAnalysis, boat: string, g: Group): LegStoryText {
  const name = (id: string): string => shortName(a, id);
  const me = s.mine;
  const lines: LegStoryText['lines'] = [];
  const summary: StoryChip[] = [];
  // One "whole fleet" chip per card: the same fallback can apply to movers, side and rounding.
  let fleetNoted = false;
  const fleetChip = (): StoryChip | null => {
    if (fleetNoted) return null;
    fleetNoted = true;
    return { text: FLEET_CHIP, cls: 'muted' };
  };

  // Movers: fleet places gained or lost (the closed row has the coached boat's own).
  const movers: StoryChip[] = [
    ...s.gainers.map((m) => ({ text: `▲ ${m.id === boat ? 'you' : name(m.id)} ${signedN(m.gain)}`, cls: m.id === boat ? ('me' as const) : undefined })),
    ...s.losers.map((m) => ({ text: `▼ ${m.id === boat ? 'you' : name(m.id)} ${signedN(m.gain)}`, cls: m.id === boat ? ('me' as const) : undefined })),
  ];
  if (me && me.gain && !s.gainers.concat(s.losers).some((m) => m.id === boat)) movers.push({ text: `${me.gain > 0 ? '▲' : '▼'} you ${signedN(me.gain)}`, cls: 'me' });
  if (!movers.length) movers.push({ text: 'no place changes' });
  if (s.moversFleet) {
    const fc = fleetChip();
    if (fc) movers.push(fc);
  }
  lines.push(movers);

  // Side — verdict lives on the summary; the open card only adds the numbers.
  const side = s.side;
  if (side) {
    summary.push({ text: side.verdict === 'none' ? 'No side paid' : `${cap(side.verdict)} paid` });
    const l: StoryChip[] = [];
    if (side.verdict !== 'none') l.push({ text: `${side.n} furthest ${side.verdict} ${signed1(side.verdict === 'right' ? side.right : side.left)} places` });
    if (side.mineM != null) l.push({ text: `you ${Math.round(Math.abs(side.mineM))} m ${side.mineM >= 0 ? 'right' : 'left'}`, cls: 'me' });
    if (side.fleet) {
      const fc = fleetChip();
      if (fc) l.push(fc);
    }
    if (l.length) lines.push(l);
  }

  // Leaving the windward mark.
  const r = s.rounding;
  if (r) {
    const l: StoryChip[] = [];
    // A place delta only means something when both exits were used.
    const both = r.gybeSet.n > 0 && r.bearAway.n > 0;
    for (const [k, v, label] of [
      ['gybe-set', r.gybeSet, 'gybe-set'],
      ['bear-away', r.bearAway, 'bear-away'],
    ] as const) {
      if (v.n) l.push({ text: `${label} ${v.n} of ${r.of}${both && v.gain != null ? ` · ${signed1(v.gain)}` : ''}`, cls: r.mine === k ? 'me' : undefined });
    }
    if (r.fleet) {
      const fc = fleetChip();
      if (fc) l.push(fc);
    }
    if (l.length) lines.push(l);
  }

  // Leg times.
  const times: StoryChip[] = [];
  if (s.fastest) times.push({ text: `fastest ${name(s.fastest.id)} ${duration(s.fastest.timeS)}`, cls: s.fastest.id === boat ? 'me' : undefined });
  if (s.myTime && s.fastest?.id !== boat) times.push({ text: `your leg time ${ordinal(s.myTime.rank)} fastest`, cls: 'me' });
  if (times.length) lines.push(times);

  // Caveats: coverage is on the summary (a collapsed row with 15% data must not look empty).
  const warn: StoryChip[] = [];
  if (s.marksEstimated) warn.push({ text: 'marks est.', cls: 'warn' });
  if (me?.est) warn.push({ text: '~ place estimated: a rounding not tracked', cls: 'muted' });
  if (warn.length) lines.push(warn);

  const places = placeChip(s);
  if (places) summary.push({ text: places, cls: 'me' });
  const secs = groupSecondsChip(s, g);
  if (secs) summary.push({ text: secs, cls: 'me' });
  if (s.coverage != null && s.coverage < STORY_LOW_COVERAGE) summary.push({ text: `tracker ${pct(s.coverage)}`, cls: 'warn' });
  else if (s.coverage == null) summary.push({ text: 'no data', cls: 'warn' });

  const hasBody = lines.some((l) => l.length) || summary.length > 0;
  return { summary, lines, sentence: hasBody ? '' : 'Too little data on this leg.' };
}

const li = (c: { text: string; cls?: string }): string =>
  c.cls === 'warn'
    ? `<li class="chip warn"><span aria-hidden="true">⚠ </span><span class="vh">Warning: </span>${esc(c.text)}</li>`
    : `<li class="chip${c.cls ? ` ${c.cls}` : ''}">${esc(c.text)}</li>`;

/** One leg's card: a `<details>`, closed unless its leg is in `open`. */
export function legStoryHtml(s: LegStory, a: RaceAnalysis, boat: string, g: Group, open = false): string {
  const t = legStoryText(s, a, boat, g);
  return `<details class="card coach-leg" data-leg="${s.leg}"${open ? ' open' : ''}>
    <summary><span class="leg-name">${esc(s.name)}</span><ul class="chips">${t.summary.map(li).join('')}</ul></summary>
    ${t.lines.map((l) => `<ul class="chips">${l.map(li).join('')}</ul>`).join('')}
    ${t.sentence ? `<p class="leg-what">${esc(t.sentence)}</p>` : ''}
  </details>`;
}

/** The section: a short heading with the group and the ⓘ, then the legs (all closed unless in `open`). */
export function legStoriesHtml(stories: LegStory[], a: RaceAnalysis, boat: string, g: Group, open: ReadonlySet<number> = new Set(), infoOpen = false): string {
  if (!stories.length) return '';
  return `<div class="coach-legs-head"><h3 id="coach-legs-title">Leg by leg</h3><ul class="chips"><li class="chip">vs ${esc(GROUP_LABEL[g.kind])}</li><li class="chip-info">${infoHtml(LEG_STORY_BULLETS, { open: infoOpen })}</li></ul></div>
  ${stories.map((s) => legStoryHtml(s, a, boat, g, open.has(s.leg))).join('')}`;
}
