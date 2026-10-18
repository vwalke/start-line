/**
 * The boat list beside the digest and the findings list. Both follow the one
 * shared selection (`highlight`) used by the charts and the table.
 */
import type { Finding, RaceAnalysis } from '../analysis/types';
import { boatColor, NC_COLOR } from './charts';
import { esc } from './format';

/**
 * Boats set aside as not racing: a collapsed group under the competitors
 * (open while one of them is picked, or when `open`). Picking one draws it,
 * unranked; the footnote switches to keeping everyone as a competitor (`nc=all`).
 */
function notRacing(a: RaceAnalysis, highlight: string | null, open: boolean): string {
  if (a.allCompetitors) {
    const n = a.allCompetitors.flagged;
    return n
      ? `<p class="nc-note">Everyone shown as a competitor; ${n} boat${n > 1 ? 's look' : ' looks'} like ${n > 1 ? 'they are' : 'it is'} not racing. <button type="button" class="linkish" data-nc="auto">Hide ${n > 1 ? 'them' : 'it'}</button></p>`
      : '';
  }
  if (!a.excluded.length) return '';
  const items = a.excluded
    .map(({ result: b, reasons }) => {
      const named = b.name !== `#${b.sail}` && b.name !== b.sail;
      const why = reasons.join('; ');
      const label = `#${b.sail}${named ? ` ${b.name}` : ''}, not racing: ${why}`;
      return `<li><button type="button" class="boat-item nc" data-id="${esc(b.id)}" aria-pressed="${highlight === b.id}" aria-label="${esc(label)}" title="${esc(label)}">
        <i class="sw" style="background:${NC_COLOR}"></i><b class="sail">${esc(b.sail)}</b>${named ? `<span class="bname">${esc(b.name)}</span>` : ''}<span class="pos">—</span></button></li>`;
    })
    .join('');
  const isOpen = open || a.excluded.some((e) => e.result.id === highlight);
  return `<details class="nc-group"${isOpen ? ' open' : ''}><summary>Not racing (${a.excluded.length})</summary>
    <ul class="boat-items">${items}</ul>
    <p class="nc-note">Coach boats and spare or second trackers, judged from their results and tracks; they don't count in any rank. <button type="button" class="linkish" data-nc="all">Show all as competitors</button></p></details>`;
}

/** Finish order; each entry toggles the shared selection. */
export function boatList(a: RaceAnalysis, highlight: string | null, ncOpen = false): string {
  const items = a.boats
    .map((b) => {
      const name = b.name !== `#${b.sail}` ? `<span class="bname">${esc(b.name)}</span>` : '';
      const pos = b.finishPos == null ? 'DNF' : String(b.finishPos);
      const label = `#${b.sail}${b.name !== `#${b.sail}` ? ` ${b.name}` : ''}, ${b.finishPos == null ? 'did not finish' : `finished ${pos}`}`;
      return `<li><button type="button" class="boat-item" data-id="${esc(b.id)}" aria-pressed="${highlight === b.id}" aria-label="${esc(label)}" title="${esc(label)}">
        <i class="sw" style="background:${boatColor(b, a.boats.length)}"></i><b class="sail">${esc(b.sail)}</b>${name}<span class="pos">${pos}</span></button></li>`;
    })
    .join('');
  return `<div class="boats-head"><h3 id="boats-title">Boats</h3><button type="button" class="boats-clear" data-clear${highlight ? '' : ' disabled'}>Clear</button></div>
    <ul class="boat-items" aria-labelledby="boats-title">${items}</ul>${notRacing(a, highlight, ncOpen)}`;
}

/** Findings; with a boat selected, the ones about it are marked and the rest dimmed. */
export function findingsList(findings: Finding[], highlight: string | null): string {
  return findings
    .map((f) => {
      const on = highlight != null && !!f.boatIds?.includes(highlight);
      const cls = highlight == null ? f.kind : `${f.kind} ${on ? 'hl' : 'dim'}`;
      return `<li class="${cls}">${esc(f.text)}</li>`;
    })
    .join('');
}
