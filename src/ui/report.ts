/**
 * The boat Report (Chris: "select a boat and have all of the metrics spit out in a clean report"): one
 * printable page for the selected boat in the selected race, built only from what Recall already works
 * out — the race analysis (start, legs, results), the Coach model and debrief (the same build and the same
 * group as the Coach tab), the leg stories, the penalty card (D12), the roundings and gate (D9 / D13) and the
 * official results' elapsed / corrected times. Nothing new is measured here: a figure the data lacks is '—'. Pure: reportView.ts renders the model.
 *
 * Owner and crew names never reach the report: the official rows are read for their times only, and the
 * boat is named by RaceSense's sail and boat name.
 *
 * The report is opened by the `#report` hash (where the tabs' hash goes) or `report=1`, at /regattas/report.
 * Opening or closing it pushes a history entry (ui/nav.ts), so back closes it; the app's popstate handler
 * opens or closes it to match the entry. It follows the Coach's view: `cview=regatta` gives the regatta
 * version (one line per race, the Regatta view's penalties, things to work on and Went well).
 */
import type { CoachModel } from '../analysis/coach';
import { coachDebrief, type CoachDebrief } from '../analysis/coach/debrief';
import { coachCtx } from '../analysis/coach/detectors/context';
import { startOrder } from '../analysis/coach/detectors/start';
import { fleetOf } from '../analysis/coach/fleet';
import { groupIds, type Group } from '../analysis/coach/groups';
import { legStories, type LegStory } from '../analysis/coach/legStory';
import type { GoodNote } from '../analysis/coach/opportunity';
import type { Card } from '../analysis/coach/rank';
import type { RegattaSummary } from '../analysis/coach/regatta';
import { median } from '../analysis/geo';
import { biasAngle, lineBias, windSource } from '../analysis/line';
import { D16_MIN_DEG } from '../analysis/coach/detectors/lineBias';
import { legCost, type LegCost } from '../analysis/coach/detectors/manoeuvreCost';
import { finishRank } from '../analysis/result';
import { shownLateS } from '../analysis/validity';
import type { BoatResult, LegKind, RaceAnalysis } from '../analysis/types';
import { codeInfo, pointsText } from '../data/official/codes';
import type { OfficialRaceInput } from '../data/racesense/adapter';
import { GROUP_LABEL, coachBoatFor } from './coach';
import { cardText, cardWarnings, goodTexts, penaltyText, rankedHead, scoredWord, secondsChip, thinText, thinWhat, turnChip, wentText } from './coachCards';
import { gateChip, groupSecondsChip, placesWord } from './coachLegs';
import { LEG_TYPE, finishShort, penaltyRowText, regattaWentText, secs } from './coachRegatta';
import { degLabel, duration, f0, f1, localTime, ordinal, tzLabel } from './format';
import { codeShort, codeWords } from './resultText';

/** What the report shows for a figure the data doesn't have. */
export const MISSING = '—';

// ---- the route

export const REPORT_HASH = '#report';
export const REPORT_PARAM = 'report';

/** Whether the URL opens the report: the `#report` hash, or `report=1` (any of 1 / true / yes). */
export function reportFromUrl(search: string, hash: string | null | undefined): boolean {
  if ((hash ?? '').replace(/^#/, '') === REPORT_HASH.slice(1)) return true;
  const v = new URLSearchParams(search).get(REPORT_PARAM);
  return v != null && /^(1|true|yes)$/i.test(v.trim());
}

/** `href` with the report opened (`#report`) or closed (`backHash`, the tab's own; `report=` dropped either way). */
export function reportHref(href: string, open: boolean, backHash: string): string {
  const u = new URL(href);
  u.searchParams.delete(REPORT_PARAM);
  u.hash = open ? REPORT_HASH : backHash;
  return u.toString();
}

/**
 * The boat the report shows: the boat selected in the app when it sailed this race (as the Coach); with the selection
 * cleared, the boat last selected (`remembered`, the Coach's boat, kept in `boat=`), so the open report and the URL
 * keep it. Null when neither sailed the race.
 */
export const reportBoatFor = (a: Pick<RaceAnalysis, 'boats'>, highlight: string | null, remembered: string | null): string | null =>
  coachBoatFor(a, highlight) ?? (highlight == null ? coachBoatFor(a, remembered) : null);

// ---- the model

/** One labelled figure. `warn`: a caveat (⚠); `note`: what it rests on or why it is missing. */
export interface ReportField {
  label: string;
  value: string;
  note?: string;
  warn?: boolean;
}

export interface ReportLeg {
  leg: number;
  name: string;
  /** "Upwind" / "Downwind" / "Reach". */
  type: string;
  /** "5th → 3rd" in the fixed fleet (~ estimated), and the change ("gained 2"). */
  places: string;
  change: string;
  /** Leg time, and the seconds against the group's median leg time ("+12 s"). */
  time: string;
  vsGroup: string;
  /** "6.1 / 6.3": the boat's, then the group's median, kn. */
  sog: string;
  vmg: string;
  /** "5 tacks", "3 gybes", "2 tacks · 1 gybe". */
  manoeuvres: string;
  /** "120 m right · Left paid"; the gate buoy when it ended at a gate. */
  side: string;
  gate: string;
}

export interface ReportLine {
  text: string;
  /** "≈ 12 s", "+8 s". */
  seconds?: string;
  /** 'card': a ranked Coach card (its number in `n`); 'plus': went well; 'ok': ✓; 'note': a plain fact. */
  kind: 'card' | 'plus' | 'ok' | 'note' | 'warn';
  n?: number;
}

export interface ReportFinding {
  n: number;
  title: string;
  seconds: string;
  sentence: string;
  confidence: string;
  warnings: string[];
  kind: string;
}

export interface ReportCoach {
  /** The penalty card, pinned first (never numbered). */
  penalty: { code: string; title: string; chips: string[]; sentence: string } | null;
  /** The heading over the ranked findings under a penalty card. */
  rankedHead: string | null;
  findings: ReportFinding[];
  /** Seconds at stake over the findings. */
  totalS: number | null;
  went: { text: string; seconds: string }[];
  ok: string[];
  /** ✓ notes on thin tracker data, under "Not judged:" ("banked gains"). */
  notJudged: string[];
  /** Up to 3: the ranked cards' tips (the race view has no list of its own). */
  workOn: string[];
  /** Why there is nothing to show (no data, no course, still working). */
  empty: string | null;
}

export interface ReportRegattaRow {
  label: string;
  place: string;
  of: string;
  onWater: string;
  findings: string;
  status: string;
}

export interface ReportRegatta {
  rows: ReportRegattaRow[];
  done: number;
  total: number;
  /** Every race analysed or failed: nothing still to come. */
  settled: boolean;
  penalties: string[];
  workOn: { title: string; why: string; tip: string; score: string }[];
  went: { text: string; seconds: string }[];
  legs: { type: string; text: string }[];
}

export type ReportState = 'no-boat' | 'pending' | 'ready';

export interface ReportModel {
  state: ReportState;
  scope: 'race' | 'regatta';
  event: string;
  division: string;
  race: string;
  /** Sail and boat name (RaceSense's); empty with no boat. */
  sail: string;
  boatName: string;
  boatId: string | null;
  /** The Coach's comparison group, as its control names it ("Top 3"). */
  groupLabel: string;
  header: ReportField[];
  start: ReportField[];
  /** The start card's verdict (D1 / the merged start card, else ✓ front row, else none). */
  startVerdict: ReportLine;
  legs: ReportLeg[];
  roundings: ReportLine[];
  penalties: ReportLine[];
  coach: ReportCoach;
  regatta: ReportRegatta | null;
  /** Where the figures come from, and confidence caveats, as sentences. */
  notes: string[];
}

export interface ReportInput {
  a: RaceAnalysis;
  /** The boat to report on (reportBoatFor); null: the report asks for one. */
  boat: string | null;
  /** The Race menu's name for the race ("Race 5"); else from the race number. */
  raceName?: string;
  /** The Coach model: undefined while it is being built, null when the race has no course to measure against. */
  model: CoachModel | null | undefined;
  /** The Coach tab's debrief for this boat and model, when it has one cached (else worked out here, the same way). */
  deb?: CoachDebrief | null;
  /** The Coach's group (`grp=`). */
  group: Group;
  /** The race's official results, for the elapsed and corrected times only. */
  official?: OfficialRaceInput | null;
  /** The Regatta view's summary (the regatta version); null / absent for the race report. */
  regatta?: RegattaSummary | null;
  /** The regatta version: the Coach's view is Regatta. */
  scope?: 'race' | 'regatta';
  /** Official results are still being linked (or the race is about to be analysed again with them): held as pending. */
  settling?: boolean;
}

const LEG_KIND: Record<LegKind, string> = { upwind: 'Upwind', downwind: 'Downwind', reach: 'Reach' };

const signedS = (s: number): string => secs(s);
const field = (label: string, value: string, extra: Omit<ReportField, 'label' | 'value'> = {}): ReportField => ({ label, value: value || MISSING, ...extra });

/** "Pin end", "Middle", "RC end" for a line position (0 pin … 100 RC), by thirds. */
export const lineThird = (pctAlong: number): string => (pctAlong < 100 / 3 ? 'pin end' : pctAlong > 200 / 3 ? 'RC end' : 'middle');

/** The official row paired with this boat (by RaceSense sail), times only. */
function officialTimes(o: OfficialRaceInput | null | undefined, b: BoatResult): { elapsedS: number | null; correctedS: number | null } | null {
  const r = o?.rows.find((x) => x.rsSail === b.sail);
  return r ? { elapsedS: r.elapsedS ?? null, correctedS: r.correctedS ?? null } : null;
}

/** Hours when long: "1:05:12"; else "54:12". */
export function longDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return MISSING;
  if (s < 3600) return duration(s);
  const h = Math.floor(s / 3600);
  const rest = duration(s - h * 3600);
  return `${h}:${rest.padStart(5, '0')}`;
}

/**
 * The header's scored place: "12th of 15"; a boat that finished with a points code (DPI, SCP, …) as the Coach's penalty
 * card puts it, "15th (DPI, +3 places)"; a code with no scored place ("DNF", "DSQ"); — with neither.
 */
export function scoredText(b: Pick<BoatResult, 'finishPos' | 'finishCode' | 'scoredPoints' | 'onWaterPlace' | 'penaltyPlaces'>, of: number): string {
  if (b.finishPos != null) return `${ordinal(b.finishPos)} of ${of}`;
  if (!b.finishCode) return MISSING;
  if (b.onWaterPlace == null || b.scoredPoints == null || codeInfo(b.finishCode).lost) return b.finishCode;
  const n = b.penaltyPlaces ?? 0;
  return `${scoredWord(b.scoredPoints)} (${b.finishCode}${n > 0 ? `, +${pointsText(n)} ${n === 1 ? 'place' : 'places'}` : ''})`;
}

function headerFields(a: RaceAnalysis, b: BoatResult, official: OfficialRaceInput | null | undefined): ReportField[] {
  const tz = a.meta.tzOffsetMs;
  const res = a.meta.results;
  const isOfficial = res?.places === 'official';
  const of = fleetOf(a);
  const out: ReportField[] = [];
  const water = finishRank(b);
  const tilde = b.finishSource === 'tracker' ? '~' : '';
  out.push(
    field('On the water', water != null ? `${tilde}${ordinal(water)} of ${of}` : MISSING, {
      note: water == null ? (b.finishCode ? codeWords(b) : 'no finish found') : b.finishSource === 'tracker' ? 'from the tracker finish' : undefined,
    }),
  );
  if (isOfficial) {
    out.push(field('Scored', scoredText(b, of), b.finishCode ? { note: codeInfo(b.finishCode).meaning, warn: true } : {}));
  } else out.push(field('Scored', MISSING, { note: 'no official results linked' }));
  const ot = officialTimes(official, b);
  out.push(field('Race time', longDuration(b.raceTimeS), { note: b.raceTimeS != null ? 'gun → finish' : 'no finish' }));
  out.push(field('Elapsed (official)', longDuration(ot?.elapsedS), ot?.elapsedS == null ? { note: ot ? 'not in the official results' : 'no official results' } : {}));
  out.push(field('Corrected (official)', longDuration(ot?.correctedS), ot?.correctedS == null ? { note: ot ? 'not in the official results' : 'no official results' } : {}));
  out.push(field('Gun', `${localTime(a.meta.gunMs, tz)} ${tzLabel(tz)}`));
  const src = windSource(a.wind);
  const what = src.method === 'tacks' ? 'from how the fleet tacked' : src.method === 'model' ? 'from the weather model' : 'assumed from the course';
  out.push(field('Wind (TWD)', `${degLabel(a.wind.twdAtGunDeg)} est.`, { note: `${what}; ${src.confidence} confidence`, warn: src.confidence === 'low' }));
  return out;
}

/** The start's figures: the start table's, the crossing order (Coach's startOrder) and the over-early return. */
function startFields(a: RaceAnalysis, m: CoachModel | null | undefined, b: BoatResult): ReportField[] {
  const st = b.start;
  const gun = a.meta.gunMs;
  if (!st) return [field('Start', MISSING, { note: 'no track at the gun' })];
  const out: ReportField[] = [];
  const over = st.over;
  out.push(
    field('Distance to line at gun', over ? `over ${f0(Math.max(1, Math.abs(st.rank?.m ?? st.dtlM)))} m` : `${f0(st.rank?.m ?? st.dtlM)} m`, {
      note: st.rank?.source === 'vakaros' ? 'Vakaros DTL' : 'bow-corrected, from the track',
    }),
  );
  const late = shownLateS(st);
  out.push(field('Seconds late', late != null && !over ? `${f1(late)} s` : MISSING, over ? { note: 'over at the gun' } : {}));
  out.push(field('Start place', st.startPlace != null ? ordinal(st.startPlace) : MISSING, { note: st.startPlace != null ? 'by distance to the line, clean starters' : over ? 'over at the gun' : st.awayFromLine ? 'away from the line' : 'not ranked' }));
  const bias = biasAngle(lineBias(a.line, a.wind.twdAtGunDeg));
  out.push(
    field('Line bias', a.line.favored === 'square' ? 'square' : `${a.line.favored === 'left' ? 'pin' : 'boat'} end ${f0(bias)}° · ~${f0(a.line.favoredByM)} m`, {
      note: 'against the estimated wind at the gun',
      warn: bias >= D16_MIN_DEG,
    }),
  );
  out.push(field('Line position', Number.isFinite(st.linePosPct) ? `${f0(st.linePosPct)}% · ${lineThird(st.linePosPct)}` : MISSING, { note: '0% pin … 100% RC' }));
  out.push(field('Speed at gun', `${f1(st.speedKn)} kn`));
  // The crossing order: the Coach's (the bow's crossing; an over-early boat's when it cleared).
  const ctx = m ? coachCtx(a, m, b.id) : null;
  const so = ctx ? startOrder(ctx) : null;
  const crossMs = m?.crossMs?.[b.id] ?? null;
  const rank = so ? so.order.findIndex((c) => c.id === b.id) + 1 : 0;
  const front = so?.front.some((c) => c.id === b.id) ?? false;
  if (m === undefined) out.push(field('Over the line', MISSING, { note: 'working out the crossings…' }));
  else if (!m?.crossMs) out.push(field('Over the line', MISSING, { note: 'crossings not worked out' }));
  else if (crossMs == null || !rank) out.push(field('Over the line', MISSING, { note: over ? 'never seen to clear' : 'no crossing found' }));
  else {
    const t = (crossMs - gun) / 1000;
    out.push(field('Over the line', `${ordinal(rank)} of ${so!.order.length}${front ? ' · front row' : ''}`, { note: `crossed ${t < 0 ? '−' : '+'}${f0(Math.abs(t))} s` }));
  }
  if (over) {
    const back = m?.overStart?.get(b.id) ?? null;
    const cleared = crossMs ?? back?.clearedMs ?? null;
    out.push(
      field('Over early (OCS)', cleared != null ? `cleared +${f0((cleared - gun) / 1000)} s` : 'not seen to clear', {
        warn: true,
        note: `${st.ocs ? 'flagged OCS by the feed' : 'over by Recall’s check'}${back?.wentBackMs != null ? `; went back +${f0((back.wentBackMs - gun) / 1000)} s` : ''}`,
      }),
    );
  } else out.push(field('Over early (OCS)', 'no'));
  return out;
}

const cardLine = (c: Card, i: number, a: RaceAnalysis): ReportLine => ({ text: cardText(c, a.meta.tzOffsetMs).title, seconds: secondsChip(c), kind: 'card', n: i + 1 });
const plusLine = (n: GoodNote): ReportLine => ({ text: wentText(n), seconds: `+${Math.round(n.seconds ?? 0)} s`, kind: 'plus' });

function startVerdict(a: RaceAnalysis, deb: CoachDebrief | null, model: CoachModel | null | undefined): ReportLine {
  if (model === undefined) return { text: 'Working out the start…', kind: 'note' };
  if (!deb) return { text: MISSING, kind: 'note' };
  // The start card: D1 (with the D3 after it merged in), else D3 alone (the first minutes after the crossing).
  const i = deb.cards.findIndex((c) => c.kind === 'D1');
  if (i >= 0) return cardLine(deb.cards[i], i, a);
  const j = deb.cards.findIndex((c) => c.kind === 'D3');
  if (j >= 0) return cardLine(deb.cards[j], j, a);
  // The line bias (D16): started away from the favoured end of a biased line.
  const k = deb.cards.findIndex((c) => c.kind === 'D16');
  if (k >= 0) return cardLine(deb.cards[k], k, a);
  const ok = deb.ok.find((n) => n.detector === 'D1');
  if (ok) return ok.thin ? { text: thinText(ok), kind: 'note' } : { text: `✓ Front row: ${goodTexts(ok)[0]}`, kind: 'ok' };
  const plus = deb.plus.find((n) => n.detector === 'D1' || n.detector === 'D16');
  if (plus) return plusLine(plus);
  return { text: 'No start finding', kind: 'note' };
}

/**
 * "5 tacks", "3 gybes", "2 tacks · 1 gybe" as the legs table counts them (tacks on beats, gybes on runs, both on reaches);
 * with D17's measured cost against the group's when there is one: "6 tacks · ~14 m each (fleet ~8)", "(group ~8)".
 */
function manoeuvres(kind: LegKind, tacks: number, gybes: number, cost: LegCost | null = null, ref = 'fleet'): string {
  const t = `${tacks} ${tacks === 1 ? 'tack' : 'tacks'}`;
  const g = `${gybes} ${gybes === 1 ? 'gybe' : 'gybes'}`;
  const each = cost ? ` · ~${f0(Math.max(0, cost.medM))} m each (${ref} ~${f0(Math.max(0, cost.fMedM))})` : '';
  return kind === 'upwind' ? `${t}${each}` : kind === 'downwind' ? `${g}${each}` : `${t} · ${g}`;
}

function legRows(a: RaceAnalysis, b: BoatResult, stories: LegStory[], g: Group, model: CoachModel | null | undefined): ReportLeg[] {
  const group = g.kind === 'fleet' ? a.boats.filter((x) => x.id !== b.id).map((x) => x.id) : groupIds(a.boats, b.id, g);
  const byId = new Map(a.boats.map((x) => [x.id, x]));
  // D17's reference is the group too, like the SOG / VMG medians (none under D17_MIN_REF_BOATS measured: Top 3 never).
  const refIds = new Set(group);
  const groupMed = (k: number, f: (l: NonNullable<BoatResult['legs'][number]>) => number): number | null => {
    const xs = group.map((id) => byId.get(id)?.legs[k]).filter((l): l is NonNullable<typeof l> => l != null).map(f).filter(Number.isFinite);
    return xs.length ? median(xs) : null;
  };
  return a.legs.map((leg, k) => {
    const l = b.legs[k] ?? null;
    const s = stories.find((x) => x.leg === k) ?? null;
    const me = s?.mine ?? null;
    const vs = s ? groupSecondsChip(s, g) : null;
    const side = s?.side;
    const sideText = side
      ? [side.mineM != null ? `${f0(Math.abs(side.mineM))} m ${side.mineM >= 0 ? 'right' : 'left'}` : '', side.verdict === 'none' ? 'no side paid' : `${side.verdict === 'left' ? 'Left' : 'Right'} paid`].filter(Boolean).join(' · ')
      : '';
    const pair = (mine: number | null | undefined, theirs: number | null): string => (mine == null || !Number.isFinite(mine) ? MISSING : `${f1(mine)} / ${f1(theirs)}`);
    return {
      leg: k,
      name: leg.name,
      type: LEG_KIND[leg.kind],
      places: me ? `${ordinal(me.from)} → ${ordinal(me.to)}` : s?.endPlace ? `${MISSING} → ${ordinal(s.endPlace.to)}` : MISSING,
      change: me ? `${placesWord(me.gain)} · of ${s!.placeOf}` : MISSING,
      time: l ? duration(l.timeS) : MISSING,
      vsGroup: s?.vsGroup && vs ? signedS(s.vsGroup.deltaS) : MISSING,
      sog: pair(l?.sogKn, groupMed(k, (x) => x.sogKn)),
      vmg: pair(l?.vmgKn, groupMed(k, (x) => x.vmgKn)),
      manoeuvres: l ? manoeuvres(leg.kind, l.tacks, l.gybes, model ? legCost({ a, m: model, boat: b.id }, k, refIds) : null, g.kind === 'fleet' ? 'fleet' : 'group') : MISSING,
      side: sideText || MISSING,
      gate: s?.gate?.side ? gateChip(s.gate.side) : MISSING,
    };
  });
}

/** D9 / D13: the ranked cards (with their Coach number), Went well and ✓, the gate buoy per leg, and what could be timed. */
function roundingLines(a: RaceAnalysis, deb: CoachDebrief | null, stories: LegStory[]): ReportLine[] {
  if (!deb) return [];
  const out: ReportLine[] = [];
  deb.cards.forEach((c, i) => {
    if (c.kind === 'D9' || c.kind === 'D13') out.push(cardLine(c, i, a));
  });
  for (const n of deb.plus) if (n.detector === 'D9' || n.detector === 'D13') out.push(plusLine(n));
  for (const n of deb.ok) if (n.detector === 'D9' || n.detector === 'D13') out.push({ text: `✓ ${goodTexts(n)[0]}`, kind: 'ok' });
  for (const s of stories) {
    if (s.gate) out.push({ text: `${s.name} → gate: ${s.gate.side ? `rounded the ${s.gate.side} buoy (${gateChip(s.gate.side)}, looking upwind)` : 'buoy not known'}; fleet ${s.gate.left} left · ${s.gate.right} right`, kind: 'note' });
  }
  const timed = deb.quality.D9;
  out.push({
    text: timed.length ? `Rounding zone timed (D9) at: ${timed.join(', ')} marks` : 'Rounding zones not timed (D9 needs a fix every 2 s near the mark); places through the roundings used where readable',
    kind: timed.length ? 'note' : 'warn',
  });
  if (deb.quality.D13 != null) out.push({ text: deb.quality.D13 ? 'Gate choice judged (D13): both gate buoys tracked' : 'Gate choice not judged (D13): no two-buoy leeward gate tracked', kind: 'note' });
  return out;
}

/** The official code (D12's penalty card) and the penalty turns on the track. */
function penaltyLines(a: RaceAnalysis, b: BoatResult, deb: CoachDebrief | null, model: CoachModel | null | undefined): ReportLine[] {
  const out: ReportLine[] = [];
  const tz = a.meta.tzOffsetMs;
  if (b.finishCode) {
    const c = codeInfo(b.finishCode);
    out.push({ text: `${codeShort(b)}: ${c.meaning}${deb?.penalty ? ` — ${penaltyText(deb.penalty, a).title}` : ''}`, kind: 'warn' });
  } else if (a.meta.results?.places === 'official') out.push({ text: 'No official penalty', kind: 'ok' });
  else out.push({ text: 'No official results linked: penalty codes unknown', kind: 'note' });
  if (model === undefined) {
    out.push({ text: 'Checking the track for penalty turns…', kind: 'note' });
    return out;
  }
  const turns = model?.turns;
  if (!turns) out.push({ text: 'Penalty turns not checked', kind: 'note' });
  else {
    const mine = turns.get(b.id) ?? [];
    if (!mine.length) out.push({ text: 'No penalty turns found on the track', kind: 'ok' });
    for (const t of mine) out.push({ text: `Penalty turn ${turnChip(t, a.meta.gunMs, tz)}`, kind: 'warn', ...(t.lostS != null ? { seconds: `≈ ${Math.round(t.lostS)} s` } : {}) });
  }
  const i = deb?.cards.findIndex((c) => c.kind === 'D12') ?? -1;
  if (deb && i >= 0) out.push(cardLine(deb.cards[i], i, a));
  return out;
}

function coachSection(a: RaceAnalysis, deb: CoachDebrief | null, model: CoachModel | null | undefined): ReportCoach {
  const none: ReportCoach = { penalty: null, rankedHead: null, findings: [], totalS: null, went: [], ok: [], notJudged: [], workOn: [], empty: null };
  if (model === undefined) return { ...none, empty: 'Working out the wind and the Coach findings…' };
  if (!model || !deb) return { ...none, empty: 'No course to measure against in this race: no Coach findings.' };
  const pen = deb.penalty ? penaltyText(deb.penalty, a) : null;
  const penalty = pen ? { code: pen.code, title: pen.title, chips: pen.chips, sentence: pen.sentence } : null;
  if (deb.noData) return { ...none, penalty, empty: 'No debrief for this race.' };
  const tz = a.meta.tzOffsetMs;
  const findings = deb.cards.map((c, i) => {
    const t = cardText(c, tz);
    return { n: i + 1, title: t.title, seconds: secondsChip(c), sentence: t.sentence, confidence: c.confidence, warnings: cardWarnings(c), kind: c.kind };
  });
  const tips: string[] = [];
  for (const c of deb.cards) {
    const tip = cardText(c, tz).tip;
    if (tip && !tips.includes(tip)) tips.push(tip);
  }
  return {
    penalty,
    rankedHead: deb.penalty ? rankedHead(deb.penalty) : null,
    findings,
    totalS: deb.totalS,
    went: deb.plus.map((n) => ({ text: wentText(n), seconds: `+${Math.round(n.seconds ?? 0)} s` })),
    ok: deb.ok.filter((n) => !n.thin).flatMap(goodTexts),
    notJudged: deb.ok.filter((n) => n.thin).map(thinWhat),
    workOn: tips.slice(0, 3),
    empty: findings.length ? null : 'No clear gains with this data.',
  };
}

function notesOf(a: RaceAnalysis, b: BoatResult, deb: CoachDebrief | null): string[] {
  const out: string[] = [];
  const cov = b.coverage ?? deb?.raceCov ?? null;
  if (cov == null) out.push('No timed legs for this boat: leg figures are —.');
  const r = a.meta.results;
  out.push(
    r?.places === 'official'
      ? 'Places: official results.'
      : r?.places === 'racesense'
        ? 'Places: RaceSense’s finish order (no official results linked).'
        : r?.places === 'tracker'
          ? 'Places: the tracks’ finish-line crossings (~).'
          : 'Places: the tracked finish order (no official results linked).',
  );
  for (const n of a.notes) if (n.kind === 'legs-fleet' || n.kind === 'marks-est' || n.kind === 'wind-assumed' || n.kind === 'marks-moved' || n.kind === 'shortened') out.push(n.text);
  if (b.headingSource === 'cog') out.push('This boat’s compass disagrees with its track: angles use its course over ground.');
  return out;
}

function regattaSection(s: RegattaSummary): ReportRegatta {
  return {
    rows: s.rows.map((r) => {
      const f = r.digest?.finish ?? null;
      const done = r.status === 'done';
      const atStake = (r.digest?.findings ?? []).reduce((x, y) => x + y.seconds, 0);
      return {
        label: r.label,
        place: done ? finishShort(f) : MISSING,
        of: done && f ? String(f.of) : MISSING,
        onWater: done && f?.place == null && f?.onWater != null ? ordinal(f.onWater) : MISSING,
        findings: done && r.digest && !r.digest.noData ? `${r.digest.findings.length} · ≈ ${Math.round(atStake)} s` : MISSING,
        status: r.status === 'done' ? (r.digest?.tracked ? '' : 'no track') : r.status === 'error' ? `couldn't load` : 'not analyzed yet',
      };
    }),
    done: s.done,
    total: s.total,
    settled: s.rows.every((r) => r.status === 'done' || r.status === 'error'),
    penalties: s.penalties.map(penaltyRowText),
    workOn: s.top.map((t) => ({ title: t.title, why: t.why, tip: t.tip, score: t.score >= 1 ? `~${Math.round(t.score)} s` : '' })),
    went: s.went.map((w) => ({ text: regattaWentText(w), seconds: `+${Math.round(w.totalS)} s` })),
    legs: s.legs.map((l) => ({ type: LEG_TYPE[l.kind], text: `${l.legs} legs · ${secs(l.meanS)} per leg vs the fleet median` })),
  };
}

const emptyCoach: ReportCoach = { penalty: null, rankedHead: null, findings: [], totalS: null, went: [], ok: [], notJudged: [], workOn: [], empty: null };

/** The report's model for the selected boat in the race (lazy: built only when the report is open). */
export function buildReport(inp: ReportInput): ReportModel {
  const { a, group, model } = inp;
  const race = inp.raceName ?? `Race ${a.meta.raceNumber}`;
  const base = {
    scope: inp.scope ?? 'race',
    event: a.meta.eventName,
    division: a.meta.division,
    race,
    groupLabel: GROUP_LABEL[group.kind],
    regatta: inp.regatta ? regattaSection(inp.regatta) : null,
  } as const;
  const b = inp.boat ? a.boats.find((x) => x.id === inp.boat) : undefined;
  if (!b) {
    return {
      ...base,
      state: 'no-boat',
      sail: '',
      boatName: '',
      boatId: null,
      header: [],
      start: [],
      startVerdict: { text: MISSING, kind: 'note' },
      legs: [],
      roundings: [],
      penalties: [],
      coach: emptyCoach,
      regatta: null,
      notes: [],
    };
  }
  const deb = model ? (inp.deb !== undefined ? inp.deb : coachDebrief(a, model, b.id)) : null;
  const stories = model ? legStories(a, model, b.id, group) : [];
  // The regatta version is ready once every race of the Race menu has been analysed; the race report once the Coach model is in.
  const pending = inp.settling || (base.scope === 'regatta' ? !inp.regatta || !inp.regatta.rows.every((r) => r.status === 'done' || r.status === 'error') : model === undefined);
  return {
    ...base,
    state: pending ? 'pending' : 'ready',
    sail: b.sail,
    boatName: b.name && b.name !== `#${b.sail}` ? b.name : '',
    boatId: b.id,
    header: headerFields(a, b, inp.official),
    start: startFields(a, model, b),
    startVerdict: startVerdict(a, deb, model),
    legs: legRows(a, b, stories, group, model),
    roundings: model === undefined ? [{ text: 'Working out the roundings…', kind: 'note' }] : model ? roundingLines(a, deb, stories) : [{ text: 'No course: roundings not measured', kind: 'note' }],
    penalties: penaltyLines(a, b, deb, model),
    coach: coachSection(a, deb, model),
    notes: [...(inp.settling ? ['Checking for official results: the places may still change.'] : []), ...notesOf(a, b, deb)],
  };
}
