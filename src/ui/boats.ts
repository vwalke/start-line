/**
 * The boat list beside the digest and the findings list. Both follow the one
 * shared selection (`highlight`) used by the charts and the table.
 */
import type { Finding, RaceAnalysis } from '../analysis/types';
import { boatColor } from './charts';
import { esc } from './format';

/** Finish order; each entry toggles the shared selection. */
export function boatList(a: RaceAnalysis, highlight: string | null): string {
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
    <ul class="boat-items" aria-labelledby="boats-title">${items}</ul>`;
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
