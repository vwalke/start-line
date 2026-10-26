/**
 * Ask Coach's context (analysis/coach/askContext.ts) from what the Coach tab shows: the same card,
 * leg and regatta texts the page renders (so every number the model may quote is one the sailor
 * can see), seconds rounded, no clock timestamps beyond the cards' own windows, and boats named by
 * name and sail only. Pure.
 */
import type { AskContext, AskFinding, AskLeg, AskPenalty } from '../analysis/coach/askContext';
import type { PenaltyFinding } from '../analysis/coach/penalty';
import type { CoachDebrief } from '../analysis/coach/debrief';
import type { Group } from '../analysis/coach/groups';
import type { LegStory } from '../analysis/coach/legStory';
import type { Card } from '../analysis/coach/rank';
import { summarizeRegatta, legWord, type RegattaRace } from '../analysis/coach/regatta';
import type { BoatResult, RaceAnalysis } from '../analysis/types';
import { GROUP_LABEL } from './coach';
import { cardText, cardWarnings, chipsMax, d5RefChip, fewerLine, goodTexts, penaltyText, secondsChip, thinText, wentText, windowChip } from './coachCards';
import { legStoryText, type StoryChip } from './coachLegs';
import { LEG_TYPE, finishShort, legExtremeText, penaltyRowText, placeWhat, regattaWentText, secs, type RegattaProgress } from './coachRegatta';
import type { Chip } from './info';

/** The boat as the app names it: sail, and the boat name when it has one. */
export function askBoat(b: Pick<BoatResult, 'sail' | 'name'>): AskContext['boat'] {
  return b.name && b.name !== `#${b.sail}` ? { sail: b.sail, name: b.name } : { sail: b.sail };
}

const warnText = (c: Pick<Chip, 'text' | 'warn'>): string => (c.warn ? `⚠ ${c.text}` : c.text);
const storyText = (c: StoryChip): string => (c.cls === 'warn' ? `⚠ ${c.text}` : c.text);

/** Drop empty arrays and undefined fields (the JSON stays small). */
function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out as T;
}

/** One card as the page shows it. */
export function askFinding(c: Card, a: RaceAnalysis): AskFinding {
  const t = cardText(c, a.meta.tzOffsetMs);
  const ref = c.kind === 'D5' ? d5RefChip(c.facts) : null;
  return compact({
    title: t.title,
    seconds: Math.round(c.seconds),
    secondsChip: secondsChip(c),
    when: windowChip(c, a),
    confidence: c.confidence === 'none' ? undefined : c.confidence,
    chips: [...(ref ? [ref] : []), ...t.chips.slice(0, chipsMax(c))],
    warnings: cardWarnings(c),
    what: t.sentence,
    tip: t.tip,
  });
}

/** The penalty card as the page shows it. */
export function askPenalty(p: PenaltyFinding, a: RaceAnalysis): AskPenalty {
  const t = penaltyText(p, a);
  return compact({ code: p.code, meaning: p.meaning, result: t.title, chips: t.chips, what: t.sentence });
}

export function askLeg(s: LegStory, a: RaceAnalysis, boat: string, g: Group): AskLeg {
  const t = legStoryText(s, a, boat, g);
  return compact({ leg: s.name, summary: t.summary.map(storyText), details: [...t.lines.flat().map(storyText), ...(t.sentence ? [t.sentence] : [])] });
}

export interface RaceAskInput {
  a: RaceAnalysis;
  me: BoatResult;
  /** The race's menu name ("R3"), else "Race N". */
  raceName?: string;
  /** The header chips (coachChips). */
  head: Chip[];
  deb: CoachDebrief | null;
  stories: LegStory[];
  group: Group;
}

/** The Race view's context. */
export function raceAskContext(o: RaceAskInput): AskContext {
  const { a, me, deb } = o;
  const notes: string[] = [];
  if (!deb) notes.push('No Coach debrief for this race: no course to measure against, or the wind is still being worked out.');
  else if (deb.noData) notes.push('No debrief for this race');
  else if (deb.cards.length < 3) notes.push(deb.cards.length ? fewerLine(deb.cards.length) : 'No clear gains with this data');
  return compact({
    view: 'race' as const,
    boat: askBoat(me),
    event: a.meta.eventName,
    division: a.meta.division,
    group: GROUP_LABEL[o.group.kind],
    race: compact({ name: o.raceName ?? `Race ${a.meta.raceNumber}`, header: o.head.map(warnText), notes }),
    penalty: deb?.penalty ? askPenalty(deb.penalty, a) : undefined,
    findings: deb?.cards.map((c) => askFinding(c, a)),
    notTheProblem: deb?.ok.filter((n) => !n.thin).flatMap(goodTexts),
    notJudged: deb?.ok.filter((n) => n.thin).map(thinText),
    wentWell: deb?.plus.map((n) => ({ text: wentText(n), seconds: Math.round(n.seconds ?? (typeof n.facts.gainS === 'number' ? n.facts.gainS : 0)) })),
    legs: o.stories.map((s) => askLeg(s, a, me.id, o.group)),
  });
}

export interface RegattaAskInput {
  races: RegattaRace[];
  progress: RegattaProgress;
  boat: Pick<BoatResult, 'sail' | 'name'>;
  event?: string;
  division?: string;
}

/** The Regatta view's context (the same summary the view renders). */
export function regattaAskContext(o: RegattaAskInput): AskContext {
  const s = summarizeRegatta(o.races);
  const errs = s.rows.filter((r) => r.status === 'error').length;
  const status = [
    `${s.done} of ${s.total} races analyzed`,
    ...(o.progress.running ? [`still analyzing ${o.progress.running}`] : []),
    ...(errs ? [`${errs} couldn't be loaded`] : []),
  ].join(' · ');
  const notes: string[] = [];
  if (!s.withData) notes.push('Waiting for the races to be analyzed.');
  if (s.findings.some((f) => f.gated)) notes.push('* of the races where it could be measured (dirty air needs the boats around you; roundings the zone time or the place read; gate choice both gate buoys tracked).');
  return compact({
    view: 'regatta' as const,
    boat: askBoat(o.boat),
    event: o.event,
    division: o.division,
    regatta: compact({
      status,
      penalties: s.penalties.map(penaltyRowText),
      places: s.rows.map((r) => {
        const f = r.digest?.finish ?? null;
        const place = r.status === 'done' ? `${finishShort(f)}${f ? ` of ${f.of}` : ''}` : r.status === 'error' ? 'not loaded' : 'pending';
        return compact({ race: r.label, place, note: placeWhat(r), low: r.low || undefined });
      }),
      workOn: s.top.map((t) => compact({ title: t.title, why: t.why, tip: t.tip, atStakeS: t.score >= 1 ? Math.round(t.score) : undefined, pattern: t.pattern, chips: t.chips })),
      recurring: s.findings.map((f) =>
        compact({ finding: f.label, races: `${f.races} of ${f.of}${f.gated ? '*' : ''}`, atStakeS: Math.round(f.totalS), weightedS: Math.round(f.weightedS), where: f.raceLabels, lowData: f.lowRaces > 0 || undefined }),
      ),
      legTypes: s.legs.map((l) => ({ legs: LEG_TYPE[l.kind], sailed: `${l.legs} ${legWord(l.kind, l.legs)}`, vsFleet: `${secs(l.meanS)} per leg`, best: legExtremeText(l.best), worst: legExtremeText(l.worst) })),
      notes,
    }),
    wentWell: s.withData ? s.went.map((w) => ({ text: regattaWentText(w), seconds: Math.round(w.totalS) })) : undefined,
  });
}
