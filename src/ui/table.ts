/**
 * Compact metrics table with best/worst highlights per column (▲ best, ▼ worst — never colour alone).
 * Every column sorts from its header (↑/↓); each leg is a group of VMG / SOG / TWA / Dist / Time.
 */
import type { BoatResult, LegResult, RaceAnalysis } from '../analysis/types';
import { SPAN_MS, startNotes } from '../analysis/validity';
import { boatColor, pickedExcluded } from './charts';
import { duration, esc, f0, f1, f2, localTime, twaLabel } from './format';

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

interface Col {
  /** Stable id for sorting, e.g. "fin", "L2.sog". */
  key: string;
  head: string;
  title?: string;
  /** Columns sharing a group sit under one spanning header (a leg, the race). */
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

/** `nextSort` for a column of this race's table (unknown keys leave the sort as it is). */
export function toggleSort(a: RaceAnalysis, cur: SortState | null, key: string): SortState | null {
  const col = columns(a).find((c) => c.key === key);
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

function legDistCell(l: LegResult): string {
  if (l.distGapS == null) return f2(l.distNm);
  const t = `Approximate: a ${Math.round(l.distGapS)} s telemetry gap in this leg. ${APPROX}.`;
  return `<span class="gap" title="${esc(t)}" aria-label="${esc(t)}">~${f2(l.distNm)}</span>`;
}

function raceDistCell(b: BoatResult): string {
  if (b.distNm == null) return '—';
  if (!b.distApprox) return f2(b.distNm);
  const gaps = b.legs.map((l) => l?.distGapS).filter((g): g is number => g != null);
  const t = `Approximate: ${gaps.length ? `telemetry gaps in the track (longest ${Math.round(Math.max(...gaps))} s)` : 'a telemetry gap in the track'}. ${APPROX}.`;
  return `<span class="gap" title="${esc(t)}" aria-label="${esc(t)}">~${f2(b.distNm)}</span>`;
}

/** The key, then one line per boat with caveats, so the notes are readable without hover. */
function notesList(a: RaceAnalysis): string {
  const items = a.boats
    .filter((b) => b.start && startNotes(b.start).length)
    .map((b) => {
      const text = startNotes(b.start!).map((n) => n.replace(/\.$/, '')).join('; ') + '.';
      return `<li><b>#${esc(b.sail)}</b>${b.name !== `#${b.sail}` ? ` ${esc(b.name)}` : ''} — ${esc(text)}</li>`;
    });
  const key = 'Start: place among clean starters; V = Vakaros device, ours = our track check. ~ = interpolated across a data gap; ⚠ = Vakaros and ours disagree.';
  return `<div class="table-notes"><p>${esc(key)}</p>${items.length ? `<p>Notes:</p><ul>${items.join('')}</ul>` : ''}</div>`;
}

function columns(a: RaceAnalysis): Col[] {
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
  const cols: Col[] = [
    {
      key: 'fin',
      head: 'Fin',
      title: 'Finish position (DNF = no finish)',
      sort: (b) => b.finishPos,
      first: 'asc',
      cell: (b) => (b.finishPos == null ? 'DNF' : String(b.finishPos)),
      cls: 'num sticky0',
    },
    {
      key: 'boat',
      head: 'Boat',
      title: 'Sail number',
      sort: (b) => b.sail,
      first: 'asc',
      cls: 'boat sticky1',
      cell: (b) =>
        `<i class="sw" style="background:${boatColor(b, a.boats.length)}"></i>#${esc(b.sail)}${
          b.name !== `#${b.sail}` ? ` <span class="bname">${esc(b.name)}</span>` : ''
        }${b.start?.ocs ? ' <span class="flag" title="Flagged OCS by race control">OCS</span>' : ''}`,
    },
    {
      key: 'start',
      head: 'Start<br><small>rank</small>',
      title: START_TITLE,
      rank: (b) => (b.start?.startPlace != null ? b.start.rank!.m : null),
      better: 'low',
      sort: (b) => b.start?.startPlace,
      first: 'asc',
      cell: startCell,
    },
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
    {
      key: 'sog',
      head: 'SOG<br><small>avg kn</small>',
      rank: (b) => b.sogAvgKn,
      better: 'high',
      sort: (b) => b.sogAvgKn,
      first: 'desc',
      cell: (b) => f2(b.sogAvgKn),
    },
  ];
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
      {
        key: `L${i}.dist`,
        head: 'Dist<br><small>nm</small>',
        title: `${leg.name}: distance sailed along the GPS track. ~ = bridges a telemetry gap over ${SPAN_MS / 1000} s`,
        group,
        sort: (b) => L(b)?.distNm,
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
  }
  const race = { id: 'race', label: 'Race', title: 'Gun to finish' };
  cols.push(
    {
      key: 'dist',
      head: 'Dist<br><small>nm</small>',
      title: `Distance sailed gun → finish along the GPS track (the sum of the legs). ~ = some leg bridges a telemetry gap over ${SPAN_MS / 1000} s`,
      group: race,
      sort: (b) => b.distNm,
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

/** Two header rows: ungrouped columns span both; a group's label spans its sub-columns. */
function header(cols: Col[], sort: SortState | null): string {
  const top: string[] = [];
  const sub: string[] = [];
  cols.forEach((c, j) => {
    const g = c.group;
    if (!g) {
      top.push(headCell(c, sort, ' rowspan="2"'));
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

export function metricsTable(a: RaceAnalysis, highlight: string | null, sort: SortState | null = null): string {
  const cols = columns(a);
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
  return `<table class="metrics"><thead>${header(cols, sort)}</thead><tbody>${rows}${excludedRow(a, cols, highlight)}</tbody></table>${notesList(a)}`;
}

/** A picked boat that isn't racing: one unranked row at the foot, whatever the sort; no ▲/▼ marks. */
function excludedRow(a: RaceAnalysis, cols: Col[], highlight: string | null): string {
  const nc = pickedExcluded(a, highlight);
  if (!nc) return '';
  const b = nc.result;
  const why = nc.reasons.join('; ');
  const tds = cols
    .map((c) => {
      const body =
        c.key === 'fin'
          ? '—'
          : c.key === 'boat'
            ? `${c.cell(b)} <span class="flag nc" title="${esc(why)}">not racing</span>`
            : c.cell(b);
      return `<td class="${c.cls ?? 'num'}">${body}</td>`;
    })
    .join('');
  return `<tr data-id="${esc(b.id)}" class="sel nc" tabindex="0" title="${esc(`Not racing: ${why}`)}">${tds}</tr>`;
}
