/**
 * Ask Coach (phase 5): the compact Coach context a question is answered from, shared by the browser
 * (src/ui/coachAskContext.ts fills it from what the Coach tab shows) and the Pages Function
 * (functions/_askCoach.ts re-checks it). Pure.
 *
 * The context carries the Coach's own text and numbers as the page shows them (card titles,
 * sentences, chips, tips; leg chips; regatta rows), rounded, without timestamps, with boat names and
 * sail numbers only (never owners or crew). The server never trusts the browser's copy:
 * `sanitizeAskContext` keeps only the fields below, with their types, clamps every string, array
 * and number, and `contextText` serializes it under MAX_CONTEXT_TOKENS, dropping the lowest-priority
 * sections first and saying so in the context. The serialized text leads with the official penalty
 * (labelled the top impact only when it cost places or the result) and then the findings numbered in
 * Coach's rank order (the array order).
 */

export type AskView = 'race' | 'regatta';
export type AskConfidence = 'high' | 'medium' | 'low';

/** One opportunity card. */
export interface AskFinding {
  title: string;
  /** Seconds at stake (rounded), and the chip as shown (`≈ 30 s`, `10–35 s`). */
  seconds?: number;
  secondsChip?: string;
  /** The window as the card shows it (venue clock `11:06–11:11`, or the legs). */
  when?: string;
  confidence?: AskConfidence;
  /** The boat's tracker coverage of the window, % (0–100). */
  coveragePct?: number;
  chips?: string[];
  /** The ⚠ chips (low confidence, data 58%, wind est., …). */
  warnings?: string[];
  what?: string;
  tip?: string;
}

/** One leg of the leg-by-leg table. */
export interface AskLeg {
  leg: string;
  /** Closed-card chips (side verdict, places, vs group, ⚠ coverage). */
  summary?: string[];
  /** Open-card chips (movers, side numbers, rounding exits, leg times, caveats). */
  details?: string[];
}

/** The penalty card (an official code), as the page shows it. */
export interface AskPenalty {
  code: string;
  /** What the code means, in plain words. */
  meaning?: string;
  /** The card's title: "Cost 3 places — 12th on the water, scored 15th", "Scored UFD — 16 points; the result is lost". */
  result?: string;
  /** Over-the-line figures, penalty turns. */
  chips?: string[];
  what?: string;
}

export interface AskRaceInfo {
  name?: string;
  /** The header chips as shown (place, behind the winner, gun, at stake, ⚠ caveats). */
  header?: string[];
  /** "Not enough tracker data for a debrief", "Only 2 clear gains with this data". */
  notes?: string[];
}

export interface AskRegattaRace {
  race: string;
  place: string;
  note?: string;
  low?: boolean;
}

export interface AskWorkOn {
  title: string;
  why?: string;
  tip?: string;
  /** Weighted seconds over the regatta (the card's ~N s chip). */
  atStakeS?: number;
  pattern?: boolean;
  chips?: string[];
}

export interface AskRecurring {
  finding: string;
  /** "3 of 5" (* = of the races with the data to measure it). */
  races: string;
  atStakeS?: number;
  weightedS?: number;
  where?: string[];
  lowData?: boolean;
}

export interface AskLegType {
  legs: string;
  sailed?: string;
  vsFleet?: string;
  best?: string;
  worst?: string;
}

export interface AskRegatta {
  /** "4 of 6 races analysed · ⚠ 1 with low tracker data". */
  status?: string;
  places?: AskRegattaRace[];
  /** The Penalties row: "DPI in 8 of 8 races · 24 penalty points · ≈ 24 places" (never a theme). */
  penalties?: string[];
  workOn?: AskWorkOn[];
  recurring?: AskRecurring[];
  legTypes?: AskLegType[];
  notes?: string[];
}

export interface AskContext {
  view: AskView;
  boat: { sail: string; name?: string };
  event?: string;
  division?: string;
  /** The peer group the page compares with ("Top 3"). */
  group?: string;
  race?: AskRaceInfo;
  /** The official code's card, pinned above the findings (not ranked by seconds). */
  penalty?: AskPenalty;
  findings?: AskFinding[];
  notTheProblem?: string[];
  /** ✓ notes on thin tracker data: "Not enough data to judge banked gains (tracker 37%)" (never "not the problem"). */
  notJudged?: string[];
  wentWell?: { text: string; seconds?: number }[];
  legs?: AskLeg[];
  regatta?: AskRegatta;
  /** Set by the server only (a browser's value is dropped): the sections left out to fit the cap. */
  trimmed?: string[];
}

// ---- limits

/** The serialized context's cap, tokens (estimated). */
export const MAX_CONTEXT_TOKENS = 6000;
/** Characters per token for the estimate: on the low side (JSON and numbers tokenize densely; Haiku 5.5's tokenizer is ~30% hungrier), so the cap errs safe. */
export const CHARS_PER_TOKEN = 3;
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const S = 160; // a chip or short line
const L = 400; // a sentence or tip

// ---- the schema (a whitelist: anything not named here is dropped)

type Spec =
  | { t: 'str'; max: number }
  | { t: 'num'; min: number; max: number; dp: number }
  | { t: 'bool' }
  | { t: 'enum'; of: readonly string[] }
  | { t: 'arr'; of: Spec; max: number }
  | { t: 'obj'; f: Record<string, Spec>; need?: string[] };

const str = (max: number): Spec => ({ t: 'str', max });
const num = (min: number, max: number, dp = 0): Spec => ({ t: 'num', min, max, dp });
const arr = (of: Spec, max: number): Spec => ({ t: 'arr', of, max });
const obj = (f: Record<string, Spec>, need: string[] = []): Spec => ({ t: 'obj', f, need });
const strs = (max: number, len = S): Spec => arr(str(len), max);

const FINDING = obj(
  {
    title: str(S),
    seconds: num(0, 100_000),
    secondsChip: str(40),
    when: str(60),
    confidence: { t: 'enum', of: ['high', 'medium', 'low'] },
    coveragePct: num(0, 100),
    chips: strs(6),
    warnings: strs(6),
    what: str(L),
    tip: str(L),
  },
  ['title'],
);

const REGATTA = obj({
  status: str(L),
  places: arr(obj({ race: str(40), place: str(60), note: str(S), low: { t: 'bool' } }, ['race', 'place']), 40),
  penalties: strs(8),
  workOn: arr(obj({ title: str(S), why: str(L), tip: str(L), atStakeS: num(0, 1_000_000), pattern: { t: 'bool' }, chips: strs(12, 40) }, ['title']), 6),
  recurring: arr(obj({ finding: str(S), races: str(20), atStakeS: num(0, 1_000_000), weightedS: num(0, 1_000_000), where: strs(40, 20), lowData: { t: 'bool' } }, ['finding', 'races']), 20),
  legTypes: arr(obj({ legs: str(40), sailed: str(60), vsFleet: str(60), best: str(S), worst: str(S) }, ['legs']), 4),
  notes: strs(4, L),
});

export const ASK_CONTEXT_SPEC: Spec = obj(
  {
    view: { t: 'enum', of: ['race', 'regatta'] },
    boat: obj({ sail: str(24), name: str(60) }, ['sail']),
    event: str(120),
    division: str(64),
    group: str(60),
    race: obj({ name: str(80), header: strs(10), notes: strs(4, L) }),
    penalty: obj({ code: str(8), meaning: str(S), result: str(S), chips: strs(6), what: str(L) }, ['code']),
    findings: arr(FINDING, 6),
    notTheProblem: strs(12),
    notJudged: strs(12),
    wentWell: arr(obj({ text: str(S), seconds: num(0, 100_000) }, ['text']), 6),
    legs: arr(obj({ leg: str(40), summary: strs(6), details: strs(16) }, ['leg']), 16),
    regatta: REGATTA,
  },
  ['view', 'boat'],
);

/** Control characters and line breaks become spaces, runs of space collapse; clamped to `max` with an ellipsis. */
export function cleanString(v: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…` : s;
}

/** `v` checked against `spec`: the value kept (clamped, rounded), or undefined when it has the wrong type. */
export function cleanValue(spec: Spec, v: unknown): unknown {
  switch (spec.t) {
    case 'str': {
      if (typeof v !== 'string') return undefined;
      const s = cleanString(v, spec.max);
      return s ? s : undefined;
    }
    case 'num': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
      const k = 10 ** spec.dp;
      return Math.round(Math.min(spec.max, Math.max(spec.min, v)) * k) / k;
    }
    case 'bool':
      return typeof v === 'boolean' ? v : undefined;
    case 'enum':
      return typeof v === 'string' && spec.of.includes(v) ? v : undefined;
    case 'arr': {
      if (!Array.isArray(v)) return undefined;
      const out = v.slice(0, spec.max).map((x) => cleanValue(spec.of, x)).filter((x) => x !== undefined);
      return out.length ? out : undefined;
    }
    case 'obj': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(spec.f)) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
        const x = cleanValue(s, src[k]);
        if (x !== undefined) out[k] = x;
      }
      if ((spec.need ?? []).some((k) => out[k] === undefined)) return undefined;
      return Object.keys(out).length ? out : undefined;
    }
  }
}

/** The browser's context, strictly re-checked; null when it isn't one (no view, no boat). */
export function sanitizeAskContext(raw: unknown): AskContext | null {
  return (cleanValue(ASK_CONTEXT_SPEC, raw) as AskContext | undefined) ?? null;
}

// ---- serialize under the cap

/** What goes first when the context is too big: the lowest-priority detail first, the findings last. */
type Trim = (c: AskContext) => boolean;

/** Drop field `k` from every item of a list; false when none had it. */
function dropEach<T extends object>(list: T[] | undefined, k: keyof T): boolean {
  if (!list?.some((x) => x[k] !== undefined)) return false;
  for (const x of list) delete x[k];
  return true;
}

function dropKey<T extends object>(o: T | undefined, k: keyof T): boolean {
  if (!o || o[k] === undefined) return false;
  delete o[k];
  return true;
}

function keepFirst<T>(list: T[] | undefined, n: number): boolean {
  if (!list || list.length <= n) return false;
  list.length = n;
  return true;
}

const TRIM_STEPS: { name: string; run: Trim }[] = [
  { name: 'leg details', run: (c) => dropEach(c.legs, 'details') },
  { name: 'leg types', run: (c) => dropKey(c.regatta, 'legTypes') },
  { name: 'race-by-race notes', run: (c) => dropEach(c.regatta?.places, 'note') },
  { name: 'not-the-problem row', run: (c) => dropKey(c, 'notTheProblem') },
  { name: 'not-judged row', run: (c) => dropKey(c, 'notJudged') },
  { name: 'recurring findings beyond the first 5', run: (c) => keepFirst(c.regatta?.recurring, 5) },
  { name: 'leg by leg', run: (c) => dropKey(c, 'legs') },
  { name: 'finding chips', run: (c) => dropEach(c.findings, 'chips') },
  { name: 'work-on chips', run: (c) => dropEach(c.regatta?.workOn, 'chips') },
  { name: 'recurring findings', run: (c) => dropKey(c.regatta, 'recurring') },
  { name: 'tips', run: (c) => [dropEach(c.findings, 'tip'), dropEach(c.regatta?.workOn, 'tip')].some(Boolean) },
  { name: 'race places', run: (c) => dropKey(c.regatta, 'places') },
  // The penalty outranks every finding: the findings go before any of it does.
  { name: 'findings beyond the first 2', run: (c) => keepFirst(c.findings, 2) },
  { name: 'penalty chips', run: (c) => dropKey(c.penalty, 'chips') },
];

// ---- the lead: the penalty, then the findings in Coach's order

/** A penalty that cost nothing (no places lost, or redress that improved the score): not the race's top impact. */
const noLoss = (p: AskPenalty): boolean => /^(No places lost|Score adjusted)\b/.test(p.result ?? '');

/**
 * A line of the regatta's Penalties row (penaltyRowText) that cost the boat: a lost result ("16 points; result lost"),
 * or places ("≈ 24 places", "≈ 0.5 places"). Penalty turns, "≈ 0 places" and a code with no places shown cost none
 * here: like `noLoss`, only a row that cost something is the regatta's top impact.
 */
export const penaltyRowCost = (row: string): boolean =>
  !/^Penalty turns\b/.test(row) && (/\bresults? lost\b/.test(row) || Number(/≈ (\d+(?:\.\d+)?) places?\b/.exec(row)?.[1] ?? 0) > 0);

/** The penalty in one line: "Top impact of this race — official penalty: DPI (what it means): Cost 3 places — …", with its chips and the card's sentence. */
export function penaltyLine(p: AskPenalty): string {
  const label = noLoss(p) ? 'Official scoring code of this race (it cost no places)' : 'Top impact of this race — official penalty';
  // The card's sentence opens with the meaning: only what follows it is new.
  const what = p.meaning && p.what?.startsWith(p.meaning) ? p.what.slice(p.meaning.length).replace(/^\.\s*/, '') : (p.what ?? '');
  return [`${label}: ${p.code}${p.meaning ? ` (${p.meaning})` : ''}${p.result ? `: ${p.result}` : ''}.`, p.chips?.length ? `On the track: ${p.chips.join('; ')}.` : '', what].filter(Boolean).join(' ');
}

const findingLine = (f: AskFinding, i: number): string => {
  const s = f.secondsChip ?? (f.seconds != null ? `≈ ${f.seconds} s` : '');
  const conf = f.confidence && f.confidence !== 'high' ? ` (${f.confidence} confidence)` : '';
  return `${i + 1}. ${f.title}${s ? ` ${s}` : ''}${conf}`;
};

/** The lead lines: the penalty (or the regatta's Penalties row) first, then each ranked list numbered in Coach's order. */
function leadLines(c: AskContext): string[] {
  const out: string[] = [];
  if (c.penalty) out.push(penaltyLine(c.penalty));
  if (c.findings?.length) {
    out.push(`Coach's findings, ranked by Coach, biggest first${c.penalty && !noLoss(c.penalty) ? ' (time lost on the water, all after the penalty)' : ''}:`, ...c.findings.map(findingLine));
  }
  const r = c.regatta;
  const top = !!r?.penalties?.some(penaltyRowCost);
  if (r?.penalties?.length) {
    const official = r.penalties.some((p) => !/^Penalty turns\b/.test(p));
    const label = top
      ? 'Top impact across the regatta — Penalties row (official scoring codes and the places they cost):'
      : official
        ? 'Penalties row (official scoring codes; the row shows no places lost):'
        : 'Penalties row (penalty turns, no official code):';
    out.push(label, ...r.penalties.map((p) => `- ${p}`));
  }
  if (r?.workOn?.length) {
    out.push(`Top things to work on, ranked by Coach, biggest first${top ? ' (after the Penalties row)' : ''}:`,...r.workOn.map((w, i) => `${i + 1}. ${w.title}${w.atStakeS != null ? ` ~${w.atStakeS} s` : ''}${w.pattern ? ' (pattern)' : ''}`));
  }
  if (r?.recurring?.length) out.push('Recurring findings: in Coach\'s order, most at stake first (weighted over the regatta); "rank" in the details.');
  return out;
}

/** The context's details as JSON: the penalty is in the lead, each ranked list carries its "rank". */
function detailsOf(c: AskContext, trimmed: string[]): Record<string, unknown> {
  const ranked = <T extends object>(xs: T[] | undefined) => xs?.map((x, i) => ({ rank: i + 1, ...x }));
  const r = c.regatta;
  return {
    ...c,
    penalty: undefined,
    findings: ranked(c.findings),
    regatta: r && { ...r, penalties: undefined, workOn: ranked(r.workOn), recurring: ranked(r.recurring) },
    trimmed: trimmed.length ? trimmed : undefined,
  };
}

/**
 * The context as text within `maxTokens` (estimated): the lead lines (the penalty labelled as the top
 * impact, then the findings numbered in Coach's rank order), then the details as compact JSON.
 * Sections are dropped in TRIM_STEPS order until it fits, named in `trimmed` (inside the JSON, so the
 * model knows what it can't see).
 */
export function contextText(ctx: AskContext, maxTokens = MAX_CONTEXT_TOKENS): { text: string; tokens: number; trimmed: string[] } {
  const c = JSON.parse(JSON.stringify({ ...ctx, trimmed: undefined })) as AskContext;
  const trimmed: string[] = [];
  const render = (): string => [...leadLines(c), `Details (JSON; ranked lists in the same order, "rank" as numbered above):`, JSON.stringify(detailsOf(c, trimmed))].join('\n');
  let text = render();
  for (const step of TRIM_STEPS) {
    if (estimateTokens(text) <= maxTokens) break;
    if (step.run(c)) {
      trimmed.push(step.name);
      text = render();
    }
  }
  // Still over (absurdly long strings within their caps): cut at the end, so the lead (penalty first) stays.
  if (estimateTokens(text) > maxTokens) {
    trimmed.push('the rest (cut at the size cap)');
    const max = maxTokens * CHARS_PER_TOKEN;
    text = render();
    text = `${text.slice(0, max - 1).trimEnd()}…`;
  }
  return { text, tokens: estimateTokens(text), trimmed };
}
