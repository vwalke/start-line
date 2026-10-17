/** Compact metrics table with best/worst highlights per column (▲ best, ▼ worst — never colour alone). */
import type { BoatResult, RaceAnalysis } from '../analysis/types';
import { startNotes } from '../analysis/validity';
import { boatColor } from './charts';
import { duration, esc, f0, f1, f2, localTime, twaLabel } from './format';

const ordinal = (n: number): string => {
  const m = n % 100;
  const suf = m > 10 && m < 14 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suf}`;
};

interface Col {
  head: string;
  title?: string;
  /** Value used for best/worst; null = not ranked. */
  rank?: (b: BoatResult) => number | null | undefined;
  better?: 'low' | 'high';
  cell: (b: BoatResult) => string;
  cls?: string;
}

const START_TITLE =
  'Place among clean starters by distance to the line: V = ranked by the Vakaros device figure, ours = by our GPS track check (no usable Vakaros fix). over = OCS or bow over the line; — = no reliable figure.';

// Caveat markers carry a title for hover; the same text is listed under the table for touch screens.
function startCell(b: BoatResult): string {
  const s = b.start;
  if (!s) return '—';
  if (s.over) return '<span class="rk-over">over</span>';
  if (s.startPlace == null) return '<span class="na" title="No reliable start figure">—</span>';
  const src = s.rank!.source === 'vakaros' ? ['V', 'Vakaros device'] : ['ours', 'our track check'];
  return `${s.startPlace} <small class="rk-src" title="${src[1]}">${src[0]}</small>`;
}

function rcCell(b: BoatResult): string {
  const s = b.start;
  if (!s) return '—';
  if (s.rcDtlM == null) return s.rcNote ? `<span class="na" title="${esc(s.rcNote)}">—</span>` : '—';
  return `${s.warn ? `<span class="warn" title="${esc(s.warn)}" aria-label="disagrees with our check">⚠</span>` : ''}${f1(s.rcDtlM)}`;
}

function oursCell(b: BoatResult): string {
  const s = b.start;
  if (!s) return '—';
  if (s.dtlNote) return `<span class="gap" title="${esc(s.dtlNote)}">~${f1(s.dtlM)}</span>`;
  return f1(s.dtlM);
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
          head: 'DTL<br><small>Vakaros m</small>',
          title:
            "Distance to line from the boat's Vakaros device (feed dtlMm, bow-corrected; device start-fix timing). Primary figure. — = no usable fix; ⚠ = differs from our check by more than 3 m.",
          cell: rcCell,
        },
        {
          head: 'Check<br><small>ours m</small>',
          title:
            "Our independent estimate from the GPS track (bow offset along heading, sampled at the device's start fix). A check on the Vakaros figure, not the official number. ~ = interpolated across a telemetry gap.",
          cell: oursCell,
          cls: 'num muted',
        },
      ]
    : [
        {
          head: 'DTL<br><small>@gun m</small>',
          title: 'Bow distance behind the line at the gun (bow-corrected). Negative = over. ~ = interpolated across a telemetry gap.',
          cell: oursCell,
        },
      ];
  const cols: Col[] = [
    { head: 'Fin', cell: (b) => (b.finishPos == null ? 'DNF' : String(b.finishPos)), cls: 'num sticky0' },
    {
      head: 'Boat',
      cls: 'boat sticky1',
      cell: (b) =>
        `<i class="sw" style="background:${boatColor(b, a.boats.length)}"></i>#${esc(b.sail)}${
          b.name !== `#${b.sail}` ? ` <span class="bname">${esc(b.name)}</span>` : ''
        }${b.start?.ocs ? ' <span class="flag" title="Flagged OCS by race control">OCS</span>' : ''}`,
    },
    {
      head: 'Start<br><small>rank</small>',
      title: START_TITLE,
      rank: (b) => (b.start?.startPlace != null ? b.start.rank!.m : null),
      better: 'low',
      cell: startCell,
    },
    ...dtlCols,
    {
      head: 'Late<br><small>s</small>',
      title: 'Our DTL ÷ speed toward the line at the gun (blank when our DTL is interpolated across a gap)',
      rank: (b) => (b.start?.startPlace != null ? b.start.lateS : null),
      better: 'low',
      cell: (b) => f1(b.start?.lateS),
    },
    {
      head: 'Line<br><small>pos %</small>',
      title: '0% = pin (left) end, 100% = RC (right) end',
      cell: (b) => f0(b.start?.linePosPct),
      cls: 'num muted',
    },
    {
      head: 'Speed<br><small>@gun kn</small>',
      rank: (b) => b.start?.speedKn,
      better: 'high',
      cell: (b) => f1(b.start?.speedKn),
    },
    {
      head: 'TWA<br><small>@gun est.</small>',
      title: 'S = starboard, P = port; vs the estimated wind',
      cell: (b) => twaLabel(b.start?.twaDeg),
      cls: 'num muted',
    },
    {
      head: 'SOG<br><small>avg kn</small>',
      rank: (b) => b.sogAvgKn,
      better: 'high',
      cell: (b) => f2(b.sogAvgKn),
    },
  ];
  for (const leg of a.legs) {
    const i = leg.index;
    cols.push({
      head: `${esc(leg.name)}<br><small>VMG · SOG · TWA</small>`,
      title: `${leg.name} to ${leg.to}. VMG along the estimated wind (kn), SOG (kn), median |TWA| while steady (est.)`,
      rank: (b) => b.legs[i]?.vmgKn,
      better: 'high',
      cls: 'leg',
      cell: (b) => {
        const l = b.legs[i];
        if (!l) return '—';
        return `<b>${f2(l.vmgKn)}</b><span class="sub">${f1(l.sogKn)} · ${f0(l.twaDeg)}°</span><span class="sub t">${duration(l.timeS)}${
          l.rankAtEnd ? ` · ${ordinal(l.rankAtEnd)}` : ''
        }</span>`;
      },
    });
  }
  cols.push({
    head: 'Race<br><small>time</small>',
    rank: (b) => b.raceTimeS,
    better: 'low',
    cell: (b) => `${duration(b.raceTimeS)}<span class="sub">${localTime(b.finishMs, a.meta.tzOffsetMs)}</span>`,
  });
  return cols;
}

export function metricsTable(a: RaceAnalysis, highlight: string | null): string {
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
  const head = cols.map((c) => `<th class="${c.cls ?? 'num'}"${c.title ? ` title="${esc(c.title)}"` : ''}>${c.head}</th>`).join('');
  const rows = a.boats
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
  return `<table class="metrics"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>${notesList(a)}`;
}
