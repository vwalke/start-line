/**
 * The two metrics tables, with best/worst highlights per column (▲ best, ▼ worst — never colour alone).
 * Start: how each boat started (and its heel at the gun). Legs: each leg's VMG / SOG / TWA / Heel / Dist / Time / tacks or gybes / Data,
 * (Heel columns only when the feed carries roll),
 * the upwind and downwind legs added up, and the race. Every column sorts from its header (↑/↓); the
 * tables sort independently, and their column keys are unique across both. Once sorted, a sticky Rank
 * column (leftmost) gives each boat's place in that sort.
 */
import { finishRank } from '../analysis/result';
import { codeShort, codeWords } from './resultText';
import type { BoatResult, KindSummary, LegKind, LegResult, RaceAnalysis, StartResult } from '../analysis/types';
import { OCS_BLIND_NOTE, shownLateS, startNotes } from '../analysis/validity';
import { boatColor, pickedExcluded } from './charts';
import { duration, esc, f0, f1, f2, fM, localTime, ordinal, pct, twaLabel } from './format';
import { capHtml, infoHtml, warnChip, type Chip, type KeyLine } from './info';
import { windChip } from './startLine';
import { gateSides } from '../analysis/coach/gateSides';
import { gateChip } from './coachLegs';

export type SortDir = 'asc' | 'desc';
/** Which column the rows are sorted by (null = finish order, as analysed). */
export interface SortState {
  key: string;
  dir: SortDir;
}
export type SortVal = number | string | null | undefined;
export type TableId = 'start' | 'legs';

interface Col {
  /** Stable id for sorting, unique across both tables, e.g. "fin", "L2.sog", "up.vmg". */
  key: string;
  head: string;
  title?: string;
  /** Columns sharing a group sit under one spanning header (a leg, upwind, the race). */
  group?: { id: string; label: string; title?: string };
  /** Value used for best/worst; null = not ranked. */
  rank?: (b: BoatResult) => number | null | undefined;
  better?: 'low' | 'high';
  /** Value the rows sort by; missing values always sort last. */
  sort: (b: BoatResult) => SortVal;
  /** First-click direction: the "better" end first. */
  first: SortDir;
  cell: (b: BoatResult) => string;
  cls?: string;
  /** The finish-place and boat columns: a not-racing row shows "—" and its flag there. */
  role?: 'fin' | 'boat';
  /** Display rounding for rank ties, matching the cell (0 / 1 / 2 decimals, or '%' as pct()). */
  prec?: 0 | 1 | 2 | '%';
}

const missing = (v: SortVal): boolean => v == null || (typeof v === 'number' && !Number.isFinite(v));

/** Compare two sort values in `dir`; missing values go last in both directions. */
export function compareValues(x: SortVal, y: SortVal, dir: SortDir): number {
  const mx = missing(x);
  const my = missing(y);
  if (mx || my) return mx === my ? 0 : mx ? 1 : -1;
  const c =
    typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
  return dir === 'asc' ? c : -c;
}

/** Boats ordered by `value` in `dir`; ties keep finish order (DNF last), then sail order. */
export function sortBoats(boats: BoatResult[], value: (b: BoatResult) => SortVal, dir: SortDir): BoatResult[] {
  return [...boats].sort(
    (a, b) => compareValues(value(a), value(b), dir) || (finishRank(a) ?? 1e9) - (finishRank(b) ?? 1e9) || a.colorSlot - b.colorSlot,
  );
}

/** The sort after clicking column `key`: its natural direction first, then reversed. */
export function nextSort(cur: SortState | null, key: string, first: SortDir): SortState {
  if (cur?.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: first };
}

/** A boat's place in a sort: 1 at the top; `tied` when another boat shares its value. */
export interface SortRank {
  n: number;
  tied: boolean;
}

/** The figure a cell shows: same rounding as f0 / f1 / f2 / pct, so 3.961 and 3.964 (both "3.96") match. */
export function shownVal(v: SortVal, prec?: 0 | 1 | 2 | '%'): SortVal {
  if (prec == null || typeof v !== 'number' || !Number.isFinite(v)) return v;
  if (prec === '%') return Math.floor(v * 100 + 1e-9);
  return prec === 0 ? Math.round(v) : Number(v.toFixed(prec));
}

/** Each boat's place in `boats` sorted by `value` in `dir`, ties shared (1, =2, =2, 4); null = missing value, not ranked. `shown` is the displayed figure (raw `value` if omitted). */
export function sortRanks(
  boats: BoatResult[],
  value: (b: BoatResult) => SortVal,
  dir: SortDir,
  shown: (v: SortVal) => SortVal = (v) => v,
): Map<string, SortRank | null> {
  const out = new Map<string, SortRank | null>();
  let prev: { v: SortVal; r: SortRank } | null = null;
  sortBoats(boats, value, dir).forEach((b, i) => {
    const v = shown(value(b));
    if (missing(v)) {
      out.set(b.id, null);
    } else if (prev && compareValues(prev.v, v, dir) === 0) {
      prev.r.tied = true;
      out.set(b.id, prev.r);
    } else {
      prev = { v, r: { n: i + 1, tied: false } };
      out.set(b.id, prev.r);
    }
  });
  return out;
}

/** "3", "=3" when tied, "—" when not ranked. */
export const rankCell = (r: SortRank | null | undefined): string =>
  r == null ? '—' : r.tied ? `<span title="Tied ${ordinal(r.n)}">=${r.n}</span>` : String(r.n);

const findCol = (a: RaceAnalysis, key: string): Col | undefined => startColumns(a).find((c) => c.key === key) ?? legColumns(a).find((c) => c.key === key);

/** Which of this race's tables has column `key` (null: neither; a saved sort may name a leg another race lacks). */
export function sortTable(a: RaceAnalysis, key: string): TableId | null {
  if (startColumns(a).some((c) => c.key === key)) return 'start';
  return legColumns(a).some((c) => c.key === key) ? 'legs' : null;
}

/** Whether either of this race's tables has a column `key`. */
export const hasSortKey = (a: RaceAnalysis, key: string): boolean => sortTable(a, key) != null;

/** `nextSort` for a column of this race's tables (unknown keys leave the sort as it is). */
export function toggleSort(a: RaceAnalysis, cur: SortState | null, key: string): SortState | null {
  const col = findCol(a, key);
  return col ? nextSort(cur, key, col.first) : cur;
}

const START_TITLE =
  'Place among clean starters by distance to the line: V = ranked by the Vakaros device figure, ours = by our GPS track check (no usable Vakaros fix). over = OCS or bow over the line; — = no reliable figure.';

// Caveat markers carry a title for hover; the same text is listed under the table for touch screens.
function startCell(b: BoatResult): string {
  const s = b.start;
  if (!s) return '—';
  if (s.over) return '<span class="rk-over">over</span>';
  if (s.startPlace == null) return '—';
  const src = s.rank!.source === 'vakaros' ? ['V', 'Vakaros device'] : ['ours', 'our track check'];
  return `${s.startPlace} <small class="rk-src" title="${src[1]}">${src[0]}</small>`;
}

function rcCell(b: BoatResult): string {
  const s = b.start;
  if (!s) return '—';
  if (s.rcDtlM == null) return s.rcNote ? `<span class="na" title="${esc(s.rcNote)}" aria-label="${esc(s.rcNote)}">—</span>` : '—';
  return `${s.warn ? `<span class="warn" title="${esc(s.warn)}" aria-label="disagrees with our check">⚠</span>` : ''}${f1(s.rcDtlM)}`;
}

function oursCell(b: BoatResult): string {
  const s = b.start;
  if (!s) return '—';
  return f1(s.dtlM);
}

/** The progress ratio as "92%"; — with none. */
export function progressCell(l: LegResult | null | undefined): string {
  if (!l || l.progress == null || !Number.isFinite(l.progress)) return '—';
  return pct(l.progress);
}

/** A tack or gybe count. */
const countCell = (n: number | null | undefined): string => (n == null ? '—' : String(n));

const HEEL_TITLE = 'average leeward heel, time-weighted; excludes maneuvers (± 5 s of each tack or gybe). Negative = heeled to windward';

/** Mean leeward heel "15.3°". */
export function heelCell(heelDeg: number | null | undefined): string {
  if (heelDeg == null || !Number.isFinite(heelDeg)) return '—';
  return `<span class="heel">${f1(heelDeg)}°</span>`;
}

const SORT_NOTE = 'Tap a heading to sort (↑/↓), again to reverse. ▲ best, ▼ worst.';
const RANK_NOTE = 'Rank: place in the current sort; =3 tied at the shown figure; — none.';

/** The ⓘ line on Heel: what it is (at the gun, or averaged per leg), or that this feed has none (the columns are hidden). */
export const heelNote = (a: RaceAnalysis, which: TableId): string =>
  !a.hasHeel
    ? 'Heel: not in this feed, so the heel columns are hidden.'
    : which === 'start'
      ? 'Heel: leeward heel (+) at the gun, from the fix within 2 s.'
      : 'Heel: leeward heel (+), time-weighted, turns left out.';

const tag = (b: BoatResult): string => `#${b.sail}${b.name !== `#${b.sail}` ? ` ${b.name}` : ''}`;

/** ⚠ when a boat's heading comes from its GPS course (its compass is far off it), naming the boats in the title; null when none. */
export function headingChip(a: RaceAnalysis): Chip | null {
  const cog = a.boats.filter((b) => b.headingSource === 'cog');
  if (!cog.length) return null;
  const who = cog.map((b) => `${tag(b)}${b.headingOffDeg != null ? ` (${Math.round(b.headingOffDeg)}° off)` : ''}`).join(', ');
  return warnChip(
    cog.length > 1 ? `${cog.length} headings from GPS course` : `#${cog[0].sail} heading from GPS course`,
    `Device heading far off the GPS course, so TWA and heading use course over ground: ${who}`,
  );
}

/** The start table's key line: ⚠ disagreements and unchecked OCS, — when present; column definitions and each boat's caveats in the ⓘ. */
export function startTableKey(a: RaceAnalysis): KeyLine & { notes: string[] } {
  const starts = a.boats.flatMap((b) => (b.start ? [b.start] : []));
  const count = (f: (s: StartResult) => unknown): number => starts.filter(f).length;
  const chips: Chip[] = [];
  const warn = count((s) => s.warn);
  const blind = count((s) => s.ocsBlind);
  const noFix = count((s) => s.rcDtlM == null && s.rcNote);
  // The race-wide warning (with Race Analysis, on the Race tab) belongs by the DTL columns too.
  const fleetOff = a.notes.find((n) => n.kind === 'dtl-off');
  if (fleetOff) chips.push(warnChip('Vakaros DTL off vs GPS', fleetOff.text));
  if (warn) chips.push(warnChip(`${warn} Vakaros ≠ ours`, 'Vakaros and our check disagree by more than 3 m'));
  if (blind) chips.push(warnChip(`${blind} OCS unchecked`, OCS_BLIND_NOTE));
  if (noFix) chips.push({ text: `— ${noFix} no Vakaros fix` });
  const hdg = headingChip(a);
  if (hdg) chips.push(hdg);
  const notes = a.boats
    .filter((b) => b.start && (startNotes(b.start).length || b.headingSource === 'cog'))
    .map((b) => {
      const ns = startNotes(b.start!).map((n) => n.replace(/\.$/, ''));
      if (b.headingSource === 'cog') ns.push('heading and TWA from the GPS course (device heading far off it)');
      return `${tag(b)} — ${ns.join('; ')}.`;
    });
  return {
    chips,
    bullets: [
      'Start: place among clean starters (V = Vakaros, ours = our check).',
      'DTL (Vakaros): the device figure, bow-corrected; the primary number.',
      'Check: our GPS estimate; ⚠ = disagrees.',
      'Late: our DTL ÷ speed to the line. Line pos: 0% pin, 100% RC.',
      heelNote(a, 'start'),
      SORT_NOTE,
      RANK_NOTE,
    ],
    notes,
  };
}

/** The legs table's key line: TWA/VMG are estimates (⚠ when the wind is low confidence), and partial when present. */
export function legsTableKey(a?: RaceAnalysis): KeyLine {
  const chips: Chip[] = [];
  if (a) {
    const wind = windChip(a);
    chips.push(wind.warn ? { ...wind, text: `TWA/VMG: ${wind.text}` } : { text: 'TWA/VMG est.', title: wind.title });
    const sums = a.boats.flatMap((b) => [b.upwind, b.downwind]).filter((s): s is KindSummary => s != null);
    const hdg = headingChip(a);
    if (hdg) chips.push(hdg);
    if (sums.some((s) => !s.complete)) chips.push({ text: 'partial = not every leg timed' });
  }
  return {
    chips,
    bullets: [
      "TWA / VMG: estimates vs the wind from the fleet's tacks; TWA = steady median.",
      'Dist: meters sailed; Prog: straight line ÷ Dist. Time: leg, place at mark.',
      'Upwind / Downwind: beats or runs summed; partial = not every leg timed, no place.',
      'Tacks on beats, gybes on runs (both on reaches); a side held 10 s.',
      ...(a ? [heelNote(a, 'legs')] : []),
      SORT_NOTE,
      RANK_NOTE,
    ],
  };
}

/** The start table's key line and ⓘ (column definitions, then each boat's start caveats so they're readable without hover). */
export function startNotesHtml(a: RaceAnalysis, open = false): string {
  const k = startTableKey(a);
  return capHtml(k.chips, infoHtml(k.bullets, { open, more: { title: 'Per boat', items: k.notes } }));
}

/** The legs table's key line and ⓘ. */
export function legsNotesHtml(a?: RaceAnalysis, open = false): string {
  const k = legsTableKey(a);
  return capHtml(k.chips, infoHtml(k.bullets, { open }));
}

function finCol(key: string, sticky = 'sticky0'): Col {
  return {
    key,
    head: 'Fin',
    title: 'Finish position (DNF = no finish; an official code with its points, sorted at its place on the water)',
    sort: (b) => finishRank(b),
    first: 'asc',
    cell: (b) => (b.finishPos != null ? String(b.finishPos) : b.finishCode ? `<span title="${esc(codeWords(b))}">${esc(codeShort(b)!)}</span>` : 'DNF'),
    cls: `num ${sticky}`,
    role: 'fin',
  };
}

function boatCol(a: RaceAnalysis, key: string): Col {
  return {
    key,
    head: 'Boat',
    title: 'Sail number',
    sort: (b) => b.sail,
    first: 'asc',
    cls: 'boat sticky1',
    role: 'boat',
    cell: (b) =>
      `<i class="sw" style="background:${boatColor(b, a.boats.length)}"></i>#${esc(b.sail)}${
        b.name !== `#${b.sail}` ? ` <span class="bname">${esc(b.name)}</span>` : ''
      }${b.start?.ocs ? ' <span class="flag" title="Flagged OCS by race control">OCS</span>' : ''}`,
  };
}

function startPlaceCol(key: string): Col {
  return {
    key,
    head: 'Start<br><small>place</small>',
    title: START_TITLE,
    rank: (b) => (b.start?.startPlace != null ? b.start.rank!.m : null),
    better: 'low',
    sort: (b) => b.start?.startPlace,
    first: 'asc',
    cell: startCell,
  };
}

/** The start table: place, DTL (Vakaros and ours), late, line position, speed and TWA at the gun. */
function startColumns(a: RaceAnalysis): Col[] {
  const hasVakaros = a.boats.some((b) => b.start && b.start.rcStatus !== 'none');
  const dtlCols: Col[] = hasVakaros
    ? [
        {
          key: 'rc',
          head: 'DTL<br><small>Vakaros m</small>',
          title:
            "Distance to line from the boat's Vakaros device (feed dtlMm, bow-corrected; device start-fix timing). Primary figure. — = no usable fix; ⚠ = differs from our check by more than 3 m.",
          sort: (b) => b.start?.rcDtlM,
          first: 'asc',
          prec: 1 as const,
          cell: rcCell,
        },
        {
          key: 'ours',
          head: 'Check<br><small>ours m</small>',
          title:
            "Our independent estimate from the GPS track (bow offset along heading, sampled at the device's start fix). A check on the Vakaros figure, not the official number.",
          sort: (b) => b.start?.dtlM,
          first: 'asc',
          prec: 1 as const,
          cell: oursCell,
          cls: 'num muted',
        },
      ]
    : [
        {
          key: 'ours',
          head: 'DTL<br><small>@gun m</small>',
          title: 'Bow distance behind the line at the gun (bow-corrected). Negative = over.',
          sort: (b) => b.start?.dtlM,
          first: 'asc',
          prec: 1 as const,
          cell: oursCell,
        },
      ];
  return [
    finCol('s.fin'),
    boatCol(a, 's.boat'),
    startPlaceCol('start'),
    ...dtlCols,
    {
      key: 'late',
      head: 'Late<br><small>s</small>',
      title: 'Our DTL ÷ speed toward the line at the gun',
      rank: (b) => (b.start?.startPlace != null ? b.start.lateS : null),
      better: 'low',
      sort: (b) => (b.start ? shownLateS(b.start) : null),
      first: 'asc',
      prec: 1 as const,
      cell: (b) => f1(b.start ? shownLateS(b.start) : null),
    },
    {
      key: 'line',
      head: 'Line<br><small>pos %</small>',
      title: '0% = pin (left) end, 100% = RC (right) end',
      sort: (b) => b.start?.linePosPct,
      first: 'asc',
      prec: 0 as const,
      cell: (b) => f0(b.start?.linePosPct),
      cls: 'num muted',
    },
    {
      key: 'speed',
      head: 'Speed<br><small>@gun kn</small>',
      rank: (b) => b.start?.speedKn,
      better: 'high',
      sort: (b) => b.start?.speedKn,
      first: 'desc',
      prec: 1 as const,
      cell: (b) => f1(b.start?.speedKn),
    },
    {
      key: 'twa',
      head: 'TWA<br><small>@gun est.</small>',
      title: 'S = starboard, P = port; vs the estimated wind. Sorts by angle off the wind, closest first.',
      sort: (b) => (b.start ? Math.abs(b.start.twaDeg) : null),
      first: 'asc',
      prec: 0 as const,
      cell: (b) => twaLabel(b.start?.twaDeg),
      cls: 'num muted',
    },
    ...(a.hasHeel
      ? [
          {
            key: 's.heel',
            head: 'Heel<br><small>@gun °</small>',
            title: 'Leeward heel at the gun (the fix nearest the gun, within 2 s): + = heeled to leeward, − = to windward. — = none, or head to wind',
            sort: (b: BoatResult) => b.start?.heelAtGunDeg,
            first: 'desc' as const,
            prec: 0 as const,
            cell: (b: BoatResult) => (b.start?.heelAtGunDeg != null ? `<span class="heel">${f0(b.start.heelAtGunDeg)}°</span>` : '—'),
            cls: 'num muted',
          },
        ]
      : []),
  ];
}

/** Tacks on beats, gybes on runs, both on reaches. */
const showsTacks = (kind: LegKind): boolean => kind !== 'downwind';
const showsGybes = (kind: LegKind): boolean => kind !== 'upwind';

const KIND_LABEL = { upwind: 'Upwind', downwind: 'Downwind' } as const;

/** An upwind / downwind summary's columns, as a leg's; a partial summary is marked and never ▲/▼ or placed. */
function summaryCols(kind: 'upwind' | 'downwind', hasHeel: boolean): Col[] {
  const id = kind === 'upwind' ? 'up' : 'dn';
  const label = KIND_LABEL[kind];
  const group = { id, label, title: `Every ${kind === 'upwind' ? 'beat' : 'run'} added up (reaches excluded)` };
  const S = (b: BoatResult): KindSummary | null => b[kind];
  const full = (b: BoatResult): KindSummary | null => (S(b)?.complete ? S(b) : null);
  const partial = (s: KindSummary, body: string): string =>
    s.complete ? body : `<span class="partial" title="${esc(`Partial: ${s.legs} of ${s.of} ${kind} legs`)}">${body}</span>`;
  const val = (f: (s: KindSummary) => string) => (b: BoatResult): string => (S(b) ? partial(S(b)!, f(S(b)!)) : '—');
  const cols: Col[] = [
    {
      key: `${id}.vmg`,
      head: 'VMG<br><small>kn</small>',
      title: `${label}: distance made good along the wind ÷ time, over every ${kind} leg (time-weighted)`,
      group,
      rank: (b) => full(b)?.vmgKn,
      better: 'high',
      sort: (b) => S(b)?.vmgKn,
      first: 'desc',
      prec: 2 as const,
      cls: 'num leg',
      cell: val((s) => `<b>${f2(s.vmgKn)}</b>`),
    },
    {
      key: `${id}.sog`,
      head: 'SOG<br><small>kn</small>',
      title: `${label}: distance sailed ÷ time`,
      group,
      sort: (b) => S(b)?.sogKn,
      first: 'desc',
      prec: 1 as const,
      cell: val((s) => f1(s.sogKn)),
    },
    {
      key: `${id}.twa`,
      head: 'TWA<br><small>est. °</small>',
      title: `${label}: |TWA| weighted by leg time`,
      group,
      sort: (b) => S(b)?.twaDeg,
      first: kind === 'downwind' ? 'desc' : 'asc',
      prec: 0 as const,
      cell: val((s) => `${f0(s.twaDeg)}°`),
      cls: 'num muted',
    },
    ...(hasHeel
      ? [
          {
            key: `${id}.heel`,
            head: 'Heel<br><small>°</small>',
            title: `${label}: ${HEEL_TITLE}; over every ${kind} leg`,
            group,
            sort: (b: BoatResult) => S(b)?.heelDeg,
            first: 'desc' as const,
            prec: 1 as const,
            cell: val((s) => heelCell(s.heelDeg)),
          },
        ]
      : []),
    {
      key: `${id}.dist`,
      head: 'Dist<br><small>m</small>',
      title: `${label}: distance sailed, meters`,
      group,
      sort: (b) => S(b)?.distM,
      first: 'asc',
      prec: 0 as const,
      cell: val((s) => fM(s.distM)),
    },
    {
      key: `${id}.time`,
      head: 'Time<br><small>place</small>',
      title: `${label}: total time and place among boats that sailed every ${kind} leg`,
      group,
      rank: (b) => full(b)?.timeS,
      better: 'low',
      sort: (b) => S(b)?.timeS,
      first: 'asc',
      prec: 0 as const,
      cell: val((s) => `${duration(s.timeS)} <small class="rk">${s.place != null ? ordinal(s.place) : s.complete ? '' : `partial ${s.legs}/${s.of}`}</small>`),
    },
    kind === 'upwind'
      ? {
          key: `${id}.tacks`,
          head: 'Tacks',
          title: `${label}: tacks on every beat`,
          group,
          sort: (b) => S(b)?.tacks,
          first: 'asc',
          cell: val((s) => countCell(s.tacks)),
        }
      : {
          key: `${id}.gybes`,
          head: 'Gybes',
          title: `${label}: gybes on every run`,
          group,
          sort: (b) => S(b)?.gybes,
          first: 'asc',
          cell: val((s) => countCell(s.gybes)),
        },
  ];
  return cols;
}

/** Race totals of tacks / gybes over the boat's legs; null with none. */
function raceCount(b: BoatResult, f: (l: LegResult) => number): number | null {
  const ls = b.legs.filter((l): l is LegResult => l != null);
  return ls.length ? ls.reduce((s, l) => s + f(l), 0) : null;
}

/** The legs table: start place, each leg, upwind / downwind, the race. */
function legColumns(a: RaceAnalysis): Col[] {
  const cols: Col[] = [finCol('fin'), boatCol(a, 'boat'), startPlaceCol('lstart')];
  for (const leg of a.legs) {
    const i = leg.index;
    const group = { id: `L${i}`, label: leg.name, title: `${leg.name} to ${leg.to}` };
    const L = (b: BoatResult): LegResult | null => b.legs[i] ?? null;
    // A leg ending at a two-buoy leeward gate: each boat's buoy, looking upwind (gateSides.ts).
    const gate = gateSides(a).get(i);
    cols.push(
      {
        key: `L${i}.vmg`,
        head: 'VMG<br><small>kn</small>',
        title: `${leg.name}: distance made good along the estimated wind ÷ leg time`,
        group,
        rank: (b) => L(b)?.vmgKn,
        better: 'high',
        sort: (b) => L(b)?.vmgKn,
        first: 'desc',
        prec: 2 as const,
        cls: 'num leg',
        cell: (b) => (L(b) ? `<b>${f2(L(b)!.vmgKn)}</b>` : '—'),
      },
      {
        key: `L${i}.sog`,
        head: 'SOG<br><small>kn</small>',
        title: `${leg.name}: distance sailed ÷ leg time`,
        group,
        sort: (b) => L(b)?.sogKn,
        first: 'desc',
        prec: 1 as const,
        cell: (b) => f1(L(b)?.sogKn),
      },
      {
        key: `L${i}.twa`,
        head: 'TWA<br><small>est. °</small>',
        title: `${leg.name}: median |TWA| while sailing steadily, vs the estimated wind`,
        group,
        // Upwind, closer to the wind first; downwind, deepest first.
        sort: (b) => L(b)?.twaDeg,
        first: leg.kind === 'downwind' ? 'desc' : 'asc',
        prec: 0 as const,
        cell: (b) => (L(b) ? `${f0(L(b)!.twaDeg)}°` : '—'),
        cls: 'num muted',
      },
    );
    if (a.hasHeel) {
      cols.push({
        key: `L${i}.heel`,
        head: 'Heel<br><small>°</small>',
        title: `${leg.name}: ${HEEL_TITLE}`,
        group,
        sort: (b) => L(b)?.heelDeg,
        first: 'desc',
        prec: 1 as const,
        cell: (b) => (L(b) ? heelCell(L(b)!.heelDeg) : '—'),
      });
    }
    cols.push(
      {
        key: `L${i}.dist`,
        head: 'Dist<br><small>m</small>',
        title: `${leg.name}: distance sailed along the GPS track, meters`,
        group,
        sort: (b) => L(b)?.distM,
        first: 'asc',
        prec: 0 as const,
        cell: (b) => (L(b) ? fM(L(b)!.distM) : '—'),
      },
      {
        key: `L${i}.prog`,
        head: 'Prog<br><small>%</small>',
        title: `${leg.name}: progress ratio — the straight line from where the boat started the leg to where it ended it ÷ the distance it sailed. Higher = less extra distance`,
        group,
        rank: (b) => L(b)?.progress,
        better: 'high',
        sort: (b) => L(b)?.progress,
        first: 'desc',
        prec: '%',
        cell: (b) => progressCell(L(b)),
      },
      {
        key: `L${i}.time`,
        head: 'Time<br><small>place</small>',
        title: `${leg.name}: leg time (m:ss) and place at ${leg.to}${gate ? '; Gate L/R: the gate buoy rounded, looking upwind' : ''}`,
        group,
        sort: (b) => L(b)?.timeS,
        first: 'asc',
        prec: 0 as const,
        cell: (b) => {
          const l = L(b);
          if (!l) return '—';
          const t = duration(l.timeS);
          const side = gate?.get(b.id);
          const g = side ? ` <small class="gate" title="Rounded the ${side} buoy of the gate, looking upwind">${gateChip(side)}</small>` : '';
          return `${t}${l.rankAtEnd ? ` <small class="rk">${ordinal(l.rankAtEnd)}</small>` : ''}${g}`;
        },
      },
    );
    if (showsTacks(leg.kind)) {
      cols.push({
        key: `L${i}.tacks`,
        head: 'Tacks',
        title: `${leg.name}: tacks (through head-to-wind, from the GPS track)`,
        group,
        sort: (b) => L(b)?.tacks,
        first: 'asc',
        cell: (b) => countCell(L(b)?.tacks),
      });
    }
    if (showsGybes(leg.kind)) {
      cols.push({
        key: `L${i}.gybes`,
        head: 'Gybes',
        title: `${leg.name}: gybes (through dead downwind, from the GPS track)`,
        group,
        sort: (b) => L(b)?.gybes,
        first: 'asc',
        cell: (b) => countCell(L(b)?.gybes),
      });
    }
  }
  for (const kind of ['upwind', 'downwind'] as const) if (a.legs.some((l) => l.kind === kind)) cols.push(...summaryCols(kind, a.hasHeel));
  const race = { id: 'race', label: 'Race', title: 'Gun to finish' };
  const tacks = (b: BoatResult) => raceCount(b, (l) => l.tacks);
  const gybes = (b: BoatResult) => raceCount(b, (l) => l.gybes);
  cols.push(
    {
      key: 'dist',
      head: 'Dist<br><small>m</small>',
      title: 'Distance sailed gun → finish along the GPS track, meters (the sum of the legs)',
      group: race,
      sort: (b) => b.distM,
      first: 'asc',
      prec: 0 as const,
      cell: (b) => fM(b.distM),
    },
    {
      key: 'race',
      head: 'Time<br><small>finish</small>',
      title: 'Race time, and finish time (race local time)',
      group: race,
      rank: (b) => b.raceTimeS,
      better: 'low',
      sort: (b) => b.raceTimeS,
      first: 'asc',
      prec: 0 as const,
      cell: (b) => `${duration(b.raceTimeS)}<span class="sub">${localTime(b.finishMs, a.meta.tzOffsetMs)}</span>`,
    },
    {
      key: 'sog',
      head: 'SOG<br><small>avg kn</small>',
      title: 'Race distance ÷ race time',
      group: race,
      rank: (b) => b.sogAvgKn,
      better: 'high',
      sort: (b) => b.sogAvgKn,
      first: 'desc',
      prec: 2 as const,
      cell: (b) => f2(b.sogAvgKn),
    },
    {
      key: 'tacks',
      head: 'Tacks',
      title: 'Tacks over every leg sailed',
      group: race,
      sort: (b) => tacks(b),
      first: 'asc',
      cell: (b) => countCell(tacks(b)),
    },
    {
      key: 'gybes',
      head: 'Gybes',
      title: 'Gybes over every leg sailed',
      group: race,
      sort: (b) => gybes(b),
      first: 'asc',
      cell: (b) => countCell(gybes(b)),
    },
  );
  return cols;
}

/** A column's classes; the first of each group (a leg, Upwind, Downwind, the race) gets g0, the divider down its left edge. `sorted` is the current sort column. */
function colCls(cols: Col[], j: number, sortKey: string | null = null): string {
  const c = cols[j];
  const first = c.group != null && cols[j - 1]?.group?.id !== c.group.id;
  const sorted = sortKey != null && c.key === sortKey;
  return `${c.cls ?? 'num'}${first ? ' g0' : ''}${sorted ? ' sorted' : ''}`;
}

function headCell(c: Col, cls: string, sort: SortState | null, span: string): string {
  const on = sort?.key === c.key ? sort.dir : null;
  const aria = on ? ` aria-sort="${on === 'asc' ? 'ascending' : 'descending'}"` : '';
  // ↑/↓ for the sort, distinct from the ▲/▼ best/worst marks in the cells.
  const si = `<span class="si" aria-hidden="true">${on === 'asc' ? '↑' : on === 'desc' ? '↓' : ''}</span>`;
  return `<th class="${cls}" scope="col"${span}${aria}${c.title ? ` title="${esc(c.title)}"` : ''}><button type="button" class="sort" data-sort="${esc(c.key)}">${c.head}${si}</button></th>`;
}

/** The sorted column in words, e.g. "Beat 1 VMG kn ↓". */
const sortedName = (c: Col, dir: SortDir): string =>
  `${c.group ? `${c.group.label} ` : ''}${c.head.replace(/<br>/g, ' ').replace(/<[^>]+>/g, '')} ${dir === 'asc' ? '↑' : '↓'}`;

/** Compact group tag for the Rank header: "Up", "Dn", "B1", "R2", "Re1", "Race". */
function groupTag(g: { id: string; label: string }): string {
  if (g.id === 'up') return 'Up';
  if (g.id === 'dn') return 'Dn';
  if (g.id === 'race') return 'Race';
  const m = /^(Beat|Run|Reach)\s+(\d+)$/i.exec(g.label);
  if (!m) return g.label;
  return `${m[1].toLowerCase() === 'reach' ? 'Re' : m[1][0]}${m[2]}`;
}

/** Rank header sub-label: "Up VMG", "B1 SOG", "Race Time"; ungrouped columns keep the column name. */
function rankLabel(c: Col): string {
  const metric = c.head.split('<br>')[0].replace(/<[^>]+>/g, '');
  return c.group ? `${groupTag(c.group)} ${metric}` : metric;
}

/** The Rank header (not a sort button): its sub-label names the sorted column, in full in the title. */
function rankHead(by: Col, dir: SortDir, span: string): string {
  const what = `Rank in the current sort, by ${sortedName(by, dir)}`;
  return `<th class="num rank" scope="col"${span} title="${esc(what)}" aria-label="${esc(what)}">Rank<small>${esc(rankLabel(by))}</small></th>`;
}

/** Two header rows when there are groups: ungrouped columns span both; a group's label spans its sub-columns. */
function header(cols: Col[], sort: SortState | null, by: Col | null): string {
  const grouped = cols.some((c) => c.group);
  const top: string[] = by && sort ? [rankHead(by, sort.dir, grouped ? ' rowspan="2"' : '')] : [];
  const sub: string[] = [];
  cols.forEach((c, j) => {
    const g = c.group;
    const key = sort?.key ?? null;
    if (!g) {
      top.push(headCell(c, colCls(cols, j, key), sort, grouped ? ' rowspan="2"' : ''));
      return;
    }
    if (cols[j - 1]?.group?.id !== g.id) {
      const n = cols.filter((x) => x.group?.id === g.id).length;
      top.push(`<th class="grp" scope="colgroup" colspan="${n}"${g.title ? ` title="${esc(g.title)}"` : ''}>${esc(g.label)}</th>`);
    }
    sub.push(headCell(c, colCls(cols, j, key), sort, ''));
  });
  return `<tr>${top.join('')}</tr>${sub.length ? `<tr>${sub.join('')}</tr>` : ''}`;
}

function renderTable(a: RaceAnalysis, cols: Col[], id: TableId, highlight: string | null, sort: SortState | null): string {
  const marks = cols.map((c) => {
    if (!c.rank) return new Map<string, 'best' | 'worst'>();
    const vals = a.boats.map((b) => ({ id: b.id, v: c.rank!(b) })).filter((x): x is { id: string; v: number } => x.v != null && Number.isFinite(x.v));
    const m = new Map<string, 'best' | 'worst'>();
    if (vals.length < 3) return m;
    vals.sort((x, y) => (c.better === 'low' ? x.v - y.v : y.v - x.v));
    m.set(vals[0].id, 'best');
    m.set(vals[vals.length - 1].id, 'worst');
    return m;
  });
  const by = (sort && cols.find((c) => c.key === sort.key)) || null;
  const boats = by ? sortBoats(a.boats, by.sort, sort!.dir) : a.boats;
  // Rank only once sorted: in finish order it would only repeat Fin.
  const ranks = by ? sortRanks(a.boats, by.sort, sort!.dir, (v) => shownVal(v, by.prec)) : null;
  const sortKey = sort?.key ?? null;
  const rows = boats
    .map((b) => {
      const rank = ranks ? `<td class="num rank">${rankCell(ranks.get(b.id))}</td>` : '';
      const tds = cols
        .map((c, j) => {
          const hl = marks[j].get(b.id);
          const icon = hl === 'best' ? '<span class="ic" aria-label="best">▲</span>' : hl === 'worst' ? '<span class="ic" aria-label="worst">▼</span>' : '';
          return `<td class="${colCls(cols, j, sortKey)}${hl ? ' ' + hl : ''}">${icon}${c.cell(b)}</td>`;
        })
        .join('');
      return `<tr data-id="${esc(b.id)}" class="${highlight === b.id ? 'sel' : ''}" tabindex="0">${rank}${tds}</tr>`;
    })
    .join('');
  return `<table class="metrics ${id}${ranks ? ' ranked' : ''}" data-table="${id}"><thead>${header(cols, sort, by)}</thead><tbody>${rows}${excludedRow(a, cols, highlight, !!ranks, sortKey)}</tbody></table>`;
}

/** The start table (notes: `startNotesHtml`, rendered outside its scroller). */
export const startTable = (a: RaceAnalysis, highlight: string | null, sort: SortState | null = null): string =>
  renderTable(a, startColumns(a), 'start', highlight, sort);

/** The legs table (notes: `legsNotesHtml`). */
export const legsTable = (a: RaceAnalysis, highlight: string | null, sort: SortState | null = null): string =>
  renderTable(a, legColumns(a), 'legs', highlight, sort);

/** A picked boat that isn't racing: one unranked row at the foot, whatever the sort; no ▲/▼ marks, Rank "—". */
function excludedRow(a: RaceAnalysis, cols: Col[], highlight: string | null, ranked: boolean, sortKey: string | null = null): string {
  const nc = pickedExcluded(a, highlight);
  if (!nc) return '';
  const b = nc.result;
  const why = nc.reasons.join('; ');
  const tds = cols
    .map((c, j) => {
      const body = c.role === 'fin' ? '—' : c.role === 'boat' ? `${c.cell(b)} <span class="flag nc" title="${esc(why)}">not racing</span>` : c.cell(b);
      return `<td class="${colCls(cols, j, sortKey)}">${body}</td>`;
    })
    .join('');
  const rank = ranked ? '<td class="num rank">—</td>' : '';
  return `<tr data-id="${esc(b.id)}" class="sel nc" tabindex="0" title="${esc(`Not racing: ${why}`)}">${rank}${tds}</tr>`;
}
