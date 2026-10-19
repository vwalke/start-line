/**
 * The two metrics tables, with best/worst highlights per column (▲ best, ▼ worst — never colour alone).
 * Start: how each boat started (and its heel at the gun). Legs: each leg's VMG / SOG / TWA / Heel / Dist / Time / tacks or gybes / Data,
 * (Heel columns only when the feed carries roll),
 * the upwind and downwind legs added up, and the race. Every column sorts from its header (↑/↓); the
 * tables sort independently, and their column keys are unique across both.
 */
import { LOW_COVERAGE } from '../analysis/coverage';
import type { BoatResult, KindSummary, LegKind, LegResult, RaceAnalysis } from '../analysis/types';
import { SPAN_MS, startNotes } from '../analysis/validity';
import { boatColor, pickedExcluded } from './charts';
import { duration, esc, f0, f1, f2, fM, localTime, pct, twaLabel } from './format';

const ordinal = (n: number): string => {
  const m = n % 100;
  const suf = m > 10 && m < 14 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suf}`;
};

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
    (a, b) => compareValues(value(a), value(b), dir) || (a.finishPos ?? 1e9) - (b.finishPos ?? 1e9) || a.colorSlot - b.colorSlot,
  );
}

/** The sort after clicking column `key`: its natural direction first, then reversed. */
export function nextSort(cur: SortState | null, key: string, first: SortDir): SortState {
  if (cur?.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: first };
}

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
  if (s.startPlace == null) return '<span class="na" title="No reliable start figure" aria-label="No reliable start figure">—</span>';
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
  if (s.dtlNote) return `<span class="gap" title="${esc(s.dtlNote)}" aria-label="${esc(s.dtlNote)}">~${f1(s.dtlM)}</span>`;
  return f1(s.dtlM);
}

const APPROX = `More than ${SPAN_MS / 1000} s between GPS fixes; that stretch counts as a straight line`;
const gapSpan = (title: string, body: string): string => `<span class="gap" title="${esc(title)}" aria-label="${esc(title)}">~${body}</span>`;

function legDistCell(l: LegResult): string {
  if (l.distGapS == null) return fM(l.distM);
  return gapSpan(`Approximate: a ${Math.round(l.distGapS)} s telemetry gap in this leg. ${APPROX}.`, fM(l.distM));
}

function raceDistCell(b: BoatResult): string {
  if (b.distM == null) return '—';
  if (!b.distApprox) return fM(b.distM);
  const gaps = b.legs.map((l) => l?.distGapS).filter((g): g is number => g != null);
  return gapSpan(
    `Approximate: ${gaps.length ? `telemetry gaps in the track (longest ${Math.round(Math.max(...gaps))} s)` : 'a telemetry gap in the track'}. ${APPROX}.`,
    fM(b.distM),
  );
}

const MANOEUVRE_GAP = 'Approximate: a tack or gybe here bridges a telemetry gap, so its timing (and a quick double turn) may be missed';

/** A tack or gybe count, ~ when one bridges a telemetry gap. */
const countCell = (n: number | null | undefined, approx: boolean): string => (n == null ? '—' : approx ? gapSpan(MANOEUVRE_GAP, String(n)) : String(n));

/** "97%"; below LOW_COVERAGE flagged ⚠ (class dq-low) with what's missing. */
export function dqCell(coverage: number | null | undefined, maxGapS: number | null | undefined, what: string): string {
  if (coverage == null || !Number.isFinite(coverage)) return '—';
  const gap = maxGapS != null && maxGapS > SPAN_MS / 1000 ? `; longest gap ${Math.round(maxGapS)} s` : '';
  const title = `Data for ${pct(coverage)} of the ${what}${gap}`;
  if (coverage >= LOW_COVERAGE) return `<span title="${esc(title)}">${pct(coverage)}</span>`;
  return `<span class="dq-low" title="${esc(title)}" aria-label="${esc(`Low data: ${title}`)}">⚠ ${pct(coverage)}</span>`;
}

const HEEL_TITLE = 'average leeward heel, time-weighted; excludes manoeuvres (± 5 s of each tack or gybe). Negative = heeled to windward';

/** Mean leeward heel "15.3°"; heel readings for under LOW_COVERAGE of the time flagged ⚠ (class dq-low), as Data %. */
export function heelCell(heelDeg: number | null | undefined, cover: number | null | undefined, what: string): string {
  if (heelDeg == null || !Number.isFinite(heelDeg)) return '—';
  const body = `${f1(heelDeg)}°`;
  if (cover == null || cover >= LOW_COVERAGE) return `<span class="heel">${body}</span>`;
  const title = `Heel data for ${pct(cover)} of the ${what}`;
  return `<span class="heel dq-low" title="${esc(title)}" aria-label="${esc(`Low data: ${title}`)}">⚠ ${body}</span>`;
}

/** One line for a table's key: what Heel is, or that this feed has none (the columns are hidden). */
export const heelNote = (a: RaceAnalysis): string =>
  a.hasHeel
    ? `Heel: leeward heel from each tracker's motion sensor, + to leeward, − to windward. Per leg and upwind / downwind it is the time-weighted average, leaving out 5 s either side of each tack or gybe; at the gun, the fix nearest the gun (within 2 s). ⚠ = heel data for under ${Math.round(LOW_COVERAGE * 100)}% of the time.`
    : 'Heel: not in this feed (older events send no roll from the trackers), so the heel columns are hidden.';

/** One boat's caveats about its start, so they're readable without hover. */
export function startNotesHtml(a: RaceAnalysis): string {
  const items = a.boats
    .filter((b) => b.start && startNotes(b.start).length)
    .map((b) => {
      const text = startNotes(b.start!).map((n) => n.replace(/\.$/, '')).join('; ') + '.';
      return `<li><b>#${esc(b.sail)}</b>${b.name !== `#${b.sail}` ? ` ${esc(b.name)}` : ''} — ${esc(text)}</li>`;
    });
  const key = 'Start: place among clean starters; V = Vakaros device, ours = our track check. ~ = interpolated across a data gap; ⚠ = Vakaros and ours disagree.';
  return `<div class="table-notes"><p>${esc(key)}</p><p class="heel-note">${esc(heelNote(a))}</p>${items.length ? `<p>Notes:</p><ul>${items.join('')}</ul>` : ''}</div>`;
}

/** The legs table's key: Data % and the threshold, the ~ marks, partial summaries, and Heel when the race is given. */
export function legsNotesHtml(a?: RaceAnalysis): string {
  const lines = [
    `Data: the share of the leg (or of the race) where this boat's GPS fixes are at most ${SPAN_MS / 1000} s apart. ⚠ below ${Math.round(LOW_COVERAGE * 100)}%: distance, speed and tack/gybe counts there rest on less of the track, and turns inside a long hole can't be seen.`,
    `~ on a distance: bridges a telemetry gap over ${SPAN_MS / 1000} s (a straight line across it). ~ on a tack or gybe count: one of them bridges a gap.`,
    'Upwind / Downwind: every beat (run) added up; reaches are in neither. Place is by total time among boats that sailed every leg of that kind; partial = a leg is missing, so no place.',
    'Tacks are counted on beats and gybes on runs (both on reaches): a change of side through head-to-wind or dead downwind held for 10 s, from the GPS track.',
  ];
  const heel = a ? `<p class="heel-note">${esc(heelNote(a))}</p>` : '';
  return `<div class="table-notes">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}${heel}</div>`;
}

function finCol(key: string, sticky = 'sticky0'): Col {
  return {
    key,
    head: 'Fin',
    title: 'Finish position (DNF = no finish)',
    sort: (b) => b.finishPos,
    first: 'asc',
    cell: (b) => (b.finishPos == null ? 'DNF' : String(b.finishPos)),
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
          cell: rcCell,
        },
        {
          key: 'ours',
          head: 'Check<br><small>ours m</small>',
          title:
            "Our independent estimate from the GPS track (bow offset along heading, sampled at the device's start fix). A check on the Vakaros figure, not the official number. ~ = interpolated across a telemetry gap.",
          sort: (b) => b.start?.dtlM,
          first: 'asc',
          cell: oursCell,
          cls: 'num muted',
        },
      ]
    : [
        {
          key: 'ours',
          head: 'DTL<br><small>@gun m</small>',
          title: 'Bow distance behind the line at the gun (bow-corrected). Negative = over. ~ = interpolated across a telemetry gap.',
          sort: (b) => b.start?.dtlM,
          first: 'asc',
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
      title: 'Our DTL ÷ speed toward the line at the gun (blank when our DTL is interpolated across a gap)',
      rank: (b) => (b.start?.startPlace != null ? b.start.lateS : null),
      better: 'low',
      sort: (b) => b.start?.lateS,
      first: 'asc',
      cell: (b) => f1(b.start?.lateS),
    },
    {
      key: 'line',
      head: 'Line<br><small>pos %</small>',
      title: '0% = pin (left) end, 100% = RC (right) end',
      sort: (b) => b.start?.linePosPct,
      first: 'asc',
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
      cell: (b) => f1(b.start?.speedKn),
    },
    {
      key: 'twa',
      head: 'TWA<br><small>@gun est.</small>',
      title: 'S = starboard, P = port; vs the estimated wind. Sorts by angle off the wind, closest first.',
      sort: (b) => (b.start ? Math.abs(b.start.twaDeg) : null),
      first: 'asc',
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
      cls: 'num leg g0',
      cell: val((s) => `<b>${f2(s.vmgKn)}</b>`),
    },
    {
      key: `${id}.sog`,
      head: 'SOG<br><small>kn</small>',
      title: `${label}: distance sailed ÷ time`,
      group,
      sort: (b) => S(b)?.sogKn,
      first: 'desc',
      cell: val((s) => f1(s.sogKn)),
    },
    {
      key: `${id}.twa`,
      head: 'TWA<br><small>est. °</small>',
      title: `${label}: |TWA| weighted by leg time`,
      group,
      sort: (b) => S(b)?.twaDeg,
      first: kind === 'downwind' ? 'desc' : 'asc',
      cell: val((s) => `${f0(s.twaDeg)}°`),
      cls: 'num muted',
    },
    ...(hasHeel
      ? [
          {
            key: `${id}.heel`,
            head: 'Heel<br><small>°</small>',
            title: `${label}: ${HEEL_TITLE}; over every ${kind} leg. ⚠ = heel data for under ${Math.round(LOW_COVERAGE * 100)}% of the time`,
            group,
            sort: (b: BoatResult) => S(b)?.heelDeg,
            first: 'desc' as const,
            cell: val((s) => heelCell(s.heelDeg, s.heelCoverage, `${kind} legs`)),
          },
        ]
      : []),
    {
      key: `${id}.dist`,
      head: 'Dist<br><small>m</small>',
      title: `${label}: distance sailed, metres. ~ = bridges a telemetry gap over ${SPAN_MS / 1000} s`,
      group,
      sort: (b) => S(b)?.distM,
      first: 'asc',
      cell: val((s) => (s.distApprox ? gapSpan(`Approximate: a ${kind} leg bridges a telemetry gap. ${APPROX}.`, fM(s.distM)) : fM(s.distM))),
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
      cell: val((s) => `${duration(s.timeS)} <small class="rk">${s.place != null ? ordinal(s.place) : s.complete ? '' : `partial ${s.legs}/${s.of}`}</small>`),
    },
    kind === 'upwind'
      ? {
          key: `${id}.tacks`,
          head: 'Tacks',
          title: `${label}: tacks on every beat. ~ = one bridges a telemetry gap`,
          group,
          sort: (b) => S(b)?.tacks,
          first: 'asc',
          cell: val((s) => countCell(s.tacks, s.manoeuvreApprox)),
        }
      : {
          key: `${id}.gybes`,
          head: 'Gybes',
          title: `${label}: gybes on every run. ~ = one bridges a telemetry gap`,
          group,
          sort: (b) => S(b)?.gybes,
          first: 'asc',
          cell: val((s) => countCell(s.gybes, s.manoeuvreApprox)),
        },
    {
      key: `${id}.dq`,
      head: 'Data<br><small>%</small>',
      title: `${label}: share of the time with GPS fixes at most ${SPAN_MS / 1000} s apart. ⚠ below ${Math.round(LOW_COVERAGE * 100)}%`,
      group,
      sort: (b) => S(b)?.coverage,
      first: 'desc',
      cell: val((s) => dqCell(s.coverage, s.maxGapS, `${kind} legs`)),
    },
  ];
  return cols;
}

/** Race totals of tacks / gybes over the boat's legs; null with none. */
function raceCount(b: BoatResult, f: (l: LegResult) => number): { n: number; approx: boolean } | null {
  const ls = b.legs.filter((l): l is LegResult => l != null);
  return ls.length ? { n: ls.reduce((s, l) => s + f(l), 0), approx: ls.some((l) => l.manoeuvreGap) } : null;
}

/** The legs table: start place, each leg, upwind / downwind, the race. */
function legColumns(a: RaceAnalysis): Col[] {
  const cols: Col[] = [finCol('fin'), boatCol(a, 'boat'), startPlaceCol('lstart')];
  for (const leg of a.legs) {
    const i = leg.index;
    const group = { id: `L${i}`, label: leg.name, title: `${leg.name} to ${leg.to}` };
    const L = (b: BoatResult): LegResult | null => b.legs[i] ?? null;
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
        cls: 'num leg g0',
        cell: (b) => (L(b) ? `<b>${f2(L(b)!.vmgKn)}</b>` : '—'),
      },
      {
        key: `L${i}.sog`,
        head: 'SOG<br><small>kn</small>',
        title: `${leg.name}: distance sailed ÷ leg time`,
        group,
        sort: (b) => L(b)?.sogKn,
        first: 'desc',
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
        cell: (b) => (L(b) ? `${f0(L(b)!.twaDeg)}°` : '—'),
        cls: 'num muted',
      },
    );
    if (a.hasHeel) {
      cols.push({
        key: `L${i}.heel`,
        head: 'Heel<br><small>°</small>',
        title: `${leg.name}: ${HEEL_TITLE}. ⚠ = heel data for under ${Math.round(LOW_COVERAGE * 100)}% of the leg`,
        group,
        sort: (b) => L(b)?.heelDeg,
        first: 'desc',
        cell: (b) => (L(b) ? heelCell(L(b)!.heelDeg, L(b)!.heelCoverage, 'leg') : '—'),
      });
    }
    cols.push(
      {
        key: `L${i}.dist`,
        head: 'Dist<br><small>m</small>',
        title: `${leg.name}: distance sailed along the GPS track, metres. ~ = bridges a telemetry gap over ${SPAN_MS / 1000} s`,
        group,
        sort: (b) => L(b)?.distM,
        first: 'asc',
        cell: (b) => (L(b) ? legDistCell(L(b)!) : '—'),
      },
      {
        key: `L${i}.time`,
        head: 'Time<br><small>place</small>',
        title: `${leg.name}: leg time (m:ss) and place at ${leg.to}`,
        group,
        sort: (b) => L(b)?.timeS,
        first: 'asc',
        cell: (b) => {
          const l = L(b);
          if (!l) return '—';
          return `${duration(l.timeS)}${l.rankAtEnd ? ` <small class="rk">${ordinal(l.rankAtEnd)}</small>` : ''}`;
        },
      },
    );
    if (showsTacks(leg.kind)) {
      cols.push({
        key: `L${i}.tacks`,
        head: 'Tacks',
        title: `${leg.name}: tacks (through head-to-wind, from the GPS track). ~ = one bridges a telemetry gap`,
        group,
        sort: (b) => L(b)?.tacks,
        first: 'asc',
        cell: (b) => countCell(L(b)?.tacks, !!L(b)?.manoeuvreGap),
      });
    }
    if (showsGybes(leg.kind)) {
      cols.push({
        key: `L${i}.gybes`,
        head: 'Gybes',
        title: `${leg.name}: gybes (through dead downwind, from the GPS track). ~ = one bridges a telemetry gap`,
        group,
        sort: (b) => L(b)?.gybes,
        first: 'asc',
        cell: (b) => countCell(L(b)?.gybes, !!L(b)?.manoeuvreGap),
      });
    }
    cols.push({
      key: `L${i}.dq`,
      head: 'Data<br><small>%</small>',
      title: `${leg.name}: share of the leg with GPS fixes at most ${SPAN_MS / 1000} s apart. ⚠ below ${Math.round(LOW_COVERAGE * 100)}%`,
      group,
      sort: (b) => L(b)?.coverage,
      first: 'desc',
      cell: (b) => (L(b) ? dqCell(L(b)!.coverage, L(b)!.maxGapS, 'leg') : '—'),
    });
  }
  for (const kind of ['upwind', 'downwind'] as const) if (a.legs.some((l) => l.kind === kind)) cols.push(...summaryCols(kind, a.hasHeel));
  const race = { id: 'race', label: 'Race', title: 'Gun to finish' };
  const tacks = (b: BoatResult) => raceCount(b, (l) => l.tacks);
  const gybes = (b: BoatResult) => raceCount(b, (l) => l.gybes);
  cols.push(
    {
      key: 'dist',
      head: 'Dist<br><small>m</small>',
      title: `Distance sailed gun → finish along the GPS track, metres (the sum of the legs). ~ = some leg bridges a telemetry gap over ${SPAN_MS / 1000} s`,
      group: race,
      sort: (b) => b.distM,
      first: 'asc',
      cell: raceDistCell,
      cls: 'num g0',
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
      cell: (b) => f2(b.sogAvgKn),
    },
    {
      key: 'tacks',
      head: 'Tacks',
      title: 'Tacks over every leg sailed. ~ = one bridges a telemetry gap',
      group: race,
      sort: (b) => tacks(b)?.n,
      first: 'asc',
      cell: (b) => countCell(tacks(b)?.n, !!tacks(b)?.approx),
    },
    {
      key: 'gybes',
      head: 'Gybes',
      title: 'Gybes over every leg sailed. ~ = one bridges a telemetry gap',
      group: race,
      sort: (b) => gybes(b)?.n,
      first: 'asc',
      cell: (b) => countCell(gybes(b)?.n, !!gybes(b)?.approx),
    },
    {
      key: 'dq',
      head: 'Data<br><small>%</small>',
      title: `Share of the race (gun → finish) with GPS fixes at most ${SPAN_MS / 1000} s apart. ⚠ below ${Math.round(LOW_COVERAGE * 100)}%`,
      group: race,
      sort: (b) => b.coverage,
      first: 'desc',
      cell: (b) => dqCell(b.coverage, b.maxGapS, 'race'),
    },
  );
  return cols;
}

function headCell(c: Col, sort: SortState | null, span: string): string {
  const on = sort?.key === c.key ? sort.dir : null;
  const aria = on ? ` aria-sort="${on === 'asc' ? 'ascending' : 'descending'}"` : '';
  // ↑/↓ for the sort, distinct from the ▲/▼ best/worst marks in the cells.
  const si = `<span class="si" aria-hidden="true">${on === 'asc' ? '↑' : on === 'desc' ? '↓' : ''}</span>`;
  return `<th class="${c.cls ?? 'num'}" scope="col"${span}${aria}${c.title ? ` title="${esc(c.title)}"` : ''}><button type="button" class="sort" data-sort="${esc(c.key)}">${c.head}${si}</button></th>`;
}

/** Two header rows when there are groups: ungrouped columns span both; a group's label spans its sub-columns. */
function header(cols: Col[], sort: SortState | null): string {
  const grouped = cols.some((c) => c.group);
  const top: string[] = [];
  const sub: string[] = [];
  cols.forEach((c, j) => {
    const g = c.group;
    if (!g) {
      top.push(headCell(c, sort, grouped ? ' rowspan="2"' : ''));
      return;
    }
    if (cols[j - 1]?.group?.id !== g.id) {
      const n = cols.filter((x) => x.group?.id === g.id).length;
      top.push(`<th class="grp" scope="colgroup" colspan="${n}"${g.title ? ` title="${esc(g.title)}"` : ''}>${esc(g.label)}</th>`);
    }
    sub.push(headCell(c, sort, ''));
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
  const by = sort && cols.find((c) => c.key === sort.key);
  const boats = by ? sortBoats(a.boats, by.sort, sort.dir) : a.boats;
  const rows = boats
    .map((b) => {
      const tds = cols
        .map((c, j) => {
          const hl = marks[j].get(b.id);
          const icon = hl === 'best' ? '<span class="ic" aria-label="best">▲</span>' : hl === 'worst' ? '<span class="ic" aria-label="worst">▼</span>' : '';
          return `<td class="${c.cls ?? 'num'}${hl ? ' ' + hl : ''}">${icon}${c.cell(b)}</td>`;
        })
        .join('');
      return `<tr data-id="${esc(b.id)}" class="${highlight === b.id ? 'sel' : ''}" tabindex="0">${tds}</tr>`;
    })
    .join('');
  return `<table class="metrics ${id}" data-table="${id}"><thead>${header(cols, sort)}</thead><tbody>${rows}${excludedRow(a, cols, highlight)}</tbody></table>`;
}

/** The start table (notes: `startNotesHtml`, rendered outside its scroller). */
export const startTable = (a: RaceAnalysis, highlight: string | null, sort: SortState | null = null): string =>
  renderTable(a, startColumns(a), 'start', highlight, sort);

/** The legs table (notes: `legsNotesHtml`). */
export const legsTable = (a: RaceAnalysis, highlight: string | null, sort: SortState | null = null): string =>
  renderTable(a, legColumns(a), 'legs', highlight, sort);

/** A picked boat that isn't racing: one unranked row at the foot, whatever the sort; no ▲/▼ marks. */
function excludedRow(a: RaceAnalysis, cols: Col[], highlight: string | null): string {
  const nc = pickedExcluded(a, highlight);
  if (!nc) return '';
  const b = nc.result;
  const why = nc.reasons.join('; ');
  const tds = cols
    .map((c) => {
      const body = c.role === 'fin' ? '—' : c.role === 'boat' ? `${c.cell(b)} <span class="flag nc" title="${esc(why)}">not racing</span>` : c.cell(b);
      return `<td class="${c.cls ?? 'num'}">${body}</td>`;
    })
    .join('');
  return `<tr data-id="${esc(b.id)}" class="sel nc" tabindex="0" title="${esc(`Not racing: ${why}`)}">${tds}</tr>`;
}
