/**
 * The boat Report's HTML (report.ts builds the model): one page, laid out for print on A4 and Letter
 * (style.css `@media print`: the app's chrome hidden, light colours whatever the theme, `@page` margins),
 * readable on screen in light and dark. A bar on screen only: back to the digest, Race | Regatta, and
 * Print / Save PDF (window.print). The track thumbnail is the race map's own SVG (charts.ts trackMap) at a
 * small size, the boat picked.
 *
 * `#report[data-state="ready"]` (the article's `data-state`, copied to the section by the app) once the Coach's
 * findings are in: what a screenshot waits for.
 */
import type { RaceAnalysis } from '../analysis/types';
import { trackMap } from './charts';
import { esc } from './format';
import { MISSING, type ReportField, type ReportLine, type ReportModel } from './report';

/** No boat selected: where to pick one (the Coach's own wording). */
export const REPORT_NO_BOAT = 'Pick a boat in the boat list to see its report.';

const warnMark = '<span class="rp-warn" aria-hidden="true">⚠ </span><span class="vh">Warning: </span>';
const missing = (v: string): string => (v === MISSING ? `<span class="rp-na" title="Not in the data">${MISSING}</span>` : esc(v));

function fieldsHtml(fs: readonly ReportField[], cls: string): string {
  const items = fs
    .map(
      (f) =>
        `<div class="rp-f${f.warn ? ' warn' : ''}"><dt>${esc(f.label)}</dt><dd>${f.warn && f.value !== MISSING ? warnMark : ''}${missing(f.value)}${f.note ? `<small>${esc(f.note)}</small>` : ''}</dd></div>`,
    )
    .join('');
  return `<dl class="rp-fields ${cls}">${items}</dl>`;
}

const GLYPH: Record<ReportLine['kind'], string> = { card: '', plus: '➕', ok: '✓', note: '·', warn: '⚠' };

function lineHtml(l: ReportLine): string {
  const n = l.kind === 'card' && l.n != null ? `<span class="rp-n" title="Coach finding ${l.n}">${l.n}</span>` : `<span class="rp-g" aria-hidden="true">${GLYPH[l.kind]}</span>`;
  const s = l.seconds ? ` <b class="rp-sec${l.kind === 'plus' ? ' good' : ''}">${esc(l.seconds)}</b>` : '';
  return `<li class="rp-line ${l.kind}">${n} ${esc(l.text)}${s}</li>`;
}

const linesHtml = (ls: readonly ReportLine[], empty: string): string =>
  ls.length ? `<ul class="rp-lines">${ls.map(lineHtml).join('')}</ul>` : `<p class="rp-muted">${esc(empty)}</p>`;

function legsHtml(m: ReportModel): string {
  if (!m.legs.length) return '<p class="rp-muted">No legs in this race.</p>';
  const head = ['Leg', 'Type', 'Place in → out', 'Change', 'Time', `vs ${m.groupLabel}`, 'SOG kn', 'VMG kn', 'Tacks / gybes', 'Side', 'Gate', 'Data'];
  const rows = m.legs
    .map(
      (l) =>
        `<tr${l.lowData ? ' class="low"' : ''}><th scope="row">${esc(l.name)}</th><td>${esc(l.type)}</td><td>${missing(l.places)}</td><td>${missing(l.change)}</td><td>${missing(l.time)}</td><td>${missing(l.vsGroup)}</td><td>${missing(l.sog)}</td><td>${missing(l.vmg)}</td><td>${missing(l.manoeuvres)}</td><td>${missing(l.side)}</td><td>${missing(l.gate)}</td><td>${l.lowData && l.coverage !== MISSING ? warnMark : ''}${missing(l.coverage)}</td></tr>`,
    )
    .join('');
  return `<table class="rp-table rp-legs-t"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <p class="rp-key">SOG / VMG: this boat / ${esc(m.groupLabel)} median. Places in the whole fleet (fixed fleet); ~ estimated or across a gap in the track.</p>`;
}

function coachHtml(m: ReportModel): string {
  const c = m.coach;
  const parts: string[] = [];
  if (c.penalty) {
    parts.push(`<div class="rp-penalty" data-code="${esc(c.penalty.code)}"><b class="rp-code">${esc(c.penalty.code)}</b> <b>${esc(c.penalty.title)}</b>${c.penalty.chips.length ? ` <span class="rp-chips">${c.penalty.chips.map(esc).join(' · ')}</span>` : ''}<p>${esc(c.penalty.sentence)}</p></div>`);
  }
  if (c.empty && !c.findings.length) parts.push(`<p class="rp-muted">${esc(c.empty)}</p>`);
  if (c.findings.length) {
    const head = c.rankedHead ? `<h4>${esc(c.rankedHead)}</h4>` : '';
    const li = c.findings
      .map(
        (f) =>
          `<li class="rp-finding" data-kind="${esc(f.kind)}"><b class="rp-ftitle">${esc(f.title)}</b> <b class="rp-sec">${esc(f.seconds)}</b>${f.warnings.length ? ` <span class="rp-cav">${warnMark}${esc(f.warnings.join(' · '))}</span>` : ''}<br><span class="rp-sent">${esc(f.sentence)}</span></li>`,
      )
      .join('');
    parts.push(`${head}<ol class="rp-findings">${li}</ol>`);
    if (c.totalS != null) parts.push(`<p class="rp-key">≈ ${Math.round(c.totalS)} s at stake over these findings (Coach's ranking, vs ${esc(m.groupLabel)}).</p>`);
  }
  const went = c.went.length ? `<ul class="rp-lines">${c.went.map((w) => `<li class="rp-line plus"><b class="rp-sec good">${esc(w.seconds)}</b> ${esc(w.text)}</li>`).join('')}</ul>` : '<p class="rp-muted">No clear gains on the top 3 in this race.</p>';
  const work = c.workOn.length ? `<ol class="rp-work">${c.workOn.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>` : '<p class="rp-muted">Nothing ranked to work on with this data.</p>';
  const ok =
    (c.ok.length ? `<p class="rp-ok"><b>Not the problem:</b> ${c.ok.map((t) => `✓ ${esc(t)}`).join(' · ')}</p>` : '') +
    ((c.notJudged ?? []).length ? `<p class="rp-ok"><b>Not judged:</b> ${c.notJudged.map(esc).join(' · ')}</p>` : '');
  const done = m.state === 'ready';
  return `${parts.join('')}
    <div class="rp-cols">
      <div><h4>Went well</h4>${done ? went : '<p class="rp-muted">…</p>'}</div>
      <div><h4>Work on</h4>${done ? work : '<p class="rp-muted">…</p>'}</div>
    </div>${ok}`;
}

/** The track thumbnail: the race map (Fit, colour by leg) with the boat picked; empty when it can't be drawn. */
export function reportThumb(a: RaceAnalysis, boat: string): string {
  try {
    return trackMap(a, boat, null, { colour: 'leg' });
  } catch {
    return '';
  }
}

function regattaHtml(m: ReportModel): string {
  const r = m.regatta;
  if (!r) return '<p class="rp-muted">Waiting for the races to be analysed…</p>';
  const rows = r.rows
    .map(
      (x) =>
        `<tr${x.low ? ' class="low"' : ''}><th scope="row">${esc(x.label)}</th><td>${missing(x.place)}</td><td>${missing(x.of)}</td><td>${missing(x.onWater)}</td><td>${x.low ? warnMark : ''}${missing(x.coverage)}</td><td>${missing(x.findings)}</td><td class="rp-muted">${esc(x.status)}</td></tr>`,
    )
    .join('');
  const table = `<table class="rp-table rp-regatta-t"><thead><tr><th scope="col">Race</th><th scope="col">Place</th><th scope="col">Of</th><th scope="col">On the water</th><th scope="col">Tracker</th><th scope="col">Findings · at stake</th><th scope="col"></th></tr></thead><tbody>${rows}</tbody></table>`;
  const status = `<p class="rp-key">${r.done} of ${r.total} races analysed${r.done < r.total ? ' (the rest are still being worked out)' : ''}. ⚠ low tracker data: counted less.</p>`;
  const pens = r.penalties.length ? `<h4>Penalties</h4><ul class="rp-lines">${r.penalties.map((p) => `<li class="rp-line warn"><span class="rp-g" aria-hidden="true">⚠</span> ${esc(p)}</li>`).join('')}</ul>` : '';
  const work = r.workOn.length
    ? `<ol class="rp-work">${r.workOn.map((w) => `<li><b>${esc(w.title)}</b>${w.score ? ` <b class="rp-sec">${esc(w.score)}</b>` : ''}<br><span class="rp-sent">${esc(w.why)}.</span>${w.tip ? ` <span class="rp-tip"><b>Tip</b> ${esc(w.tip)}</span>` : ''}</li>`).join('')}</ol>`
    : '<p class="rp-muted">Nothing that recurs yet.</p>';
  const went = r.went.length ? `<ul class="rp-lines">${r.went.map((w) => `<li class="rp-line plus"><b class="rp-sec good">${esc(w.seconds)}</b> ${esc(w.text)}</li>`).join('')}</ul>` : '<p class="rp-muted">No clear gains on the top 3 yet.</p>';
  const legs = r.legs.length ? `<h4>Legs by type</h4><ul class="rp-lines">${r.legs.map((l) => `<li class="rp-line note"><b>${esc(l.type)}</b> ${esc(l.text)}</li>`).join('')}</ul>` : '';
  return `${table}${status}${pens}<div class="rp-cols"><div><h4>Top 3 to work on</h4>${work}</div><div><h4>Went well</h4>${went}${legs}</div></div>`;
}

/** The screen-only bar: back, Race | Regatta, Print / Save PDF. */
function barHtml(m: ReportModel): string {
  const seg = (v: 'race' | 'regatta', label: string): string => `<button type="button" data-report-scope="${v}" aria-pressed="${m.scope === v}">${label}</button>`;
  return `<div class="rp-bar">
    <button type="button" class="rp-back" data-report-close>← Back to the digest</button>
    <div class="seg" role="group" aria-label="Report on">${seg('race', 'This race')}${seg('regatta', 'Regatta')}</div>
    <button type="button" class="rp-print" data-report-print${m.state === 'no-boat' ? ' disabled' : ''}>Print / Save PDF</button>
  </div>`;
}

export interface ReportViewOptions {
  /** The track thumbnail's SVG (reportThumb); '' or absent: none. */
  thumb?: string;
  /** "Generated" stamp in the footer (a date string); absent in tests. */
  stamp?: string;
}

/** The whole report. */
export function reportHtml(m: ReportModel, opts: ReportViewOptions = {}): string {
  const title = `${esc(m.event)} · ${esc(m.division)} · ${esc(m.race)}`;
  if (m.state === 'no-boat') {
    return `<article class="report" data-state="no-boat" aria-label="Boat report">${barHtml(m)}<header class="rp-head"><p class="rp-sub">${title}</p><h2>Boat report</h2></header><p class="rp-noboat">${esc(REPORT_NO_BOAT)}</p></article>`;
  }
  const boat = `${esc(m.sail)}${m.boatName ? ` <span class="rp-name">${esc(m.boatName)}</span>` : ''}`;
  const foot = `<footer class="rp-foot">Recall · unofficial · from public Vakaros RaceSense data${m.coach.findings.length || m.legs.length ? ` · compared with ${esc(m.groupLabel)}` : ''}${opts.stamp ? ` · ${esc(opts.stamp)}` : ''}</footer>`;
  const notes = m.notes.length ? `<section class="rp-sec-notes"><h3>Data and confidence</h3><ul>${m.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : '';
  const head = `<header class="rp-head"><p class="rp-sub">${title}</p><h2>${boat}</h2>${fieldsHtml(m.header, 'rp-hfields')}</header>`;
  if (m.scope === 'regatta') {
    return `<article class="report scope-regatta" data-state="${m.state}" data-boat="${esc(m.boatId ?? '')}" aria-label="Regatta report: ${esc(m.sail)}">${barHtml(m)}${head}
      <section class="rp-regatta"><h3>Regatta: every race</h3>${regattaHtml(m)}</section>${foot}</article>`;
  }
  const thumb = opts.thumb ? `<figure class="rp-thumb">${opts.thumb}<figcaption>Track, wind at the top · ${esc(m.sail)} picked</figcaption></figure>` : '';
  return `<article class="report scope-race" data-state="${m.state}" data-boat="${esc(m.boatId ?? '')}" aria-label="Boat report: ${esc(m.sail)}">${barHtml(m)}${head}
    <div class="rp-row">
      <section class="rp-start"><h3>Start</h3>${fieldsHtml(m.start, 'rp-sfields')}<p class="rp-verdict"><b>Start card:</b> ${lineHtml(m.startVerdict).replace(/^<li[^>]*>|<\/li>$/g, '')}</p></section>
      ${thumb}
    </div>
    <section class="rp-legs"><h3>Leg by leg</h3>${legsHtml(m)}</section>
    <div class="rp-cols">
      <section class="rp-round"><h3>Roundings and gates</h3>${linesHtml(m.roundings, 'Nothing measured at the marks.')}</section>
      <section class="rp-pen"><h3>Penalties</h3>${linesHtml(m.penalties, 'No penalties.')}</section>
    </div>
    <section class="rp-coach"><h3>Coach</h3>${coachHtml(m)}</section>
    ${notes}${foot}</article>`;
}
