/**
 * The page: search/pick an event → race, run the worker, render the digest.
 * Live data only: if the feed or proxy fails we say so, with a way to retry.
 */
import { splitFindings } from '../analysis/findings';
import { START_TRAIL_MS, type RaceAnalysis } from '../analysis/types';
import { currentDoc, defaultRace, listRaces } from '../data/racesense/adapter';
import { fetchLanding, fetchRegatta } from '../data/racesense/api';
import type { LandingEvent, RegattaResponse } from '../data/racesense/types';
import type { WorkerRequest, WorkerResponse } from '../worker';
import { boatList, findingsList } from './boats';
import { pickerOptions, matchCountLabel, searchKeyAction } from './eventSearch';
import {
  applyView,
  clearLastView,
  isTransientError,
  pickRace,
  readLastView,
  resolveStart,
  startTab,
  viewForRace,
  writeLastView,
  type StartPlan,
  type ViewState,
} from './lastView';
import { NC_ALL } from './params';
import { isNarrowStart, legLegend, legSplitCaption, mapBox, startFitBox, startScaleCaption, startSnapshot, trackMap, trackSogIndex } from './charts';
import { boatLabel, degLabel, duration, esc, f0, f1, gunTimeLine, localTime } from './format';
import { START_NAMES_KEY, parseStartNames, startNamesControls } from './labels';
import { biasCaption } from './startLine';
import { attachTopScroll } from './hscroll';
import { attachPanZoom } from './panzoom';
import { placesCaption, placesChart } from './places';
import { DEFAULT_TAB, TABS, parseTab, tabForKey, tabFromHash, withTabHash, type Tab } from './tabs';
import { startSogSeries, type StartSogSeries } from '../analysis/startSog';
import {
  START_SOG_WINDOW_KEY,
  parseStartSogWindow,
  secsLabel,
  startSogCaption,
  startSogChart,
  startSogControls,
  startSogHover,
  startSogLayout,
} from './startSog';
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
import { legsNotesHtml, legsTable, startNotesHtml, startTable, toggleSort, type SortState } from './table';
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
    startSog: $('start-sog-chart'),
    startSogTip: $('start-sog-tip'),
    startSogWindow: $('start-sog-window'),
    startSogCaption: $('start-sog-caption'),
    places: $('places-chart'),
    placesTip: $('places-tip'),
    placesCaption: $('places-caption'),
    startTable: $('start-table'),
    startTableTop: $('start-table-top'),
    startNotes: $('start-notes'),
    table: $('table'),
    tableTop: $('table-top'),
    legsNotes: $('legs-notes'),
    startFindings: $('start-findings'),
    startFindingsBox: $('start-findings-box'),
    findings: $('findings'),
    raceFindings: $('race-findings-card'),
    boats: $('boat-list'),
    warnings: $('warnings'),
    tabs: $('tabs'),
    tabBtn: { start: $('tab-start'), race: $('tab-race') } as Record<Tab, HTMLElement>,
    panel: { start: $('panel-start'), race: $('panel-race') } as Record<Tab, HTMLElement>,
  };

  /** The URL's race, else the last one viewed (recall.lastView), else the latest. */
  const saved = readLastView();
  const plan = resolveStart(location.search, saved);
  /** Start | Race: the URL hash, else the saved tab when restoring the saved view, else Start. */
  let tab: Tab = startTab(location.hash, plan, saved);
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
  /** The legs and start tables' sorts (null = finish order) and the map's leg filter; all reset per race. */
  let sort: SortState | null = null;
  let startSort: SortState | null = null;
  /** A scrollbar above each table, in step with the table's own. */
  const topScrolls = [
    attachTopScroll(els.startTableTop, els.startTableTop.firstElementChild as HTMLElement, els.startTable),
    attachTopScroll(els.tableTop, els.tableTop.firstElementChild as HTMLElement, els.table),
  ];
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
  let sogWindow = parseStartSogWindow(readPref(START_SOG_WINDOW_KEY));
  /** The speed-through-the-start series drawn last, for the hover. */
  let sogSeries: StartSogSeries | null = null;
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
    writeLastView({ v: 1, ...current, ...(allCompetitors ? { allCompetitors: true } : {}), leg: legSel, boat: highlight, sort, startSort, tab, savedAt: Date.now() });
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
    els.placesCaption.textContent = placesCaption(a);
    els.startTable.innerHTML = startTable(a, highlight, startSort);
    els.startNotes.innerHTML = startNotesHtml(a);
    els.table.innerHTML = legsTable(a, highlight, sort);
    els.legsNotes.innerHTML = legsNotesHtml(a);
    els.boats.innerHTML = boatList(a, highlight, ncOpen);
    const found = splitFindings(a.findings);
    els.startFindings.innerHTML = findingsList(found.start, highlight);
    els.startFindingsBox.hidden = !found.start.length;
    els.findings.innerHTML = findingsList(found.race, highlight);
    els.findings.hidden = !found.race.length;
    els.warnings.innerHTML = a.warnings.map((t) => `<li>${esc(t)}</li>`).join('');
    els.warnings.hidden = !a.warnings.length;
    els.raceFindings.hidden = !found.race.length && !a.warnings.length;
    els.digest.hidden = false;
    // Measured once the digest is showing (a hidden table has no width).
    for (const t of topScrolls) t.update();
    renderPlaces();
    renderStartSog();
  }

  /** Speed through the start, sized for its card's width (re-run on resize). */
  function renderStartSog(): void {
    const a = analysis;
    if (!a) return;
    sogSeries = startSogSeries(a, sogWindow);
    els.startSogWindow.innerHTML = startSogControls(sogWindow);
    els.startSog.innerHTML = startSogChart(a, highlight, sogWindow, { widthPx: els.startSog.clientWidth || undefined }, sogSeries);
    els.startSogCaption.textContent = startSogCaption(sogSeries, sogWindow);
    els.startSogTip.hidden = true;
  }

  /** The bump chart, sized for its card's width (re-run on resize). */
  function renderPlaces(): void {
    const a = analysis;
    if (!a) return;
    els.places.innerHTML = placesChart(a, highlight, { widthPx: els.places.clientWidth || undefined });
    els.placesTip.hidden = true;
  }

  /** Start chart + its scale note; re-run on pan/zoom without redrawing the rest. */
  function renderStart(): void {
    const a = analysis;
    if (!a) return;
    const widthPx = els.start.clientWidth || undefined;
    els.startScale.textContent = startScaleCaption(a, view, widthPx);
    // Names are placed for this zoom (zooming in spreads the boats and reveals more) and sized for this width.
    els.start.innerHTML = startSnapshot(a, highlight, view, startColour, { names: startNames, widthPx });
  }

  /** The Fit frame for the start chart's width class (narrow charts leave more room for the favoured-end label). */
  let fitNarrow = false;
  function fitStart(a: RaceAnalysis): void {
    const w = els.start.clientWidth;
    fitNarrow = isNarrowStart(w);
    fitBox = startFitBox(a, w || undefined);
    setView(fitView(fitBox));
  }
  /** Refit (back to Fit) when the visible chart has crossed into the other width class. */
  function refitStart(): void {
    const w = els.start.clientWidth;
    if (analysis && w && isNarrowStart(w) !== fitNarrow) fitStart(analysis);
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
  // Widths of the measured charts on the visible tab (a hidden panel measures 0: it is redrawn when shown).
  let startW = 0;
  let contentW = 0;
  addEventListener('resize', () => {
    if (!analysis) return;
    const pw = els.panel[tab].clientWidth;
    if (pw && pw !== contentW) {
      contentW = pw;
      if (tab === 'race') renderPlaces();
      else renderStartSog();
    }
    const w = els.start.clientWidth;
    if (!w || w === startW) return;
    startW = w;
    refitStart();
    setView(view);
  });

  /** Redraw what measures its width on tab `t` (now visible), and its table's top scrollbar. */
  function remeasure(t: Tab): void {
    if (!analysis) return;
    contentW = els.panel[t].clientWidth;
    if (t === 'start') {
      startW = els.start.clientWidth;
      refitStart();
      renderStart();
      renderStartSog();
      topScrolls[0].update();
    } else {
      renderPlaces();
      topScrolls[1].update();
    }
  }

  /** Show tab `t`: tab and panel state, the URL hash (replaced, not pushed), the saved view; redraw its charts. */
  function setTab(t: Tab, opts: { focus?: boolean; scroll?: boolean; boot?: boolean } = {}): void {
    const changed = t !== tab;
    tab = t;
    for (const k of TABS) {
      const on = k === t;
      els.tabBtn[k].setAttribute('aria-selected', String(on));
      els.tabBtn[k].tabIndex = on ? 0 : -1;
      els.panel[k].hidden = !on;
    }
    // At boot a link without a hash stays as it is on Start (a restored Race tab gets its hash).
    const keep = opts.boot && !location.hash && t === DEFAULT_TAB;
    if (!keep && tabFromHash(location.hash) !== t) history.replaceState(history.state, '', withTabHash(location.href, t));
    if (opts.focus) els.tabBtn[t].focus();
    remeasure(t);
    // Scrolled down past the panel's top: bring it to just under the (sticky) tabs.
    if (changed && opts.scroll !== false) {
      const top = els.panel[t].getBoundingClientRect().top;
      const under = els.tabs.getBoundingClientRect().bottom;
      if (top < under) scrollBy({ top: top - under - 4 });
    }
    if (changed) save();
  }
  els.tabs.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('[role="tab"]');
    const t = parseTab(btn?.id.replace(/^tab-/, ''));
    if (t) setTab(t);
  });
  els.tabs.addEventListener('keydown', (ev) => {
    const t = tabForKey(tab, ev.key);
    if (!t) return;
    ev.preventDefault();
    setTab(t, { focus: true });
  });
  addEventListener('hashchange', () => {
    const t = tabFromHash(location.hash);
    if (t && t !== tab) setTab(t);
  });
  setTab(tab, { scroll: false, boot: true });
  // On a phone the boat strip sticks to the top; the tabs stick just under it.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => els.digest.style.setProperty('--boatbar-h', `${els.boats.offsetHeight}px`)).observe(els.boats);
  }

  // Speed through the start: a crosshair and the speed under the pointer (the selected boat's, else the nearest line's).
  function showSogTip(ev: PointerEvent): void {
    const a = analysis;
    const svg = els.startSog.querySelector('svg');
    const hair = svg?.querySelector<SVGLineElement>('line.ss-hair');
    if (!a || !svg || !hair || !sogSeries) return;
    const L = startSogLayout(sogSeries, els.startSog.clientWidth || undefined);
    const rect = svg.getBoundingClientRect();
    const k = L.W / (rect.width || L.W);
    const px = (ev.clientX - rect.left) * k;
    const py = (ev.clientY - rect.top) * k;
    const h = startSogHover(sogSeries, L, px, py, highlight, ev.pointerType === 'mouse' ? 16 : 28);
    if (px < L.padL || px > L.W - L.padR || !h) {
      hair.setAttribute('visibility', 'hidden');
      els.startSogTip.hidden = true;
      return;
    }
    const x = L.x(h.tS).toFixed(1);
    hair.setAttribute('x1', x);
    hair.setAttribute('x2', x);
    hair.setAttribute('visibility', 'visible');
    els.startSogTip.innerHTML = `<b>${esc(boatLabel(a.boats.find((b) => b.id === h.id), h.id))}</b><br>${esc(secsLabel(h.tS))} from the gun: <b>${f1(h.sogKn)} kn</b>`;
    els.startSogTip.hidden = false;
    const wrap = els.startSogTip.parentElement!.getBoundingClientRect();
    const left = ev.clientX - wrap.left;
    const flip = left + 12 + els.startSogTip.offsetWidth > wrap.width;
    els.startSogTip.style.left = `${Math.max(0, flip ? left - 12 - els.startSogTip.offsetWidth : left + 12)}px`;
    els.startSogTip.style.top = `${Math.max(0, ev.clientY - wrap.top - els.startSogTip.offsetHeight - 10)}px`;
  }
  els.startSog.addEventListener('pointermove', showSogTip);
  els.startSog.addEventListener('pointerdown', showSogTip);
  els.startSog.addEventListener('pointerleave', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    els.startSogTip.hidden = true;
    els.startSog.querySelector('line.ss-hair')?.setAttribute('visibility', 'hidden');
  });
  els.startSog.addEventListener('click', (ev) => {
    const g = (ev.target as Element).closest('g.ss-boat[data-id]');
    // Only a line selects (a tap elsewhere reads the speed under it without changing the selection).
    if (g) toggleHighlight(g.getAttribute('data-id'));
  });
  els.startSogWindow.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-sog-window]');
    if (!btn) return;
    sogWindow = parseStartSogWindow(btn.getAttribute('data-sog-window'));
    writePref(START_SOG_WINDOW_KEY, String(sogWindow));
    const focus = focusSel(btn, 'data-sog-window');
    renderStartSog();
    if (focus) els.startSogWindow.querySelector<HTMLElement>(focus)?.focus();
  });

  // Place changes: a dot's place on hover or tap (beside it, as the map's tip); a click on a line, dot or name selects the boat.
  function showPlaceTip(ev: PointerEvent): void {
    const dot = (ev.target as Element).closest?.('circle.pc-dot[data-tip]');
    if (!dot) {
      els.placesTip.hidden = true;
      return;
    }
    els.placesTip.textContent = dot.getAttribute('data-tip');
    els.placesTip.hidden = false;
    const wrap = els.placesTip.parentElement!.getBoundingClientRect();
    const r = dot.getBoundingClientRect();
    const left = r.left + r.width / 2 - wrap.left;
    const flip = left + 12 + els.placesTip.offsetWidth > wrap.width;
    els.placesTip.style.left = `${Math.max(0, flip ? left - 12 - els.placesTip.offsetWidth : left + 12)}px`;
    els.placesTip.style.top = `${Math.max(0, r.top - wrap.top - els.placesTip.offsetHeight - 6)}px`;
  }
  els.places.addEventListener('pointermove', showPlaceTip);
  els.places.addEventListener('pointerdown', showPlaceTip);
  els.places.addEventListener('pointerleave', (ev) => {
    if (ev.pointerType === 'mouse') els.placesTip.hidden = true;
  });
  els.places.addEventListener('click', (ev) => {
    const g = (ev.target as Element).closest('g.pc-boat[data-id]');
    const tip = !els.placesTip.hidden ? els.placesTip.textContent : null;
    // Tapping empty chart clears the selection, as on the start chart.
    toggleHighlight(g ? g.getAttribute('data-id') : null);
    // A tap on a dot keeps its tip up after the redraw.
    if (tip && g && (ev.target as Element).closest('circle.pc-dot')) {
      els.placesTip.textContent = tip;
      els.placesTip.hidden = false;
    }
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
  // The two tables: each sorts on its own; a row selects the boat everywhere.
  for (const [wrap, which] of [
    [els.startTable, 'start'],
    [els.table, 'legs'],
  ] as const) {
    const toggleRow = (tr: Element): void => {
      const id = tr.getAttribute('data-id');
      highlight = highlight === id ? null : id;
      save();
      renderKeepingFocus(wrap, focusSel(tr, 'data-id'));
    };
    wrap.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('button[data-sort]');
      if (btn && analysis) {
        const key = btn.getAttribute('data-sort')!;
        if (which === 'start') startSort = toggleSort(analysis, startSort, key);
        else sort = toggleSort(analysis, sort, key);
        save();
        renderKeepingFocus(wrap, focusSel(btn, 'data-sort'));
        return;
      }
      const tr = (ev.target as HTMLElement).closest('tr[data-id]');
      if (tr) toggleRow(tr);
    });
    wrap.addEventListener('keydown', (ev) => {
      const tr = (ev.target as HTMLElement).closest('tr[data-id]');
      if (tr && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        toggleRow(tr);
      }
    });
  }
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
      startSort = v?.startSort ?? null;
      legSel = v?.leg ?? null;
      fitStart(a);
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
    const view = viewForRace(current, { eventId: id, division, raceNumber }, { leg: legSel, boat: highlight, sort, startSort }, restore);
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
