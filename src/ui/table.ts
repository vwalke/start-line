/** Compact metrics table with best/worst highlights per column (▲ best, ▼ worst — never colour alone). */
import type { BoatResult, RaceAnalysis } from '../analysis/types';
import { boatColor } from './charts';
import { duration, esc, f0, f1, f2, localTime, twaLabel } from './format';

interface Col {
  head: string;
  title?: string;
  /** Value used for best/worst; null = not ranked. */
  rank?: (b: BoatResult) => number | null | undefined;
  better?: 'low' | 'high';
  cell: (b: BoatResult) => string;
  cls?: string;
}

function columns(a: RaceAnalysis): Col[] {
  const clean = (b: BoatResult): boolean => !!b.start && b.start.dtlM >= 0 && !b.start.ocs;
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
      head: 'DTL<br><small>@gun m</small>',
      title: 'Bow distance behind the line at the gun (bow-corrected). Negative = over.',
      rank: (b) => (clean(b) ? b.start!.dtlM : null),
      better: 'low',
      cell: (b) => f1(b.start?.dtlM),
    },
    {
      head: 'RC DTL<br><small>m</small>',
      title: "Race control's own distance-to-line figure from the feed",
      cell: (b) => f1(b.start?.rcDtlM),
      cls: 'num muted',
    },
    {
      head: 'Late<br><small>s</small>',
      title: 'DTL ÷ speed toward the line at the gun',
      rank: (b) => (clean(b) ? b.start!.secsLate : null),
      better: 'low',
      cell: (b) => f1(b.start?.secsLate),
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
          l.rankAtEnd ? ` · ${l.rankAtEnd}${['th', 'st', 'nd', 'rd'][l.rankAtEnd] ?? 'th'}` : ''
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
  return `<table class="metrics"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}
