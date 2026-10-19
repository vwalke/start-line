/**
 * The page: search/pick an event → race, run the worker, render the digest.
 * Live data only: if the feed or proxy fails we say so, with a way to retry.
 */
import { START_TRAIL_MS, type RaceAnalysis } from '../analysis/types';
import { currentDoc, defaultRace, listRaces } from '../data/racesense/adapter';
import { fetchLanding, fetchRegatta } from '../data/racesense/api';
import type { LandingEvent, RegattaResponse } from '../data/racesense/types';
import type { WorkerRequest, WorkerResponse } from '../worker';
import { boatList, findingsList } from './boats';
import { pickerOptions, matchCountLabel, searchKeyAction } from './eventSearch';
import { applyView, clearLastView, isTransientError, pickRace, readLastView, resolveStart, viewForRace, writeLastView, type StartPlan, type ViewState } from './lastView';
import { NC_ALL } from './params';
import { legLegend, legSplitCaption, mapBox, startFitBox, startScaleCaption, startSnapshot, trackMap, trackSogIndex } from './charts';
import { degLabel, duration, esc, f0, f1, gunTimeLine, localTime } from './format';
import { START_NAMES_KEY, parseStartNames, startNamesControls } from './labels';
import { biasCaption } from './startLine';
import { attachPanZoom } from './panzoom';
import {
  START_COLOUR_KEY,
  hasGaps,
  nearestSample,
  segmentTimes,
  parseStartColour,
  sogHoverLeg,
  sogKey,
  sogLegKey,
  startColourControls,
  startSogRange,
  trackSogRange,
  type SogIndex,
} from './sog';
import {
  COLOUR_KEY,
  RANK_KEY,
  SOG_SCALE_KEY,
  TOP_KEY,
  colourControls,
  parseRankBy,
  parseSogScale,
  parseSpeedTop,
  parseTrackColour,
  readPref,
  speedKey,
  writePref,
} from './speed';
import { metricsTable, toggleSort, type SortState } from './table';
import { clampView, clientToChart, fitView, presetActive, type Box, type View } from './view';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

export function startApp(): void {
  const els = {
    search: $<HTMLInputElement>('event-search'),
    count: $('event-count'),
    event: $<HTMLSelectElement>('event'),
    race: $<HTMLSelectElement>('race'),
    notice: $('notice'),
    status: $('status'),
    digest: $('digest'),
    summary: $('summary'),
    start: $('start-chart'),
    startCaption: $('start-caption'),
    startScale: $('start-scale'),
    startZoom: $('start-zoom'),
    startColour: $('start-colour'),
    startKey: $('start-speed-key'),
    map: $('map-chart'),
    mapTip: $('map-tip'),
    legend: $('map-legend'),
    colour: $('map-colour'),
    speedKey: $('map-speed-key'),
    mapSplit: $('map-split'),
    table: $('table'),
    findings: $('findings'),
    boats: $('boat-list'),
    warnings: $('warnings'),
  };

  /** The URL's race, else the last one viewed (recall.lastView), else the latest. */
  const plan = resolveStart(location.search, readLastView());
  const params = plan.params;
  const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  let reqId = 0;
  const pending = new Map<number, { resolve: (a: RaceAnalysis) => void; reject: (e: Error) => void }>();
  const SUPERSEDED = 'superseded';
  const isSuperseded = (e: unknown): boolean => e instanceof Error && e.message === SUPERSEDED;
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.id !== reqId) return; // a newer request superseded this one
    const p = pending.get(msg.id);
    if (msg.type === 'progress') setStatus(msg.message);
    else if (msg.type === 'done') p?.resolve(msg.analysis);
    else p?.reject(new Error(msg.message));
    if (msg.type !== 'progress') pending.delete(msg.id);
  };
  const run = (req: DistributiveOmit<WorkerRequest, 'id'>): Promise<RaceAnalysis> =>
    new Promise((resolve, reject) => {
      const id = ++reqId;
      for (const p of pending.values()) p.reject(new Error(SUPERSEDED));
      pending.clear();
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id } as WorkerRequest);
    });

  let analysis: RaceAnalysis | null = null;
  /** The one selected boat, shared by the boat list, both charts, the table and the findings. */
  let highlight: string | null = null;
  /** Table sort (null = finish order) and the map's leg filter; both reset per race. */
  let sort: SortState | null = null;
  let legSel: number | null = null;
  /** `nc=all`: keep coach/spare boats as competitors (re-analyses when toggled). */
  let allCompetitors = !!params.allCompetitors;
  /** The sidebar's "Not racing" group, kept open across re-renders once opened. */
  let ncOpen = false;
  /** Map colouring: a viewing preference kept across races and visits (not in the URL). */
  let trackColour = parseTrackColour(readPref(COLOUR_KEY));
  let rankBy = parseRankBy(readPref(RANK_KEY));
  let speedTop = parseSpeedTop(readPref(TOP_KEY));
  let startColour = parseStartColour(readPref(START_COLOUR_KEY));
  let startNames = parseStartNames(readPref(START_NAMES_KEY));
  let sogScale = parseSogScale(readPref(SOG_SCALE_KEY));
  /** Boat speed hover: the map's box and fix lookup, built on first hover after each render. */
  let hover: { box: Box; ix: SogIndex } | null = null;
  let fitBox: Box | null = null;
  let view: View = { cx: 0, cy: 0, k: 1 };
  let regatta: RegattaResponse | null = null;
  /** The event whose races are loaded (and shown in the digest); '' until one loads. */
  let eventId = '';
  /** Every listed event, most recent first; the search filters this. */
  let events: LandingEvent[] = [];
  let matchCount = 0;
  /** The race on screen (null until one loads); what recall.lastView records. */
  let current: { eventId: string; division: string; raceNumber: number } | null = null;

  /** Record the race on screen and how it's viewed, so a relaunch can come back to it. */
  function save(): void {
    if (!current || !analysis) return;
    // A load that has swapped `analysis` but not yet `current` (or the reverse) must not mix them.
    if (analysis.meta.division !== current.division || analysis.meta.raceNumber !== current.raceNumber) return;
    if (analysis.meta.eventId != null && analysis.meta.eventId !== current.eventId) return;
    writeLastView({ v: 1, ...current, ...(allCompetitors ? { allCompetitors: true } : {}), leg: legSel, boat: highlight, sort, savedAt: Date.now() });
  }

  /** Forget the saved race and take it out of the URL. */
  function forget(): void {
    clearLastView();
    current = null;
    allCompetitors = false;
    setUrl({ event: null, div: null, race: null, nc: null });
  }

  function setStatus(text: string): void {
    els.status.textContent = text;
    els.status.hidden = !text;
  }

  function setNotice(text: string, action?: { label: string; run: () => void }): void {
    els.notice.textContent = text;
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      btn.addEventListener('click', action.run, { once: true });
      els.notice.append(' ', btn);
    }
    els.notice.hidden = !text;
  }

  function setUrl(next: Record<string, string | null>): void {
    const u = new URL(location.href);
    for (const [k, v] of Object.entries(next)) {
      if (v == null) u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    history.replaceState(null, '', u);
  }

  function render(): void {
    const a = analysis;
    if (!a) return;
    const m = a.meta;
    const w = a.wind;
    const windText =
      w.method === 'tacks'
        ? `Wind est. ${w.estimates.map((e) => degLabel(e.twdDeg)).join(' → ')} from tack headings`
        : w.method === 'model'
          ? `Wind ${degLabel(w.twdAtGunDeg)} from the weather model`
          : `Wind assumed ${degLabel(w.twdAtGunDeg)} (first leg dead upwind)`;
    const model = w.model && w.method === 'tacks' ? ` · model ${degLabel(w.model.dirAtGunDeg)}` : '';
    els.summary.innerHTML = `<h2>${esc(m.eventName)} · ${esc(m.boatClass)} · Race ${m.raceNumber}</h2>
      <p>${esc(gunTimeLine(m.gunMs, m.tzOffsetMs))} ·
      ${a.boats.length} boats · ${a.legs.map((l) => esc(l.name)).join(', ')} ·
      <span title="No wind sensor on the boats: estimated from the fleet's steady upwind headings">${windText}${model}</span> ·
      <span class="muted">${esc(m.sourceLabel)}</span></p>`;
    els.startCaption.textContent = `Line ${f0(a.line.lengthM)} m, bearing ${degLabel(a.line.bearingDeg)}; ${biasCaption(a)}; dashed: the line continued past each end. Bows at the gun (Vakaros timing) with the last ${START_TRAIL_MS / 1000} s of track shifted to the bow. Labels are distance behind the line${a.boats.some((b) => b.start?.rcDtlM != null) ? " (the boat's Vakaros DTL from the feed)" : ''}.${startColour === 'speed' ? ' Colour: Speed shades each trail by speed over ground (4 s mean) and each hull by its SOG at the gun; hover a boat for the figure.' : ''}`;
    renderStart();
    els.startColour.innerHTML = startColourControls(startColour) + startNamesControls(startNames);
    els.startKey.innerHTML =
      startColour === 'speed'
        ? sogKey(startSogRange(a), `Last ${START_TRAIL_MS / 1000} s before the gun; hulls at the gun`, hasGaps(a.drawings.map((d) => d.trail.t)))
        : '';
    els.startKey.hidden = startColour !== 'speed';
    els.map.innerHTML = trackMap(a, highlight, legSel, { colour: trackColour, rankBy, top: speedTop, sogScale });
    hover = null;
    els.mapTip.hidden = true;
    els.legend.innerHTML = legLegend(a, legSel);
    // In Rank or Boat speed the leg swatches would read as a colour key for the tracks; the buttons stay, the swatches go.
    els.legend.classList.toggle('speed', trackColour !== 'leg');
    els.colour.innerHTML = colourControls(trackColour, rankBy, legSel, speedTop, sogScale);
    els.speedKey.innerHTML =
      trackColour === 'rank'
        ? speedKey(a, legSel, rankBy, speedTop, highlight)
        : trackColour === 'sog'
          ? legSel == null && sogScale === 'leg'
            ? sogLegKey(a, hasGaps(segmentTimes(a, null)))
            : sogKey(trackSogRange(a, legSel), legSel == null ? 'Whole race' : `${a.legs[legSel]?.name ?? 'This leg'}`, hasGaps(segmentTimes(a, legSel)))
          : '';
    els.speedKey.hidden = trackColour === 'leg';
    els.mapSplit.textContent = legSplitCaption(a);
    els.table.innerHTML = metricsTable(a, highlight, sort);
    els.boats.innerHTML = boatList(a, highlight, ncOpen);
    els.findings.innerHTML = findingsList(a.findings, highlight);
    els.warnings.innerHTML = a.warnings.map((t) => `<li>${esc(t)}</li>`).join('');
    els.warnings.hidden = !a.warnings.length;
    els.digest.hidden = false;
  }

  /** Start chart + its scale note; re-run on pan/zoom without redrawing the rest. */
  function renderStart(): void {
    const a = analysis;
    if (!a) return;
    els.startScale.textContent = startScaleCaption(a, view);
    // Names are placed for this zoom (zooming in spreads the boats and reveals more) and sized for this width.
    els.start.innerHTML = startSnapshot(a, highlight, view, startColour, { names: startNames, widthPx: els.start.clientWidth || undefined });
  }

  /** Boat speed: the nearest drawn fix under the pointer (the selected boat's, within 40 px; else anyone's within 8 px). */
  function showHover(ev: PointerEvent): void {
    const a = analysis;
    const svg = els.map.querySelector('svg');
    if (!a || trackColour !== 'sog' || !svg) return;
    if (!hover) {
      const box = mapBox(a, legSel);
      hover = { box, ix: trackSogIndex(a, legSel) };
    }
    const { box, ix } = hover;
    const rect = svg.getBoundingClientRect();
    const [x, y] = clientToChart(box, fitView(box), rect, ev.clientX, ev.clientY);
    const px = 1 / (Math.min(rect.width / (box.x1 - box.x0), rect.height / (box.y1 - box.y0)) || 1);
    const i = nearestSample(ix, x, y, (highlight ? 40 : 8) * px, highlight);
    let dot = svg.querySelector<SVGCircleElement>('circle.sog-hover');
    if (i < 0) {
      dot?.remove();
      els.mapTip.hidden = true;
      return;
    }
    if (!dot) {
      dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('class', 'sog-hover');
      svg.append(dot);
    }
    dot.setAttribute('cx', String(ix.x[i]));
    dot.setAttribute('cy', String(ix.y[i]));
    dot.setAttribute('r', String(4 * px));
    dot.setAttribute('stroke-width', String(1.5 * px));
    const b = a.boats.find((q) => q.id === ix.ids[ix.boat[i]]);
    const who = b ? `#${b.sail}${b.name !== `#${b.sail}` ? ` ${b.name}` : ''}` : ix.ids[ix.boat[i]];
    els.mapTip.innerHTML = `<b>${esc(who)}</b><br>${localTime(ix.t[i], a.meta.tzOffsetMs)} <span class="muted">(gun +${duration((ix.t[i] - a.meta.gunMs) / 1000)})</span><br><b>${f1(ix.sog[i])} kn</b> SOG<br><span class="muted">${esc(sogHoverLeg(a, ix.leg[i], legSel, sogScale))}</span>`;
    els.mapTip.hidden = false;
    // Beside the pointer, flipped to the left near the right edge.
    const wrap = els.mapTip.parentElement!.getBoundingClientRect();
    const left = ev.clientX - wrap.left;
    const flip = left + 12 + els.mapTip.offsetWidth > wrap.width;
    els.mapTip.style.left = `${flip ? left - 12 - els.mapTip.offsetWidth : left + 12}px`;
    els.mapTip.style.top = `${Math.max(0, ev.clientY - wrap.top - els.mapTip.offsetHeight - 10)}px`;
  }
  function hideHover(): void {
    els.map.querySelector('circle.sog-hover')?.remove();
    els.mapTip.hidden = true;
  }
  let hoverFrame = 0;
  let hoverEv: PointerEvent | null = null;
  const queueHover = (ev: PointerEvent): void => {
    if (trackColour !== 'sog') return;
    hoverEv = ev;
    if (!hoverFrame) {
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        if (hoverEv) showHover(hoverEv);
      });
    }
  };
  els.map.addEventListener('pointermove', queueHover);
  els.map.addEventListener('pointerdown', queueHover);
  els.map.addEventListener('pointerleave', () => {
    hoverEv = null;
    hideHover();
  });

  let frame = 0;
  /** Store the start view, sync presets and touch-action now, redraw on the next frame. */
  function setView(v: View): void {
    if (!fitBox) return;
    view = clampView(fitBox, v);
    for (const b of els.startZoom.querySelectorAll('button[data-zoom]')) {
      b.setAttribute('aria-pressed', String(presetActive(fitBox, view, Number(b.getAttribute('data-zoom')))));
    }
    els.start.classList.toggle('zoomed', view.k > 1);
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        renderStart();
      });
    }
  }

  els.startZoom.addEventListener('click', (ev) => {
    const btn = (ev.target as Element).closest('button[data-zoom]');
    if (!btn || !fitBox) return;
    const next = Number(btn.getAttribute('data-zoom'));
    if (!Number.isFinite(next) || next <= 0) return;
    // Presets zoom about the current centre; Fit resets it.
    setView(next === 1 ? fitView(fitBox) : { ...view, k: next });
  });

  attachPanZoom(els.start, {
    getBox: () => fitBox,
    getView: () => view,
    setView,
    getRect: () => (els.start.querySelector('svg') ?? els.start).getBoundingClientRect(),
  });

  // Names are sized for the chart's width: redraw when it changes (rotation, window resize).
  let startW = 0;
  addEventListener('resize', () => {
    const w = els.start.clientWidth;
    if (w === startW || !analysis) return;
    startW = w;
    setView(view);
  });

  /** Re-render, then put keyboard focus back on the rebuilt control matching `selector` (if focus was in it). */
  function renderKeepingFocus(container: HTMLElement, selector: string | null): void {
    render();
    if (selector) container.querySelector<HTMLElement>(selector)?.focus();
  }
  const focusSel = (el: Element, attr: string): string | null =>
    el.contains(document.activeElement) ? `[${attr}="${CSS.escape(el.getAttribute(attr) ?? '')}"]` : null;

  function toggleHighlight(id: string | null): void {
    highlight = highlight === id ? null : id;
    render();
    save();
  }
  function toggleRow(tr: Element): void {
    const id = tr.getAttribute('data-id');
    highlight = highlight === id ? null : id;
    save();
    renderKeepingFocus(els.table, focusSel(tr, 'data-id'));
  }
  els.table.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-sort]');
    if (btn && analysis) {
      sort = toggleSort(analysis, sort, btn.getAttribute('data-sort')!);
      save();
      renderKeepingFocus(els.table, focusSel(btn, 'data-sort'));
      return;
    }
    const tr = (ev.target as HTMLElement).closest('tr[data-id]');
    if (tr) toggleRow(tr);
  });
  els.table.addEventListener('keydown', (ev) => {
    const tr = (ev.target as HTMLElement).closest('tr[data-id]');
    if (tr && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      toggleRow(tr);
    }
  });
  els.boats.addEventListener('click', (ev) => {
    const el = ev.target as HTMLElement;
    const item = el.closest('button[data-id]');
    if (item) {
      const id = item.getAttribute('data-id');
      highlight = highlight === id ? null : id;
      save();
      renderKeepingFocus(els.boats, focusSel(item, 'data-id'));
    } else if (el.closest('button[data-clear]')) {
      const hadFocus = el.closest('button[data-clear]')!.contains(document.activeElement);
      highlight = null;
      save();
      // Clear disables itself once nothing is selected; keep keyboard focus in the list.
      renderKeepingFocus(els.boats, hadFocus ? 'button[data-id]' : null);
    } else if (el.closest('button[data-nc]')) {
      // Keep everyone as a competitor (`nc=all`), or go back to setting coach/spare boats aside: a fresh analysis.
      allCompetitors = el.closest('button[data-nc]')!.getAttribute('data-nc') === 'all';
      setUrl({ nc: allCompetitors ? NC_ALL : null });
      save();
      const [div, n] = els.race.value.split('|');
      if (div && n) void loadRace(div, Number(n));
    }
  });
  // `toggle` doesn't bubble: listen in the capture phase for the "Not racing" group.
  els.boats.addEventListener(
    'toggle',
    (ev) => {
      if ((ev.target as HTMLElement).matches?.('details.nc-group')) ncOpen = (ev.target as HTMLDetailsElement).open;
    },
    true,
  );
  els.legend.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-leg]');
    if (!btn) return;
    const key = btn.getAttribute('data-leg');
    const leg = key === 'all' ? null : Number(key);
    legSel = leg == null || leg === legSel ? null : leg;
    save();
    renderKeepingFocus(els.legend, focusSel(btn, 'data-leg'));
  });
  els.colour.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-colour], button[data-rank], button[data-top], button[data-sog-scale]');
    if (!btn) return;
    const colour = btn.getAttribute('data-colour');
    const top = btn.getAttribute('data-top');
    const scale = btn.getAttribute('data-sog-scale');
    let attr = 'data-rank';
    if (scale != null) {
      sogScale = parseSogScale(scale);
      writePref(SOG_SCALE_KEY, sogScale);
      attr = 'data-sog-scale';
    } else if (colour != null) {
      trackColour = parseTrackColour(colour);
      writePref(COLOUR_KEY, trackColour);
      attr = 'data-colour';
    } else if (top != null) {
      speedTop = parseSpeedTop(top);
      writePref(TOP_KEY, String(speedTop));
      attr = 'data-top';
    } else {
      rankBy = parseRankBy(btn.getAttribute('data-rank'));
      writePref(RANK_KEY, rankBy);
    }
    renderKeepingFocus(els.colour, focusSel(btn, attr));
  });
  els.startColour.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-start-colour]');
    if (!btn) return;
    startColour = parseStartColour(btn.getAttribute('data-start-colour'));
    writePref(START_COLOUR_KEY, startColour);
    renderKeepingFocus(els.startColour, focusSel(btn, 'data-start-colour'));
  });
  els.startColour.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-start-names]');
    if (!btn) return;
    startNames = parseStartNames(btn.getAttribute('data-start-names'));
    writePref(START_NAMES_KEY, startNames);
    renderKeepingFocus(els.startColour, focusSel(btn, 'data-start-names'));
  });
  els.start.addEventListener('click', (ev) => {
    const g = (ev.target as Element).closest('g.boat[data-id]');
    toggleHighlight(g ? g.getAttribute('data-id') : null);
  });

  let showGen = 0;
  /** Show an analysis with leg/boat/sort reset, or set from `restore` (dropping what this race lacks). False if superseded. */
  async function show(p: Promise<RaceAnalysis>, restore?: ViewState): Promise<boolean> {
    const g = ++showGen;
    els.digest.classList.add('loading');
    try {
      const a = await p;
      if (g !== showGen) return false;
      analysis = a;
      const v = restore ? applyView(a, restore) : null;
      highlight = v?.boat ?? null;
      ncOpen = false;
      sort = v?.sort ?? null;
      legSel = v?.leg ?? null;
      fitBox = startFitBox(a);
      setView(fitView(fitBox));
      render();
      setStatus('');
      return true;
    } finally {
      if (g === showGen) els.digest.classList.remove('loading');
    }
  }

  type RaceLoad = 'ok' | 'superseded' | Error;
  /** Analyse and show a race of the loaded event; on failure the notice says so (the picker stays usable). */
  async function loadRace(division: string, raceNumber: number, restore?: ViewState): Promise<RaceLoad> {
    if (!regatta) return new Error('no event loaded');
    const id = eventId;
    // Don't replaceState until this race is on screen: a kill mid-switch keeps the last
    // successful race in both the URL and recall.lastView (and not the half-switched one).
    const view = viewForRace(current, { eventId: id, division, raceNumber }, { leg: legSel, boat: highlight, sort }, restore);
    try {
      const classLabel = events.find((e) => e.eventId === id)?.classLabel;
      if (!(await show(run({ type: 'live', eventId: id, regatta, division, raceNumber, allCompetitors, classLabel }), view))) return 'superseded';
      current = { eventId: id, division, raceNumber };
      setUrl({ event: id, div: division, race: String(raceNumber), nc: allCompetitors ? NC_ALL : null });
      save();
      setNotice('');
      return 'ok';
    } catch (e) {
      if (isSuperseded(e)) return 'superseded';
      setStatus('');
      // Keep the event/race picker so another race can be tried.
      setNotice(`Couldn't load that race (${(e as Error).message}).`);
      return e as Error;
    }
  }

  /** Rebuild the Event select from the search query, keeping the loaded event selected. */
  function renderEventOptions(): void {
    const q = els.search.value;
    const { options, matches } = pickerOptions(events, q, eventId);
    matchCount = matches.length;
    // Nothing loaded yet: a placeholder, so picking the first event still fires `change`.
    const placeholder = eventId ? '' : '<option value="" disabled selected>Choose an event…</option>';
    els.event.innerHTML = placeholder + options.map((o) => `<option value="${esc(o.eventId)}">${esc(o.label)}</option>`).join('');
    if (eventId) els.event.value = eventId;
    els.count.textContent = matchCountLabel(matchCount, events.length, q);
    els.count.classList.toggle('none', q.trim() !== '' && matchCount === 0);
  }

  let eventReq = 0;
  /** 'empty': no finished races; 'missing': a strict (restore) `want` isn't listed; an Error: the race failed to load. */
  type EventLoad = RaceLoad | 'empty' | 'missing';
  /**
   * Load an event and its default (or wanted) race. With `opts.strict` (a restore) a missing wanted
   * race is reported, never swapped for another; `opts.view` applies only if the wanted race opens.
   */
  async function loadEvent(
    id: string,
    want?: { division: string; raceNumber: number },
    opts: { strict?: boolean; view?: ViewState } = {},
  ): Promise<EventLoad> {
    const req = ++eventReq;
    setStatus('Loading event…');
    try {
      const next = await fetchRegatta(id);
      if (req !== eventReq) return 'superseded'; // a newer pick
      const doc = currentDoc(next);
      const races = listRaces(doc).filter((r) => r.finishers > 0);
      if (!races.length) return 'empty';
      const pick = pickRace(races, want, defaultRace(doc), opts.strict);
      if (!pick) return 'missing';
      regatta = next;
      eventId = id;
      renderEventOptions();
      els.race.innerHTML = races
        .map((r) => `<option value="${esc(r.division)}|${r.raceNumber}">${esc(r.division)} · Race ${r.raceNumber}</option>`)
        .join('');
      els.race.value = `${pick.division}|${pick.raceNumber}`;
      els.race.disabled = false;
      const wanted = want && pick.division === want.division && pick.raceNumber === want.raceNumber;
      return await loadRace(pick.division, pick.raceNumber, wanted ? opts.view : undefined);
    } catch (e) {
      if (req !== eventReq) return 'superseded';
      throw e;
    }
  }

  const titleOf = (id: string): string => events.find((e) => e.eventId === id)?.title ?? id;

  /** A user pick (select, or Enter in the search). On failure the select goes back to the loaded event. */
  function pickEvent(id: string): void {
    if (!id || id === eventId) return;
    loadEvent(id).then(
      (r) => {
        if (r !== 'empty') return;
        setStatus(`${titleOf(id)} has no finished races yet.`);
        renderEventOptions();
      },
      (e: Error) => {
        setStatus(`Couldn't load ${titleOf(id)}: ${e.message}`);
        renderEventOptions();
      },
    );
  }

  els.event.addEventListener('change', () => pickEvent(els.event.value));
  els.race.addEventListener('change', () => {
    const [div, n] = els.race.value.split('|');
    void loadRace(div, Number(n));
  });

  // Typing only filters; it never loads an event (each load fetches telemetry).
  els.search.addEventListener('input', renderEventOptions);
  els.search.addEventListener('keydown', (ev) => {
    if (ev.isComposing || ev.key === 'Process') return;
    const action = searchKeyAction(ev.key, els.search.value, matchCount);
    if (action === 'clear') {
      ev.preventDefault();
      els.search.value = '';
      renderEventOptions();
    } else if (action === 'pick') {
      ev.preventDefault();
      const only = pickerOptions(events, els.search.value, '').matches[0];
      if (only) {
        els.event.value = only.eventId;
        pickEvent(only.eventId);
      }
    }
  });
  // "/" jumps to the search, as on many sites, unless the user is typing or choosing somewhere.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || els.search.disabled) return;
    const t = ev.target as HTMLElement | null;
    if (t?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || document.querySelector('dialog[open]')) return;
    ev.preventDefault();
    els.search.focus();
    els.search.select();
  });

  async function boot(): Promise<void> {
    setNotice('');
    try {
      setStatus('Loading events…');
      // /api/landing returns every listed event in one response (no pagination), so
      // filtering this list client-side searches the whole feed, as RaceSense's own page does.
      const landing = await fetchLanding();
      const now = Date.now();
      const recency = (e: LandingEvent): number => (e.capturedRaceTime ? Date.parse(e.capturedRaceTime) : Math.min(e.endMs, now));
      events = landing.events.filter((e) => e.startMs <= now).sort((a, b) => recency(b) - recency(a));
    } catch (e) {
      setStatus('');
      els.event.innerHTML = '<option>—</option>';
      setNotice(`Couldn't load the live race list (${(e as Error).message}).`, { label: 'Retry', run: () => void boot() });
      return;
    }
    const explicit = params.eventId;
    if (explicit && !events.some((e) => e.eventId === explicit)) {
      events.unshift({ eventId: explicit, title: explicit, startMs: 0, endMs: 0 });
    }
    renderEventOptions();
    els.event.disabled = false;
    els.search.disabled = false;
    // Pointer devices only (no on-screen keyboard popping up), and never steal focus the user already moved.
    const ae = document.activeElement;
    if (matchMedia('(pointer: fine)').matches && (!ae || ae === document.body || ae === document.documentElement)) {
      els.search.focus();
    }
    if (plan.source === 'saved') return reopenSaved(plan);
    if (explicit) {
      els.event.value = explicit;
      try {
        // Reloading the saved race's own URL keeps its leg/boat/sort too.
        if ((await loadEvent(explicit, params.want, { view: plan.source === 'url' ? plan.view : undefined })) !== 'empty') return;
        setStatus('');
        setNotice(`${titleOf(explicit)} has no finished races yet. Pick another event.`);
      } catch (e) {
        setStatus('');
        setNotice(`Couldn't load event ${explicit} (${(e as Error).message}). Pick another event.`);
      }
      return;
    }
    return openLatest(params.want);
  }

  /** The most recent event that has a finished race (polite: at most 4 tries). */
  async function openLatest(want?: { division: string; raceNumber: number }): Promise<void> {
    for (const e of events.slice(0, 4)) {
      els.event.value = e.eventId;
      try {
        if ((await loadEvent(e.eventId, want)) !== 'empty') return;
      } catch {
        // try the next one
      }
    }
    els.event.value = '';
    setStatus('');
    setNotice('No finished race found in the most recent events. Search or pick an event above.');
  }

  /**
   * Boot with no race in the URL: reopen the last race viewed, with its leg/boat/sort. If it can't be
   * reopened (gone, no longer listed, analysis fails) forget it and show the latest race; a network
   * failure keeps it, with Retry, so a flaky connection doesn't lose it.
   */
  async function reopenSaved(p: Extract<StartPlan, { source: 'saved' }>): Promise<void> {
    const { eventId: id, want } = p.params;
    els.event.value = id;
    let r: EventLoad;
    try {
      r = await loadEvent(id, want, { strict: true, view: p.view });
    } catch (e) {
      r = e as Error;
    }
    if (r === 'superseded') return;
    if (r === 'ok') {
      setNotice('Reopened your last race.', {
        label: 'Latest race',
        run: () => {
          forget();
          setNotice('');
          void openLatest();
        },
      });
      return;
    }
    setStatus('');
    if (r instanceof Error && (isTransientError(r.message) || navigator.onLine === false)) {
      setNotice(`Couldn't reopen your last race (${r.message}).`, {
        label: 'Retry',
        run: () => {
          setNotice('');
          void reopenSaved(p);
        },
      });
      return;
    }
    const why =
      r === 'empty'
        ? 'that event has no finished races'
        : r === 'missing'
          ? `${want.division} race ${want.raceNumber} is no longer listed`
          : r.message;
    forget();
    await openLatest();
    // Unless the latest race had its own trouble to report.
    if (els.notice.hidden) setNotice(`Couldn't reopen your last race (${why}). Showing the latest race.`);
  }

  // Leaving the app: make sure the last state is on disk (iOS may evict a backgrounded web app).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  addEventListener('pagehide', save);
  // Back from the bfcache: the page (and its state) is intact; just re-sync the URL and the record.
  addEventListener('pageshow', (ev: PageTransitionEvent) => {
    if (!ev.persisted || !current) return;
    setUrl({ event: current.eventId, div: current.division, race: String(current.raceNumber), nc: allCompetitors ? NC_ALL : null });
    save();
  });

  // `?demo=` is retired (live data only); drop it from old links and open the normal list.
  if (new URLSearchParams(location.search).has('demo')) setUrl({ demo: null });
  void boot();
}
