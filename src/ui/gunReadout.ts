/**
 * The selected boat at the gun in the terms a Vakaros start display uses: SOG, VMG, HDG, TWA (with its tack) and the
 * distance to the line, compact, at the top of the Start findings. The distance is the Start view's (from the bow), a
 * plain number; TWA and VMG rest on the estimated wind and say so, "(est.)", as the wind arrow does.
 */
import { gunReadout, type GunReadout } from '../analysis/startSummary';
import type { RaceAnalysis } from '../analysis/types';
import { esc, f0, f1 } from './format';

/** The readout's cells: label, value, and a fuller title; a figure not known is left out. */
export function gunReadoutCells(r: GunReadout): { label: string; value: string; title: string }[] {
  const cells: { label: string; value: string; title: string }[] = [];
  if (r.sogKn != null) cells.push({ label: 'SOG', value: `${f1(r.sogKn)} kn`, title: 'Speed over ground at the gun' });
  if (r.vmgKn != null) cells.push({ label: 'VMG', value: `${f1(r.vmgKn)} kn`, title: 'Speed made good toward the wind at the gun (est. wind)' });
  if (r.hdgDeg != null) cells.push({ label: 'HDG', value: `${f0(r.hdgDeg)}°`, title: 'Heading at the gun' });
  if (r.twaDeg != null && r.tack) {
    const tack = r.tack === 'starboard' ? 'stbd' : 'port';
    cells.push({ label: 'TWA', value: `${f0(r.twaDeg)}° ${tack} (est.)`, title: `True wind angle at the gun, ${r.tack} tack, from the estimated wind` });
  }
  if (r.dtlM != null) cells.push({ label: 'Dist. to line', value: `${f1(r.dtlM)} m`, title: 'Bow to the line at the gun, as the Start view shows it' });
  return cells;
}

/** The selected boat's readout as HTML; '' with no boat selected or no start figures. */
export function gunReadoutHtml(a: RaceAnalysis, highlight: string | null): string {
  const b = highlight ? a.boats.find((x) => x.id === highlight) : undefined;
  const r = b ? gunReadout(b) : null;
  const shown = r ? gunReadoutCells(r) : [];
  if (!b || !shown.length) return '';
  const cells = shown
    .map((c) => `<div class="gr-cell" title="${esc(c.title)}"><dt>${esc(c.label)}</dt><dd>${esc(c.value)}</dd></div>`)
    .join('');
  return `<p class="gr-head">#${esc(b.sail)} at the gun</p><dl class="gun-readout" aria-label="${esc(`#${b.sail} at the gun`)}">${cells}</dl>`;
}
