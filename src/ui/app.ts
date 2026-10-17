/**
 * The page: pick an event → race, run the worker, render the digest.
 * `?demo=1` loads the bundled fixture; otherwise we try live data and fall
 * back to the fixture (with a visible notice) if the network or proxy fails.
 */
import fixtureUrl from '../../tests/fixtures/benelux_r8.json?url';
import { START_TRAIL_MS } from '../analysis/analyze';
import type { RaceAnalysis } from '../analysis/types';
import { currentDoc, defaultRace, listRaces } from '../data/racesense/adapter';
import { fetchLanding, fetchRegatta } from '../data/racesense/api';
import type { LandingEvent, RegattaResponse } from '../data/racesense/types';
import type { WorkerRequest, WorkerResponse } from '../worker';
import { classDims } from '../data/classes';
import { boatList, findingsList } from './boats';
import { legLegend, startFitBox, startHullScale, startSnapshot, trackMap } from './charts';
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
    table: $('table'),
    findings: $('findings'),
    boats: $('boat-list'),
    warnings: $('warnings'),
    mode: $('mode-link'),
  };

  const params = new URLSearchParams(location.search);
  const demo = params.has('demo') && params.get('demo') !== '0';
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
  let eventId = params.get('event') ?? '';

  function setStatus(text: string): void {
    els.status.textContent = text;
    els.status.hidden = !text;
  }

  function setNotice(text: string): void {
    els.notice.textContent = text;
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
  els.table.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-sort]');
    if (btn && analysis) {
      sort = toggleSort(analysis, sort, btn.getAttribute('data-sort')!);
      renderKeepingFocus(els.table, focusSel(btn, 'data-sort'));
      return;
    }
    const tr = (ev.target as HTMLElement).closest('tr[data-id]');
    if (tr) toggleHighlight(tr.getAttribute('data-id'));
  });
  els.table.addEventListener('keydown', (ev) => {
    const tr = (ev.target as HTMLElement).closest('tr[data-id]');
    if (tr && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      toggleHighlight(tr.getAttribute('data-id'));
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

  async function loadDemo(reason: string | null): Promise<void> {
    setNotice(reason ? `${reason} Showing the bundled demo race (Benelux Sailing League Act III, J70 race 8).` : '');
    els.event.innerHTML = '<option>Benelux Sailing League Act III (demo)</option>';
    els.race.innerHTML = '<option>J70 · Race 8</option>';
    els.event.disabled = true;
    els.race.disabled = true;
    els.mode.textContent = 'Try live data';
    els.mode.setAttribute('href', '?');
    try {
      await show(run({ type: 'fixture', url: fixtureUrl }));
    } catch (e) {
      setStatus(`Couldn't load the demo data: ${(e as Error).message}`);
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
      // Keep the event/race picker so another race can be tried; only boot
      // falls all the way back to the bundled demo.
      setNotice(`Couldn't load that race (${(e as Error).message}).`);
    }
  }

  async function loadEvent(id: string, want?: { division: string; raceNumber: number }): Promise<boolean> {
    eventId = id;
    setStatus('Loading event…');
    regatta = await fetchRegatta(id);
    const doc = currentDoc(regatta);
    const races = listRaces(doc).filter((r) => r.finishers > 0);
    if (!races.length) return false;
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

  els.event.addEventListener('change', () => {
    loadEvent(els.event.value).then(
      (ok) => ok || setStatus('No finished races in this event yet.'),
      (e: Error) => setStatus(`Couldn't load the event: ${e.message}`),
    );
  });
  els.race.addEventListener('change', () => {
    const [div, n] = els.race.value.split('|');
    void loadRace(div, Number(n));
  });

  async function boot(): Promise<void> {
    if (demo) {
      els.mode.textContent = 'Live data';
      return loadDemo(null);
    }
    els.mode.textContent = 'Demo (offline)';
    els.mode.setAttribute('href', '?demo=1');
    let events: LandingEvent[];
    try {
      setStatus('Loading events…');
      const landing = await fetchLanding();
      const now = Date.now();
      const recency = (e: LandingEvent): number => (e.capturedRaceTime ? Date.parse(e.capturedRaceTime) : Math.min(e.endMs, now));
      events = landing.events.filter((e) => e.startMs <= now).sort((a, b) => recency(b) - recency(a));
    } catch (e) {
      return loadDemo(`Live data unavailable (${(e as Error).message}).`);
    }
    if (eventId && !events.some((e) => e.eventId === eventId)) {
      events.unshift({ eventId, title: eventId, startMs: 0, endMs: 0 });
    }
    els.event.innerHTML = events
      .map((e) => `<option value="${esc(e.eventId)}">${esc(e.title)}${e.dateLabel ? ` — ${esc(e.dateLabel)}` : ''}</option>`)
      .join('');
    els.event.disabled = false;
    const wantRace = params.get('race');
    const want = params.get('div') && wantRace ? { division: params.get('div')!, raceNumber: Number(wantRace) } : undefined;
    // Explicit event first; otherwise the most recent event that has a finished race (polite: at most 4 tries).
    const candidates = eventId ? [eventId] : events.slice(0, 4).map((e) => e.eventId);
    for (const id of candidates) {
      try {
        els.event.value = id;
        if (await loadEvent(id, want)) return;
      } catch (e) {
        if (eventId) return loadDemo(`Couldn't load event ${id} (${(e as Error).message}).`);
      }
    }
    return loadDemo('No recent finished race found in the live feed.');
  }

  void boot();
}
