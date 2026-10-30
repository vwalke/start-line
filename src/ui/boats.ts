/**
 * The boat list beside the digest and the findings list. Both follow the one
 * shared selection (`highlight`) used by the charts and the table.
 */
import type { Finding, RaceAnalysis, StartCompare } from '../analysis/types';
import { boatColor, NC_COLOR } from './charts';
import { ACT, ACT_KEY, ACT_MORE, ACT_ROW } from './act';
import { esc } from './format';
import { UNOFFICIAL_PLACE, codeShort, codeWords, isTracker, unofficialNoteHtml } from './resultText';

/**
 * Boats set aside as not racing: a collapsed group under the competitors
 * (open while one of them is picked, or when `open`). Picking one draws it,
 * unranked; the footnote switches to keeping everyone as a competitor (`nc=all`).
 */
function notRacing(a: RaceAnalysis, highlight: string | null, open: boolean): string {
  if (a.allCompetitors) {
    const n = a.allCompetitors.flagged;
    return n
      ? `<p class="nc-note">Everyone shown as a competitor; ${n} boat${n > 1 ? 's look' : ' looks'} like ${n > 1 ? 'they are' : 'it is'} not racing. <button type="button" class="${ACT}" data-nc="auto">Hide ${n > 1 ? 'them' : 'it'}</button></p>`
      : '';
  }
  if (!a.excluded.length) return '';
  const items = a.excluded
    .map(({ result: b, reasons }) => {
      const named = b.name !== `#${b.sail}` && b.name !== b.sail;
      const why = reasons.join('; ');
      const label = `#${b.sail}${named ? ` ${b.name}` : ''}, not racing: ${why}`;
      return `<li><button type="button" class="boat-item nc ${ACT_ROW}" data-id="${esc(b.id)}" aria-pressed="${highlight === b.id}" aria-label="${esc(label)}" title="${esc(label)}">
        <i class="sw" style="background:${NC_COLOR}"></i><b class="sail ${ACT_KEY}">${esc(b.sail)}</b>${named ? `<span class="bname">${esc(b.name)}</span>` : ''}<span class="pos">—</span></button></li>`;
    })
    .join('');
  const isOpen = open || a.excluded.some((e) => e.result.id === highlight);
  return `<details class="nc-group"${isOpen ? ' open' : ''}><summary class="${ACT_MORE}">Not racing (${a.excluded.length})</summary>
    <ul class="boat-items">${items}</ul>
    <p class="nc-note">Coach boats and spare trackers; not ranked. <button type="button" class="${ACT}" data-nc="all">Show all as competitors</button></p></details>`;
}

/** Finish order; each entry toggles the shared selection. */
export function boatList(a: RaceAnalysis, highlight: string | null, ncOpen = false): string {
  const items = a.boats
    .map((b) => {
      const name = b.name !== `#${b.sail}` ? `<span class="bname">${esc(b.name)}</span>` : '';
      // An official code (DSQ, DNF…) when linked; "~" marks a place from the tracks' finish-line crossings.
      const tracker = isTracker(a, b);
      const pos = b.finishPos == null ? (codeShort(b) ?? 'DNF') : `${tracker ? '~' : ''}${b.finishPos}`;
      const how = b.finishCode ? codeWords(b) : b.finishPos == null ? 'did not finish' : `finished ${b.finishPos}${tracker ? `, ${UNOFFICIAL_PLACE}` : ''}`;
      // An uploaded boat log (data/vkx): a small tag, the full words in the label.
      const log = b.log ? `from boat log · ${b.log.rateHz} Hz` : '';
      const label = `#${b.sail}${b.name !== `#${b.sail}` ? ` ${b.name}` : ''}, ${how}${log ? `, ${log}` : ''}`;
      const tag = log ? `<span class="log-hz" title="${esc(log)}" aria-hidden="true">${b.log!.rateHz}</span>` : '';
      return `<li><button type="button" class="boat-item ${ACT_ROW}" data-id="${esc(b.id)}" aria-pressed="${highlight === b.id}" aria-label="${esc(label)}" title="${esc(label)}">
        <i class="sw" style="background:${boatColor(b, a.boats.length)}"></i><b class="sail ${ACT_KEY}">${esc(b.sail)}</b>${name}<span class="pos">${pos}${tag}</span></button></li>`;
    })
    .join('');
  return `<div class="boats-head"><h3 id="boats-title">Boats</h3><button type="button" class="boats-clear" data-clear${highlight ? '' : ' disabled'}>Clear</button></div>
    <ul class="boat-items" aria-labelledby="boats-title">${items}</ul>${unofficialNoteHtml(a.boats.some((b) => isTracker(a, b)))}${notRacing(a, highlight, ncOpen)}`;
}

/** The best and worst start side by side: a row per stat, a column per boat (the selected boat's column marked). */
export function startCompareHtml(c: StartCompare, highlight: string | null): string {
  const sides = [{ head: 'Best', x: c.best }, ...(c.worst ? [{ head: 'Worst', x: c.worst }] : [])];
  const on = (id: string): string => (id === highlight ? ' class="on"' : '');
  const head = sides.map(({ head, x }) => `<th scope="col"${on(x.id)}><span class="cmp-k">${head}</span> ${esc(x.tag)}</th>`).join('');
  const rows = c.rows.map((r, i) => `<tr><th scope="row">${esc(r)}</th>${sides.map(({ x }) => `<td${on(x.id)}>${esc(x.values[i])}</td>`).join('')}</tr>`).join('');
  const note = c.note ? `<p class="cmp-note">${esc(c.note)}</p>` : '';
  return `<table class="start-cmp" aria-label="${c.worst ? 'Best and worst start' : 'Best start'}"><thead><tr><td></td>${head}</tr></thead><tbody>${rows}</tbody></table>${note}`;
}

/** Findings; with a boat selected, the ones about it are marked and the rest dimmed. */
export function findingsList(findings: Finding[], highlight: string | null): string {
  return findings
    .map((f) => {
      const on = highlight != null && !!f.boatIds?.includes(highlight);
      const cls = highlight == null ? f.kind : `${f.kind} ${on ? 'hl' : 'dim'}`;
      return `<li class="${cls}">${f.compare ? startCompareHtml(f.compare, highlight) : esc(f.text)}</li>`;
    })
    .join('');
}
