/**
 * The page: search/pick an event → race, run the worker, render the digest.
 * Live data only: if the feed or proxy fails we say so, with a way to retry.
 */
import { START_TRAIL_MS, type RaceAnalysis } from '../analysis/types';
import { currentDoc, defaultRace, listRaces } from '../data/racesense/adapter';
import { fetchLanding, fetchRegatta } from '../data/racesense/api';
import type { LandingEvent, RegattaResponse } from '../data/racesense/types';
import type { WorkerRequest, WorkerResponse } from '../worker';
import { classDims } from '../data/classes';
import { boatList, findingsList } from './boats';
import { pickerOptions, matchCountLabel, searchKeyAction } from './eventSearch';
import { parsePickerParams } from './params';
import { legLegend, legSplitCaption, startFitBox, startHullScale, startSnapshot, trackMap } from './charts';
import { degLabel, esc, f0, f2, gunTimeLine } from './format';
import { attachPanZoom } from './panzoom';
import { metricsTable, toggleSort, type SortState } from './table';
import { clampView, fitView, presetActive, type Box, type View } from './view';

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
    map: $('map-chart'),
    legend: $('map-legend'),
    mapSplit: $('map-split'),
    table: $('table'),
    findings: $('findings'),
    boats: $('boat-list'),
    warnings: $('warnings'),
  };

  const params = parsePickerParams(location.search);
  const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  let reqId = 0;
  const pending = new Map<number, { resolve: (a: RaceAnalysis) => void; reject: (e: Error) => void }>();
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
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id } as WorkerRequest);
    });

  let analysis: RaceAnalysis | null = null;
  /** The one selected boat, shared by the boat list, both charts, the table and the findings. */
  let highlight: string | null = null;
  /** Table sort (null = finish order) and the map's leg filter; both reset per race. */
  let sort: SortState | null = null;
  let legSel: number | null = null;
  let fitBox: Box | null = null;
  let view: View = { cx: 0, cy: 0, k: 1 };
  let regatta: RegattaResponse | null = null;
  /** The event whose races are loaded (and shown in the digest); '' until one loads. */
  let eventId = '';
  /** Every listed event, most recent first; the search filters this. */
  let events: LandingEvent[] = [];
  let matchCount = 0;

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
    const fav =
      a.line.favored === 'square'
        ? 'about square to the wind'
        : `${a.line.favored === 'left' ? 'pin' : 'RC'} end favoured by ≈${f0(a.line.favoredByM)} m`;
    els.startCaption.textContent = `Line ${f0(a.line.lengthM)} m, bearing ${degLabel(a.line.bearingDeg)}; ${fav} (est. wind). Bows at the gun (Vakaros timing) with the last ${START_TRAIL_MS / 1000} s of track shifted to the bow. Labels are distance behind the line${a.boats.some((b) => b.start?.rcDtlM != null) ? " (the boat's Vakaros DTL from the feed)" : ''}.`;
    renderStart();
    els.map.innerHTML = trackMap(a, highlight, legSel);
    els.legend.innerHTML = legLegend(a, legSel);
    els.mapSplit.textContent = legSplitCaption(a);
    els.table.innerHTML = metricsTable(a, highlight, sort);
    els.boats.innerHTML = boatList(a, highlight);
    els.findings.innerHTML = findingsList(a.findings, highlight);
    els.warnings.innerHTML = a.warnings.map((t) => `<li>${esc(t)}</li>`).join('');
    els.warnings.hidden = !a.warnings.length;
    els.digest.hidden = false;
  }

  /** Start chart + its scale note; re-run on pan/zoom without redrawing the rest. */
  function renderStart(): void {
    const a = analysis;
    if (!a) return;
    const dims = startHullScale(a, view);
    const cls = classDims(a.meta.boatClass) ? a.meta.boatClass : a.meta.division;
    els.startScale.textContent = dims
      ? `Hulls drawn to scale (${cls} ${f2(dims.loaM)} m). Hulls point along heading.`
      : 'Markers not to scale. Arrows follow course over ground.';
    els.start.innerHTML = startSnapshot(a, highlight, view);
  }

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
  }
  function toggleRow(tr: Element): void {
    const id = tr.getAttribute('data-id');
    highlight = highlight === id ? null : id;
    renderKeepingFocus(els.table, focusSel(tr, 'data-id'));
  }
  els.table.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-sort]');
    if (btn && analysis) {
      sort = toggleSort(analysis, sort, btn.getAttribute('data-sort')!);
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
      renderKeepingFocus(els.boats, focusSel(item, 'data-id'));
    } else if (el.closest('button[data-clear]')) {
      const hadFocus = el.closest('button[data-clear]')!.contains(document.activeElement);
      highlight = null;
      // Clear disables itself once nothing is selected; keep keyboard focus in the list.
      renderKeepingFocus(els.boats, hadFocus ? 'button[data-id]' : null);
    }
  });
  els.legend.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-leg]');
    if (!btn) return;
    const key = btn.getAttribute('data-leg');
    const leg = key === 'all' ? null : Number(key);
    legSel = leg == null || leg === legSel ? null : leg;
    renderKeepingFocus(els.legend, focusSel(btn, 'data-leg'));
  });
  els.start.addEventListener('click', (ev) => {
    const g = (ev.target as Element).closest('g.boat[data-id]');
    toggleHighlight(g ? g.getAttribute('data-id') : null);
  });

  async function show(p: Promise<RaceAnalysis>): Promise<void> {
    els.digest.classList.add('loading');
    try {
      analysis = await p;
      highlight = null;
      sort = null;
      legSel = null;
      fitBox = startFitBox(analysis);
      setView(fitView(fitBox));
      render();
      setStatus('');
    } finally {
      els.digest.classList.remove('loading');
    }
  }

  async function loadRace(division: string, raceNumber: number): Promise<void> {
    if (!regatta) return;
    setUrl({ event: eventId, div: division, race: String(raceNumber) });
    try {
      await show(run({ type: 'live', eventId, regatta, division, raceNumber }));
      setNotice('');
    } catch (e) {
      setStatus('');
      // Keep the event/race picker so another race can be tried.
      setNotice(`Couldn't load that race (${(e as Error).message}).`);
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
  /** Load an event and its default (or wanted) race. False if it has no finished races. */
  async function loadEvent(id: string, want?: { division: string; raceNumber: number }): Promise<boolean> {
    const req = ++eventReq;
    setStatus('Loading event…');
    const next = await fetchRegatta(id);
    if (req !== eventReq) return true; // superseded by a newer pick
    const doc = currentDoc(next);
    const races = listRaces(doc).filter((r) => r.finishers > 0);
    if (!races.length) return false;
    regatta = next;
    eventId = id;
    renderEventOptions();
    els.race.innerHTML = races
      .map((r) => `<option value="${esc(r.division)}|${r.raceNumber}">${esc(r.division)} · Race ${r.raceNumber}</option>`)
      .join('');
    const pick =
      (want && races.find((r) => r.division === want.division && r.raceNumber === want.raceNumber)) ?? defaultRace(doc) ?? races[0];
    els.race.value = `${pick.division}|${pick.raceNumber}`;
    els.race.disabled = false;
    await loadRace(pick.division, pick.raceNumber);
    return true;
  }

  const titleOf = (id: string): string => events.find((e) => e.eventId === id)?.title ?? id;

  /** A user pick (select, or Enter in the search). On failure the select goes back to the loaded event. */
  function pickEvent(id: string): void {
    if (!id || id === eventId) return;
    loadEvent(id).then(
      (ok) => {
        if (ok) return;
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
    const action = searchKeyAction(ev.key, els.search.value, matchCount);
    if (action === 'clear') {
      ev.preventDefault();
      els.search.value = '';
      renderEventOptions();
    } else if (action === 'pick') {
      ev.preventDefault();
      const only = pickerOptions(events, els.search.value, '').matches[0];
      if (only) pickEvent(only.eventId);
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
    if (matchMedia('(pointer: fine)').matches && (!document.activeElement || document.activeElement === document.body)) {
      els.search.focus();
    }
    if (explicit) {
      try {
        if (await loadEvent(explicit, params.want)) return;
        setStatus('');
        setNotice(`${titleOf(explicit)} has no finished races yet. Pick another event.`);
      } catch (e) {
        setStatus('');
        setNotice(`Couldn't load event ${explicit} (${(e as Error).message}). Pick another event.`);
      }
      return;
    }
    // Otherwise the most recent event that has a finished race (polite: at most 4 tries).
    for (const e of events.slice(0, 4)) {
      try {
        if (await loadEvent(e.eventId, params.want)) return;
      } catch {
        // try the next one
      }
    }
    setStatus('');
    setNotice('No finished race found in the most recent events. Search or pick an event above.');
  }

  // `?demo=` is retired (live data only); drop it from old links and open the normal list.
  if (new URLSearchParams(location.search).has('demo')) setUrl({ demo: null });
  void boot();
}
