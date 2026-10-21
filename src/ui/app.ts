/**
 * The page: search/pick an event → race, run the worker, render the digest.
 * Live data only: if the feed or proxy fails we say so, with a way to retry.
 */
import { buildCoach, coachRaceKey, rivalLadder, type CoachModel, type CoachRaw, type RivalLadder } from '../analysis/coach';
import { coachDebrief, type CoachDebrief } from '../analysis/coach/debrief';
import { legStories } from '../analysis/coach/legStory';
import { progressAt, progressBase, type ProgressBase } from '../analysis/coach/progress';
import type { Group } from '../analysis/coach/groups';
import { splitFindings } from '../analysis/findings';
import { fullRateWants } from '../analysis/fullRate';
import { START_TRAIL_MS, type BoatResult, type FullRateTrack, type RaceAnalysis } from '../analysis/types';
import { linkOfficial, type LinkOutcome } from '../data/official/link';
import { httpYsSource, parseYsEventId } from '../data/official/yachtscoring';
import { PROBE_BUDGET, discoverOrphans, isOrphanKey, type OrphanFound } from '../data/orphans';
import { buildRaceList, findListed, type ListedRace, type RaceList } from '../data/raceList';
import { currentDoc, defaultRace, listRaces } from '../data/racesense/adapter';
import { fetchLanding, fetchUsableRegatta } from '../data/racesense/api';
import type { LandingEvent, RegattaResponse } from '../data/racesense/types';
import { eventFinished, linkRequest, linksOf, mergeOrphans, officialFor, orphanContexts, probeFetcher } from '../data/recovery';
import { raceWindowsFromListed } from '../data/vkx/match';
import type { WorkerRequest, WorkerResponse } from '../worker';
import { boatList, findingsList } from './boats';
import {
  BOAT_PARAM,
  GROUP_PARAM,
  VIEW_PARAM,
  coachBoatFor,
  coachChips,
  coachGroupHtml,
  coachHeadHtml,
  coachHighlight,
  coachNoBoatHtml,
  coachViewHtml,
  defaultLadderGroup,
  groupParam,
  ladderChart,
  ladderChips,
  ladderHover,
  ladderLayout,
  ladderTipHtml,
  parseBoatParam,
  parseGroupParam,
  parseCoachView,
  type CoachView,
  type LadderLayout,
} from './coach';
import { createRegattaRunner, regattaJobs, regattaViewHtml, type RegattaJob, type WorkerPort } from './coachRegatta';
import { askLogHtml, askPanelHtml, askPanelShown, createAskCoach, leftText, type AskPanelState } from './coachAsk';
import { raceAskContext, regattaAskContext } from './coachAskContext';
import type { AskContext } from '../analysis/coach/askContext';
import type { AskIds } from '../data/askCoach/protocol';
import { cardSpans, coachCardsHtml } from './coachCards';
import { legStoriesHtml } from './coachLegs';
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
import { NC_ALL, YSC_PARAM, YS_PARAM } from './params';
import { easternZone, raceHead, raceHeadHtml, raceName, raceOptionText, raceTitleHtml, type FeedCheck, type OfficialState } from './races';
import {
  isNarrowStart,
  legLegend,
  mapBox,
  startBoatKey,
  startFitBox,
  startFullFrame,
  startScale,
  startSnapshot,
  scrubFrame,
  scrubPoints,
  trackMap,
  trackPoints,
  trackPointsFull,
  type ScrubFrame,
  type StartFrame,
  type TrackMapOptions,
} from './charts';
import { useFullRate, type FullRateSet } from './mapPieces';
import {
  T_PARAM,
  TRAIL_PARAM,
  clampTime,
  paramOfTime,
  parseSpeed,
  parseTParam,
  parseTrail,
  playFrom,
  playStep,
  scrubLabel,
  scrubParams,
  scrubWindow,
  timeOfParam,
  trailWindow,
  type Speed,
  type Trail,
} from './scrub';
import { mapKey, raceNotesKey, startKey } from './captions';
import { MAP_GAP_TITLE, mapHasGaps, mapTipHtml, mapTipLines, pickAt, pickMapPoint, type MapPoints, type PlaceRead } from './mapPoints';
import { createFullscreen, inertOthers, lockScroll, moveNodes, trapFocus, type ScrollLock } from './fullscreen';
import { boatLabel, degLabel, esc, f1, gunTimeLine } from './format';
import { dismissHint, hintStore, showHint } from './hints';
import { renderKeepOpen, renderKeyLine } from './info';
import { START_NAMES_KEY, parseStartNames, startNamesControls } from './labels';
import { attachTopScroll } from './hscroll';
import { attachPanZoom } from './panzoom';
import { PLACE_TIP_MOUSE_REACH, PLACE_TIP_TOUCH_REACH, nearestPlaceDot, placesChart, placesKey } from './places';
import { DEFAULT_TAB, TABS, parseTab, tabForKey, tabFromHash, withTabHash, type Tab } from './tabs';
import { startSogSeries, type StartSogSeries } from '../analysis/startSog';
import {
  START_SOG_WINDOW_KEY,
  parseStartSogWindow,
  secsLabel,
  startSogChart,
  startSogControls,
  startSogHover,
  startSogKey,
  startSogLayout,
} from './startSog';
import {
  START_COLOUR_KEY,
  hasGaps,
  parseStartColour,
  sogHoverLeg,
  sogKey,
  sogLegKey,
  startColourControls,
  startSogRange,
  trackSogRange,
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
import { carryView, clampView, clientToChart, fitView, presetActive, viewBox, type Box, type View } from './view';
import { createVkxUpload } from './vkxUpload';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The charts that open full screen, and the overlay's label for each. */
type Full = 'start' | 'map' | 'places';
const FULL_LABEL: Record<Full, string> = {
  start: 'Start chart, full screen',
  map: 'Track map, full screen',
  places: 'Place changes, full screen',
};

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
    raceHead: $('race-head'),
    start: $('start-chart'),
    startCap: $('start-cap'),
    startHint: $('start-hint'),
    startHintDismiss: $('start-hint-dismiss'),
    startZoom: $('start-zoom'),
    startColour: $('start-colour'),
    startKey: $('start-speed-key'),
    map: $('map-chart'),
    mapTip: $('map-tip'),
    mapZoom: $('map-zoom'),
    mapScrub: $('map-scrub'),
    mapPlay: $('map-play'),
    mapTime: $<HTMLInputElement>('map-time'),
    mapTimeLbl: $('map-time-lbl'),
    mapFullRace: $('map-full-race'),
    mapSpeed: $('map-speed'),
    mapTrail: $('map-trail'),
    legend: $('map-legend'),
    colour: $('map-colour'),
    speedKey: $('map-speed-key'),
    mapCap: $('map-cap'),
    startSog: $('start-sog-chart'),
    startSogTip: $('start-sog-tip'),
    startSogWindow: $('start-sog-window'),
    startSogCap: $('start-sog-cap'),
    places: $('places-chart'),
    placesTip: $('places-tip'),
    placesCap: $('places-cap'),
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
    raceNotes: $('race-notes'),
    tabs: $('tabs'),
    tabBtn: { start: $('tab-start'), race: $('tab-race'), coach: $('tab-coach') } as Record<Tab, HTMLElement>,
    panel: { start: $('panel-start'), race: $('panel-race'), coach: $('panel-coach') } as Record<Tab, HTMLElement>,
    coachPick: $('coach-pick'),
    coachLadderCard: $('coach-ladder-card'),
    coachRegatta: $('coach-regatta'),
    coachTitle: $('coach-title'),
    coachHead: $('coach-head'),
    coachGroup: $('coach-group'),
    coachLadder: $('coach-ladder'),
    coachTip: $('coach-ladder-tip'),
    coachLadderCap: $('coach-ladder-cap'),
    coachCards: $('coach-cards'),
    coachLegs: $('coach-legs'),
    coachAsk: $('coach-ask'),
    fs: $('fs'),
    fsTools: $('fs-tools'),
    fsKey: $('fs-key'),
    fsBoatKey: $('fs-boat-key'),
    fsBody: $('fs-body'),
    fsClose: $('fs-close'),
    fsRotate: $('fs-rotate'),
    fsRotateDismiss: $('fs-rotate-dismiss'),
    fullBtn: { start: $('start-full'), map: $('map-full'), places: $('places-full') } as Record<Full, HTMLElement>,
  };

  /** The URL's race, else the last one viewed (recall.lastView), else the latest. */
  const saved = readLastView();
  const plan = resolveStart(location.search, saved);
  const tabs = TABS;
  /** Start | Race | Coach: the URL hash, else the saved tab when restoring the saved view, else Start. */
  let tab: Tab = startTab(location.hash, plan, saved, tabs);
  const params = plan.params;
  const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  let reqId = 0;
  const pending = new Map<number, { resolve: (a: RaceAnalysis) => void; reject: (e: Error) => void }>();
  const SUPERSEDED = 'superseded';
  const isSuperseded = (e: unknown): boolean => e instanceof Error && e.message === SUPERSEDED;
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    // The map's full-rate tracks, asked for as the Coach's are (ids counting down).
    const fullWait = fullPending.get(msg.id);
    if (fullWait) {
      fullPending.delete(msg.id);
      fullWait(msg.type === 'full-rate' ? msg.tracks : null);
      return;
    }
    // Coach requests count down from -1, apart from the race loads.
    const coachWait = coachPending.get(msg.id);
    if (coachWait) {
      coachPending.delete(msg.id);
      coachWait(msg.type === 'coach-raw' ? msg.raw : null);
      return;
    }
    if (msg.id !== reqId || msg.type === 'coach-raw' || msg.type === 'regatta-race' || msg.type === 'full-rate') return; // a newer request superseded this one
    const p = pending.get(msg.id);
    if (msg.type === 'progress') setStatus(msg.message);
    else if (msg.type === 'done') p?.resolve(msg.analysis);
    else if (msg.type === 'error') p?.reject(new Error(msg.message));
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

  /** Boat-log uploads: new ones re-run the race on screen (loadRace keeps its view). */
  const vkx = createVkxUpload({
    reload: () => current && void loadRace(current.division, current.raceNumber),
    windows: (div) => (raceList ? raceWindowsFromListed(raceList.races, div) : []),
  });

  let coachReq = 0;
  const coachPending = new Map<number, (w: CoachRaw | null) => void>();
  /** The worker's wind series and start crossings for a race (null: it no longer holds that race, or failed; the coach then uses the drawn tracks). */
  const coachRawOf = (key: string): Promise<CoachRaw | null> =>
    new Promise((resolve) => {
      const id = --coachReq;
      coachPending.set(id, resolve);
      worker.postMessage({ id, type: 'coach-raw', key } satisfies WorkerRequest);
    });
  const fullPending = new Map<number, (t: FullRateTrack[] | null) => void>();
  /** The worker's full-rate tracks of a race (null: it no longer holds that race, or failed; the map keeps its ~1 Hz segments). */
  const fullRateOf = (a: RaceAnalysis): Promise<FullRateTrack[] | null> =>
    new Promise((resolve) => {
      const id = --coachReq;
      fullPending.set(id, resolve);
      worker.postMessage({ id, type: 'full-rate', key: raceKeyOf(a), wants: fullRateWants(a) } satisfies WorkerRequest);
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
  /** The track map's pan/zoom: its fit box (the leg selection's `mapBox`), the race and leg it was made for, and the view on it. */
  let mapFit: Box | null = null;
  let mapFitFor: { a: RaceAnalysis; leg: number | null } | null = null;
  let mapView: View = { cx: 0, cy: 0, k: 1 };
  /** Point details: the map's fix and gap lookup for a race and leg, built on first hover or tap. */
  let mapPts: { a: RaceAnalysis; leg: number | null; full: FullRateSet | null; view: View; p: MapPoints } | null = null;
  let fitBox: Box | null = null;
  let view: View = { cx: 0, cy: 0, k: 1 };
  /** The chart open full screen, if any (it shares the selection, zoom and names with the page). */
  let full: Full | null = null;
  let regatta: RegattaResponse | null = null;
  /** The event whose races are loaded (and shown in the digest); '' until one loads. */
  let eventId = '';
  /** Every listed event, most recent first; the search filters this. */
  let events: LandingEvent[] = [];
  let matchCount = 0;
  /** The race on screen (null until one loads); what recall.lastView records. */
  let current: { eventId: string; division: string; raceNumber: number } | null = null;
  /** The loaded event's regatta as fetched (`regatta` is it with rebuilt races merged in). */
  let baseRegatta: RegattaResponse | null = null;
  /** The loaded event's race list (official numbering, practice, rebuilt races). */
  let raceList: RaceList | null = null;
  /** Official results for the loaded event: `ys=` (0: off) / `ysc=` from the link or the saved view. */
  let ysParam: number | undefined = params.ys;
  let yscParam: string | undefined = params.ysc;
  let official: OfficialState = { status: 'pending' };
  let feed: FeedCheck = { status: 'idle', used: 0, max: 0, found: 0, exhausted: false };
  const outcomeOf = (): LinkOutcome | null => (official.status === 'done' ? official.outcome : null);
  const listedOf = (division: string, raceNumber: number): ListedRace | undefined => (raceList ? findListed(raceList, division, raceNumber) : undefined);

  /** Record the race on screen and how it's viewed, so a relaunch can come back to it. */
  function save(): void {
    if (!current || !analysis) return;
    // A load that has swapped `analysis` but not yet `current` (or the reverse) must not mix them.
    if (analysis.meta.division !== current.division || analysis.meta.raceNumber !== current.raceNumber) return;
    if (analysis.meta.eventId != null && analysis.meta.eventId !== current.eventId) return;
    writeLastView({
      v: 1,
      ...current,
      ...(allCompetitors ? { allCompetitors: true } : {}),
      leg: legSel,
      boat: highlight,
      sort,
      startSort,
      tab,
      ...(ysParam !== undefined ? { ys: ysParam } : {}),
      ...(ysParam && yscParam ? { ysc: yscParam } : {}),
      savedAt: Date.now(),
    });
  }

  /** Forget the saved race and take it out of the URL. */
  function forget(): void {
    clearLastView();
    current = null;
    allCompetitors = false;
    ysParam = undefined;
    yscParam = undefined;
    setUrl({ event: null, div: null, race: null, nc: null, [YS_PARAM]: null, [YSC_PARAM]: null });
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
    // Keep the current state (the full-screen marker, if any) so a race-load URL
    // update while the overlay is open doesn't leave a stuck history entry.
    history.replaceState(history.state, '', u);
  }

  /** The race header's chips and ⓘ (official link, numbering, finishes, feed check); kept open across redraws. */
  function renderRaceHead(): void {
    const m = analysis?.meta;
    const race = m && (m.eventId == null || m.eventId === eventId) ? listedOf(m.division, m.raceNumber) : undefined;
    const k = raceHead({ race, official, feed, results: m?.results, ys: ysParam ?? null });
    renderKeepOpen(els.raceHead, (open) => raceHeadHtml(k, open));
    els.raceHead.hidden = !m;
  }

  /** The race title and gun line (`#summary`): re-run whenever the race list is relabelled, as well as on every render. */
  function renderSummary(): void {
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
    const listed = m.eventId == null || m.eventId === eventId ? listedOf(m.division, m.raceNumber) : undefined;
    els.summary.innerHTML = `${raceTitleHtml(m, listed)}
      <p>${esc(gunTimeLine(m.gunMs, m.tzOffsetMs))} ·
      ${a.boats.length} boats · ${a.legs.map((l) => esc(l.name)).join(', ')} ·
      <span title="No wind sensor on the boats: estimated from the fleet's steady upwind headings">${windText}${model}</span> ·
      <span class="muted">${esc(m.sourceLabel)}</span></p>`;
    renderRaceHead();
    vkx.mount(els.raceHead, a);
  }

  function render(): void {
    const a = analysis;
    if (!a) return;
    renderSummary();
    renderStart();
    els.startColour.innerHTML = startColourControls(startColour) + startNamesControls(startNames);
    els.startKey.innerHTML =
      startColour === 'speed'
        ? sogKey(startSogRange(a), `last ${START_TRAIL_MS / 1000} s, hull at the gun`, hasGaps(a.drawings.map((d) => d.trail.t)))
        : '';
    els.startKey.hidden = startColour !== 'speed';
    renderFullKey();
    fitMap(a);
    renderMap();
    els.legend.innerHTML = legLegend(a, legSel);
    // In Rank or Boat speed the leg swatches would read as a colour key for the tracks; the buttons stay, the swatches go.
    els.legend.classList.toggle('speed', trackColour !== 'leg');
    els.colour.innerHTML = colourControls(trackColour, rankBy, legSel, speedTop, sogScale);
    els.speedKey.innerHTML =
      trackColour === 'rank'
        ? speedKey(a, legSel, rankBy, speedTop, highlight)
        : trackColour === 'sog'
          ? legSel == null && sogScale === 'leg'
            ? sogLegKey(a, mapHasGaps(a, null), MAP_GAP_TITLE)
            : sogKey(trackSogRange(a, legSel), legSel == null ? 'Whole race' : `${a.legs[legSel]?.name ?? 'This leg'}`, mapHasGaps(a, legSel), MAP_GAP_TITLE)
          : '';
    els.speedKey.hidden = trackColour === 'leg';
    renderKeyLine(els.mapCap, mapKey(a, { highlight, colour: trackColour, rankBy, sogScale, leg: legSel }));
    renderKeyLine(els.placesCap, placesKey(a));
    els.startTable.innerHTML = startTable(a, highlight, startSort);
    renderKeepOpen(els.startNotes, (open) => startNotesHtml(a, open));
    els.table.innerHTML = legsTable(a, highlight, sort);
    renderKeepOpen(els.legsNotes, (open) => legsNotesHtml(a, open));
    els.boats.innerHTML = boatList(a, highlight, ncOpen);
    const found = splitFindings(a.findings);
    els.startFindings.innerHTML = findingsList(found.start, highlight);
    els.startFindingsBox.hidden = !found.start.length;
    els.findings.innerHTML = findingsList(found.race, highlight);
    els.findings.hidden = !found.race.length;
    renderKeyLine(els.raceNotes, raceNotesKey(a));
    els.raceNotes.hidden = !a.notes.length;
    els.raceFindings.hidden = !found.race.length && !a.notes.length;
    els.digest.hidden = false;
    // Measured once the digest is showing (a hidden table has no width).
    for (const t of topScrolls) t.update();
    renderPlaces();
    renderStartSog();
    renderCoach();
  }

  // ---- Coach: built lazily the first time the tab shows a race.
  const query = new URLSearchParams(location.search);
  let coachGroup: Group = parseGroupParam(query.get(GROUP_PARAM)) ?? defaultLadderGroup();
  /** The coached boat, kept across races: the URL's, then the last one selected. */
  let coachBoat: string | null = parseBoatParam(query.get(BOAT_PARAM));
  let coachEach = true;
  let coachCustomOpen = false;
  let coach: { a: RaceAnalysis; model: CoachModel | null } | null = null;
  let coachBuilding: RaceAnalysis | null = null;
  let coachLadder: RivalLadder | null = null;
  /** The boat's debrief for the race (cached per model and boat), and the card whose window the chart shades. */
  let coachDeb: { model: CoachModel; boat: string; d: CoachDebrief | null } | null = null;
  let coachSel: number | null = null;
  let coachLayout: LadderLayout | null = null;
  /** Race (the race picked in the Race menu) or Regatta (every race of the event): `cview=regatta`. */
  let coachView: CoachView = parseCoachView(query.get(VIEW_PARAM));
  const raceKeyOf = (a: RaceAnalysis): string => coachRaceKey(a.meta.eventId ?? '', a.meta.division, a.meta.raceNumber, !!a.allCompetitors);
  /** The Regatta view's races, analysed one at a time on a worker of their own (made on first use). */
  const regattaRunner = createRegattaRunner(
    () => new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerPort,
    () => {
      // Through renderCoach so official-pending / no-boat / event-mismatch guards apply
      // (a leftover reply must not paint another boat's digest, or "No races" over "Checking…").
      if (tab === 'coach' && coachView === 'regatta') renderCoach();
    },
  );

  /** True when the coach model of `a` is ready; else starts building it (the wind from the worker) and re-renders when done. */
  function ensureCoach(a: RaceAnalysis): boolean {
    if (coach?.a === a) return true;
    if (coachBuilding === a) return false;
    coachBuilding = a;
    void coachRawOf(raceKeyOf(a)).then((raw) => {
      if (coachBuilding !== a) return;
      coachBuilding = null;
      coach = { a, model: buildCoach(a, raw?.wind, raw?.crossMs ?? null, raw?.zones ?? null, raw?.heel ?? null) };
      if (analysis === a) renderCoach();
    });
    return false;
  }

  // ---- Ask Coach (optional): the panel shows only when /api/coach/status says it is on.
  /** Builds the context of what is on screen, at the moment a question is sent; null with no boat. */
  let askContextNow: (() => AskContext) | null = null;
  let askIds: AskIds = {};
  let askPanelView: CoachView | null = null;
  let askOpen = false;
  let askShownKey = '';
  const ask = createAskCoach({ render: renderAsk });
  const askBox = <T extends HTMLElement>(sel: string): T | null => els.coachAsk.querySelector<T>(sel);

  function askCount(): void {
    const q = askBox<HTMLTextAreaElement>('[data-ask-q]');
    const c = askBox<HTMLElement>('[data-ask-count]');
    if (q && c) c.textContent = `${q.value.length}/${q.maxLength}`;
  }

  function renderAsk(s: AskPanelState): void {
    const log = askBox<HTMLElement>('[data-ask-log]');
    if (!log) return;
    log.innerHTML = askLogHtml(s);
    log.setAttribute('aria-busy', String(s.busy));
    const left = askBox<HTMLElement>('[data-ask-left]');
    if (left) left.textContent = leftText(s.remaining);
    const out = s.remaining === 0;
    for (const b of els.coachAsk.querySelectorAll<HTMLButtonElement>('[data-ask-send], [data-ask-suggest]')) b.disabled = s.busy || out;
    const stop = askBox<HTMLElement>('[data-ask-stop]');
    if (stop) stop.hidden = !s.busy;
    if (s.key !== askShownKey) {
      // A new conversation: the old draft goes too.
      askShownKey = s.key;
      const q = askBox<HTMLTextAreaElement>('[data-ask-q]');
      if (q) q.value = '';
      askCount();
    }
  }

  /** The panel for this race, boat, view and group: a change of any of them starts a new chat. */
  function syncAsk(a: RaceAnalysis, me: BoatResult | null): void {
    const st = ask.state();
    if (st.avail == null) void ask.check().then(() => renderCoach());
    const on = askPanelShown(st, !!me);
    els.coachAsk.hidden = !on;
    askContextNow = null;
    if (!me) return;
    const group = coachView === 'race' ? groupParam(coachGroup) : '';
    askIds = { event: a.meta.eventId ?? eventId, div: a.meta.division, race: String(a.meta.raceNumber), sail: me.sail, view: coachView, ...(group ? { group } : {}) };
    if (on && askPanelView !== coachView) {
      els.coachAsk.innerHTML = askPanelHtml(coachView, askOpen);
      askPanelView = coachView;
      askShownKey = '';
    }
    ask.setKey([coachView, raceKeyOf(a), me.id, group].join('#'));
    if (on) renderAsk(ask.state());
  }

  function sendAsk(text: string): void {
    const ctx = askContextNow?.();
    const st = ask.state();
    // Busy / no questions left: keep the draft (Enter still fires while Ask is disabled).
    if (!ctx || !text.trim() || st.busy || !st.avail?.enabled || st.remaining === 0) return;
    void ask.ask(text, ctx, askIds);
    const q = askBox<HTMLTextAreaElement>('[data-ask-q]');
    if (q) q.value = '';
    askCount();
  }
  els.coachAsk.addEventListener('submit', (ev) => {
    ev.preventDefault();
    sendAsk(askBox<HTMLTextAreaElement>('[data-ask-q]')?.value ?? '');
  });
  els.coachAsk.addEventListener('click', (ev) => {
    const el = ev.target as HTMLElement;
    const sug = el.closest('button[data-ask-suggest]')?.getAttribute('data-ask-suggest');
    if (sug) sendAsk(sug);
    else if (el.closest('button[data-ask-stop]')) {
      ask.stop();
      askBox<HTMLTextAreaElement>('[data-ask-q]')?.focus();
    }
  });
  els.coachAsk.addEventListener('input', askCount);
  els.coachAsk.addEventListener('keydown', (ev) => {
    // Enter sends; Shift+Enter is a new line.
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && (ev.target as HTMLElement).matches('[data-ask-q]')) {
      ev.preventDefault();
      sendAsk((ev.target as HTMLTextAreaElement).value);
    }
  });
  els.coachAsk.addEventListener(
    'toggle',
    (ev) => {
      if ((ev.target as HTMLElement).matches?.('details.coach-ask-box')) askOpen = (ev.target as HTMLDetailsElement).open;
    },
    true,
  );

  /** Coach follows the app: the race in the Race menu, the boat selected in the boat list (or a chart). */
  function renderCoach(): void {
    const a = analysis;
    if (!a || tab !== 'coach') return;
    if (highlight && a.boats.some((b) => b.id === highlight)) coachBoat = highlight;
    const boat = coachBoatFor(a, highlight);
    const me = a.boats.find((b) => b.id === boat);
    const regattaOn = coachView === 'regatta';
    els.coachPick.innerHTML = coachViewHtml(coachView);
    els.coachTitle.textContent = me ? boatLabel(me, me.id) : '';
    els.coachTip.hidden = true;
    els.coachRegatta.hidden = !me || !regattaOn;
    for (const el of [els.coachLadderCard, els.coachCards, els.coachLegs]) el.hidden = !me || regattaOn;
    syncAsk(a, me ?? null);
    if (!me) {
      els.coachHead.innerHTML = coachNoBoatHtml();
      regattaRunner.want([]);
      return;
    }
    if (regattaOn) {
      els.coachHead.innerHTML = '';
      renderRegatta(a, me.sail);
      askContextNow = () =>
        regattaAskContext({ races: regattaRunner.races(), progress: regattaRunner.progress(), boat: me, event: a.meta.eventName, division: a.meta.division });
      return;
    }
    const listed = raceList ? findListed(raceList, a.meta.division, a.meta.raceNumber) : undefined;
    const raceTitle = listed ? raceName(listed) : undefined;
    if (!ensureCoach(a)) {
      askContextNow = () => raceAskContext({ a, me, raceName: raceTitle, head: coachChips(a, me, null), deb: null, stories: [], group: coachGroup });
      renderKeepOpen(els.coachHead, (open) => coachHeadHtml(coachChips(a, me, null), open));
      els.coachGroup.innerHTML = '';
      els.coachLadder.innerHTML = '<p class="muted coach-none">Working out the wind…</p>';
      els.coachCards.innerHTML = '';
      els.coachLegs.innerHTML = '';
      renderKeyLine(els.coachLadderCap, { chips: [], bullets: [] });
      return;
    }
    const model = coach!.model;
    coachLadder = model ? rivalLadder(model, a, me.id, coachGroup) : null;
    if (model && (coachDeb?.model !== model || coachDeb.boat !== me.id)) {
      coachDeb = { model, boat: me.id, d: coachDebrief(a, model, me.id) };
      coachSel = null;
    }
    const deb = model && coachDeb?.model === model ? coachDeb.d : null;
    if (coachSel != null && !deb?.cards[coachSel]) coachSel = null;
    renderKeepOpen(els.coachHead, (open) => coachHeadHtml(coachChips(a, me, coachLadder, deb?.totalS ?? null, deb?.raceCov ?? null), open));
    els.coachGroup.innerHTML = coachGroupHtml(a, me.id, coachGroup, coachEach, coachCustomOpen);
    const widthPx = els.coachLadder.clientWidth || undefined;
    const band = deb && coachSel != null ? cardSpans(deb.cards[coachSel]) : undefined;
    els.coachLadder.innerHTML =
      model && coachLadder
        ? ladderChart(a, model, coachLadder, coachGroup, { widthPx, each: coachEach, highlight: band })
        : '<p class="muted coach-none">No course to measure against in this race.</p>';
    els.coachCards.innerHTML = deb ? coachCardsHtml(a, deb, coachSel, me.coverage ?? null) : '';
    // Leg stories over the picked group; the legs open now stay open.
    const openLegs = new Set([...els.coachLegs.querySelectorAll<HTMLElement>('details.coach-leg[open]')].map((d) => Number(d.dataset.leg)));
    const stories = model ? legStories(a, model, me.id, coachGroup) : [];
    renderKeepOpen(els.coachLegs, (open) => legStoriesHtml(stories, a, me.id, coachGroup, openLegs, open));
    const head = coachChips(a, me, coachLadder, deb?.totalS ?? null, deb?.raceCov ?? null);
    const group = coachGroup;
    askContextNow = () => raceAskContext({ a, me, raceName: raceTitle, head, deb, stories, group });
    coachLayout = model && coachLadder ? ladderLayout(coachLadder, model.wind, a.meta.gunMs, widthPx, coachEach) : null;
    renderKeyLine(els.coachLadderCap, { chips: coachLadder ? ladderChips(a, coachLadder, coachGroup, coachEach) : [], bullets: [] });
  }

  /** The Race menu's races of this division (practice left out), as Regatta jobs for the boat with sail `sail`. */
  function jobsFor(a: RaceAnalysis, sail: string): RegattaJob[] {
    if (!raceList || !regatta || (a.meta.eventId != null && a.meta.eventId !== eventId)) return [];
    const outcome = outcomeOf();
    return regattaJobs(raceList.races, {
      eventId,
      regatta,
      division: a.meta.division,
      sail,
      allCompetitors,
      classLabel: events.find((e) => e.eventId === eventId)?.classLabel,
      officialOf: (r) => officialFor(outcome, r),
      logsOf: (r) => vkx.buffersFor(eventId, r.division, r.raceNumber),
    });
  }

  /** The Regatta view. Official places decide a race's digest, so the races wait until the official link is settled. */
  function renderRegatta(a: RaceAnalysis, sail: string): void {
    if (official.status === 'pending') {
      regattaRunner.want([]);
      els.coachRegatta.innerHTML = '<p class="regatta-status busy" role="status">Checking for official results before analysing the races…</p>';
      return;
    }
    regattaRunner.want(jobsFor(a, sail));
    els.coachRegatta.innerHTML = regattaViewHtml(regattaRunner);
  }

  function setCoachGroup(g: Group): void {
    coachGroup = g;
    setUrl({ [GROUP_PARAM]: groupParam(g) });
    renderCoach();
  }

  /** Remember the coached boat in the URL. Clearing the highlight does not drop it. */
  function syncCoachBoat(id: string | null): void {
    if (!id) return;
    coachBoat = id;
    setUrl({ [BOAT_PARAM]: id });
  }
  els.coachPick.addEventListener('click', (ev) => {
    const v = (ev.target as HTMLElement).closest('button[data-coach-view]')?.getAttribute('data-coach-view');
    if (!v || v === coachView) return;
    coachView = parseCoachView(v);
    setUrl({ [VIEW_PARAM]: coachView === 'regatta' ? 'regatta' : null });
    renderCoach();
    els.coachPick.querySelector<HTMLElement>(`[data-coach-view="${coachView}"]`)?.focus();
  });
  // A card (or its window chip, the keyboard's way in) shades its window on the gap chart; again, or another card, changes it.
  els.coachCards.addEventListener('click', (ev) => {
    const el = ev.target as HTMLElement;
    const card = el.closest<HTMLElement>('[data-opp]');
    if (!card || el.closest('a, details')) return;
    const i = Number(card.getAttribute('data-opp'));
    if (!Number.isInteger(i)) return;
    coachSel = coachSel === i ? null : i;
    renderCoach();
    els.coachCards.querySelector<HTMLElement>(`button.opp-when[data-opp="${i}"]`)?.focus({ preventScroll: true });
    // On a phone the chart is above the cards: bring it into view when the band is switched on.
    const r = els.coachLadder.getBoundingClientRect();
    if (coachSel != null && (r.bottom < 0 || r.top > window.innerHeight)) els.coachLadder.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  els.coachGroup.addEventListener('click', (ev) => {
    const el = ev.target as HTMLElement;
    const g = el.closest('button[data-coach-group]')?.getAttribute('data-coach-group');
    if (g === 'leaders' || g === 'near' || g === 'fleet') {
      setCoachGroup({ kind: g });
      els.coachGroup.querySelector<HTMLElement>(`[data-coach-group="${g}"]`)?.focus();
    } else if (el.closest('button[data-coach-each]')) {
      coachEach = !coachEach;
      renderCoach();
      els.coachGroup.querySelector<HTMLElement>('[data-coach-each]')?.focus();
    }
  });
  els.coachGroup.addEventListener('change', (ev) => {
    const box = (ev.target as HTMLElement).closest<HTMLInputElement>('input[data-coach-custom]');
    if (!box || !analysis) return;
    const id = box.getAttribute('data-coach-custom')!;
    // Boats of the group not in this race stay in it (a link may span races).
    const prev = coachGroup.kind === 'custom' ? coachGroup.ids : [];
    const ids = box.checked ? [...prev.filter((x) => x !== id), id] : prev.filter((x) => x !== id);
    setCoachGroup({ kind: 'custom', ids });
    els.coachGroup.querySelector<HTMLElement>(`[data-coach-custom="${CSS.escape(id)}"]`)?.focus();
  });
  els.coachGroup.addEventListener(
    'toggle',
    (ev) => {
      if ((ev.target as HTMLElement).matches?.('details.coach-custom')) coachCustomOpen = (ev.target as HTMLDetailsElement).open;
    },
    true,
  );
  // The rival ladder: a crosshair and the gap under the pointer.
  function showCoachTip(ev: PointerEvent): void {
    const a = analysis;
    const svg = els.coachLadder.querySelector('svg');
    const hair = svg?.querySelector<SVGLineElement>('line.cl-hair');
    const L = coachLayout;
    if (!a || !svg || !hair || !coachLadder || !L || !coach?.model) return;
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (L.W / (rect.width || L.W));
    const h = px >= L.padL && px <= L.W - L.padR ? ladderHover(coachLadder, L, px) : null;
    if (!h) {
      hair.setAttribute('visibility', 'hidden');
      els.coachTip.hidden = true;
      return;
    }
    const x = L.x(h.tMs).toFixed(1);
    hair.setAttribute('x1', x);
    hair.setAttribute('x2', x);
    hair.setAttribute('visibility', 'visible');
    els.coachTip.innerHTML = ladderTipHtml(a, coach.model, coachLadder, coachGroup, h.i);
    els.coachTip.hidden = false;
    const wrap = els.coachTip.parentElement!.getBoundingClientRect();
    const left = ev.clientX - wrap.left;
    const flip = left + 12 + els.coachTip.offsetWidth > wrap.width;
    els.coachTip.style.left = `${Math.max(0, flip ? left - 12 - els.coachTip.offsetWidth : left + 12)}px`;
    els.coachTip.style.top = `${Math.max(0, ev.clientY - wrap.top - els.coachTip.offsetHeight - 10)}px`;
  }
  els.coachLadder.addEventListener('pointermove', showCoachTip);
  els.coachLadder.addEventListener('pointerdown', showCoachTip);
  els.coachLadder.addEventListener('pointerleave', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    els.coachTip.hidden = true;
    els.coachLadder.querySelector('line.cl-hair')?.setAttribute('visibility', 'hidden');
  });

  /** Speed through the start, sized for its card's width (re-run on resize). */
  function renderStartSog(): void {
    const a = analysis;
    if (!a) return;
    sogSeries = startSogSeries(a, sogWindow);
    els.startSogWindow.innerHTML = startSogControls(sogWindow);
    els.startSog.innerHTML = startSogChart(a, highlight, sogWindow, { widthPx: els.startSog.clientWidth || undefined }, sogSeries);
    renderKeyLine(els.startSogCap, startSogKey(sogSeries, sogWindow));
    els.startSogTip.hidden = true;
  }

  /** The bump chart, sized for its card's width (re-run on resize). */
  function renderPlaces(): void {
    const a = analysis;
    if (!a) return;
    // Full screen: fitted to the overlay's height when the rows stay readable (#fs-body scrolls otherwise; 8 px of padding).
    const heightPx = full === 'places' ? Math.max(0, els.fsBody.clientHeight - 8) || undefined : undefined;
    els.places.innerHTML = placesChart(a, highlight, { widthPx: els.places.clientWidth || undefined, heightPx });
    els.placesTip.hidden = true;
  }

  /** Start chart + its key line (the scale chip follows the zoom); re-run on pan/zoom without redrawing the rest. */
  function renderStart(): void {
    const a = analysis;
    if (!a) return;
    const widthPx = els.start.clientWidth || undefined;
    const frame = fullFrame ?? undefined;
    renderKeyLine(els.startCap, startKey(a, { scale: startScale(a, view, widthPx, frame), highlight, colour: startColour }));
    // Names are placed for this zoom (zooming in spreads the boats and reveals more) and sized for this width.
    els.start.innerHTML = startSnapshot(a, highlight, view, startColour, { names: startNames, widthPx, frame });
  }

  /** The Fit frame for the start chart's width class (narrow charts leave more room for the favoured-end label). */
  let fitNarrow = false;
  /** Full screen: the start chart's frame for the overlay's size (null inline). */
  let fullFrame: StartFrame | null = null;
  /** The rotate hint, once dismissed, stays away for the visit. */
  let rotateDismissed = false;
  /** Fit the start chart inline, or to the overlay's size while full screen; `carry` keeps the zoom (`carryView`) instead of going back to Fit. */
  function fitStart(a: RaceAnalysis, carry = false): void {
    const prev = fitBox;
    if (full === 'start') {
      const f = startFullFrame(a, els.start.clientWidth, els.start.clientHeight);
      fullFrame = f;
      fitBox = f.box;
      els.fsRotate.hidden = !f.rotate || rotateDismissed;
    } else {
      const w = els.start.clientWidth;
      fullFrame = null;
      fitNarrow = isNarrowStart(w);
      fitBox = startFitBox(a, w || undefined);
    }
    setView(carry ? carryView(prev, view, fitBox) : fitView(fitBox));
  }
  /** Refit (back to Fit) when the visible chart has crossed into the other width class. */
  function refitStart(): void {
    const w = els.start.clientWidth;
    if (analysis && full !== 'start' && w && isNarrowStart(w) !== fitNarrow) fitStart(analysis);
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

  // The pinch / pan / double-tap hint: touch devices only, until dismissed (× or the gesture itself; recall.hints).
  els.startHint.hidden = !showHint('pinch', window, hintStore());
  const retireHint = (): void => {
    if (els.startHint.hidden) return;
    els.startHint.hidden = true;
    dismissHint(hintStore(), 'pinch');
  };
  els.startHintDismiss.addEventListener('click', retireHint);

  attachPanZoom(els.start, {
    getBox: () => fitBox,
    getView: () => view,
    setView,
    getRect: () => (els.start.querySelector('svg') ?? els.start).getBoundingClientRect(),
    onGesture: retireHint,
  });

  // ---- Track map: pan/zoom as the start chart, and point details in every colour mode.
  /** The map drawn for the race, leg selection, colouring, selection and view; any tooltip goes with the old drawing. */
  function renderMap(): void {
    const a = analysis;
    if (!a) return;
    clearTimeout(mapSettle);
    const t0 = performance.now();
    // Scrubbing: the static map, then this moment's trails and boats into its two layers (drawScrub, every frame).
    els.map.innerHTML = trackMap(a, highlight, legSel, { ...mapOpts(), full: mapFullRate(a), scrub: scrubT != null });
    scrubData = null;
    if (scrubT != null) drawScrub(a);
    mapDrawMs = performance.now() - t0;
    els.mapTip.hidden = true;
    syncScrub(a);
  }

  const mapOpts = (): TrackMapOptions => ({ colour: trackColour, rankBy, top: speedTop, sogScale, view: mapView });

  /** Full-rate tracks for the map (once per race, asked of the worker the first time the view is tight enough); null until then. */
  let fullRate: { a: RaceAnalysis; set: FullRateSet | null } | null = null;
  function mapFullRate(a: RaceAnalysis): FullRateSet | null {
    if (!mapFit) return null;
    const vb = viewBox(mapFit, mapView);
    if (!useFullRate({ x0: vb.x0, y0: vb.y0, x1: vb.x0 + vb.w, y1: vb.y0 + vb.h }, mapView.k)) return null;
    if (fullRate?.a === a) return fullRate.set;
    const asked: { a: RaceAnalysis; set: FullRateSet | null } = { a, set: null };
    fullRate = asked;
    void fullRateOf(a).then((tracks) => {
      if (fullRate !== asked) return;
      asked.set = new Map((tracks ?? []).map((tk) => [tk.id, tk]));
      if (analysis === a && tracks?.length) renderMap();
    });
    return null;
  }

  // ---- Track map: race-time scrubber (Map B). Off (null) is the whole race as above; `t=` in the URL opens it at a moment.
  /** The scrubber's time, ms; null: the full race. */
  let scrubT: number | null = null;
  let scrubTrail: Trail = parseTrail(new URLSearchParams(location.search).get(TRAIL_PARAM));
  let playSpeed: Speed = 1;
  let playing = false;
  let playFrame = 0;
  let playLast = 0;
  /** The frame drawn last (for the hover), and its lookup once asked for. */
  let scrubData: ScrubFrame | null = null;
  let scrubPts: { f: ScrubFrame; p: MapPoints } | null = null;

  /** A race opens: at the URL's `t=` (gun-relative, clamped to its window), else the full race; playback stops. */
  function openScrub(a: RaceAnalysis): void {
    stopPlay(false);
    const s = parseTParam(new URLSearchParams(location.search).get(T_PARAM));
    scrubT = s == null ? null : timeOfParam(s, a.meta.gunMs, scrubWindow(a));
    if (scrubT != null) setUrl(scrubParams(scrubT, a.meta.gunMs, scrubTrail));
  }

  /** Draw this moment's trails and boats into the static map's layers. */
  function drawScrub(a: RaceAnalysis): void {
    const svg = els.map.querySelector('svg');
    const trk = svg?.querySelector('g.scrub-trk');
    const dots = svg?.querySelector('g.scrub-dots');
    if (scrubT == null || !trk || !dots) return;
    const full = mapFullRate(a);
    const f = scrubFrame(a, highlight, legSel, mapOpts(), { t: scrubT, win: trailWindow(scrubT, scrubTrail, scrubWindow(a)), full });
    trk.innerHTML = f.tracks;
    dots.innerHTML = f.dots;
    scrubData = f;
  }

  /** The URL's `t=` / `trail=` for the scrubber now (replaceState; on a pause or the end of a drag, never per frame). */
  function writeScrubUrl(): void {
    if (analysis) setUrl(scrubParams(scrubT, analysis.meta.gunMs, scrubTrail));
  }

  /** Move the scrubber to `t` (null: back to the full race); switching on or off redraws the map, else only its moving layers. */
  function setScrub(t: number | null, writeUrl: boolean): void {
    const a = analysis;
    if (!a) return;
    const was = scrubT;
    scrubT = t == null ? null : clampTime(t, scrubWindow(a));
    hideMapTip();
    if ((was == null) !== (scrubT == null)) renderMap();
    else if (scrubT != null) {
      drawScrub(a);
      syncScrub(a);
    }
    if (writeUrl) writeScrubUrl();
  }

  /** The scrubber's controls for the race and its state: range, label, play, speed, trail, the way back. */
  function syncScrub(a: RaceAnalysis): void {
    const w = scrubWindow(a);
    const gun = a.meta.gunMs;
    const lo = paramOfTime(w.t0, gun);
    els.mapTime.min = String(lo);
    els.mapTime.max = String(Math.max(lo, Math.floor((w.t1 - gun) / 1000)));
    els.mapTime.value = String(scrubT == null ? lo : paramOfTime(scrubT, gun));
    const label = scrubT == null ? 'Full race' : scrubLabel(scrubT, a);
    els.mapTime.setAttribute('aria-valuetext', label);
    els.mapTimeLbl.textContent = label;
    els.mapScrub.classList.toggle('off', scrubT == null);
    els.mapFullRace.hidden = scrubT == null;
    els.mapPlay.setAttribute('aria-pressed', String(playing));
    els.mapPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    els.mapPlay.title = `${playing ? 'Pause' : 'Play'} (Space)`;
    for (const b of els.mapSpeed.querySelectorAll('button[data-speed]')) b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-speed')) === playSpeed));
    for (const b of els.mapTrail.querySelectorAll('button[data-trail]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-trail') === scrubTrail));
  }

  /** Real time × speed per frame; a frame after a long stall (a hidden tab) counts as at most this, ms. */
  const PLAY_MAX_STEP_MS = 250;
  function startPlay(): void {
    const a = analysis;
    if (!a) return;
    // From the time shown; from the start when off or at the end.
    const from = playFrom(scrubT, scrubWindow(a));
    playing = true;
    playLast = performance.now();
    setScrub(from, false);
    syncScrub(a);
    cancelAnimationFrame(playFrame);
    playFrame = requestAnimationFrame(playTick);
  }
  function playTick(now: number): void {
    playFrame = 0;
    const a = analysis;
    if (!playing || !a || scrubT == null) return stopPlay(true);
    const dt = Math.min(PLAY_MAX_STEP_MS, now - playLast);
    playLast = now;
    const { t, done } = playStep(scrubT, dt, playSpeed, scrubWindow(a));
    scrubT = t;
    if (!els.mapTip.hidden) hideMapTip();
    drawScrub(a);
    if (done) return stopPlay(true);
    els.mapTime.value = String(paramOfTime(t, a.meta.gunMs));
    const label = scrubLabel(t, a);
    els.mapTime.setAttribute('aria-valuetext', label);
    els.mapTimeLbl.textContent = label;
    playFrame = requestAnimationFrame(playTick);
  }
  /** Pause, keeping the time; `writeUrl` records it. */
  function stopPlay(writeUrl: boolean): void {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(playFrame);
    playFrame = 0;
    if (analysis) syncScrub(analysis);
    if (writeUrl) writeScrubUrl();
  }
  const togglePlay = (): void => (playing ? stopPlay(true) : startPlay());

  els.mapPlay.addEventListener('click', togglePlay);
  // Dragging or arrowing the slider pauses and moves the time; the URL follows once it is let go.
  els.mapTime.addEventListener('input', () => {
    const a = analysis;
    if (!a) return;
    stopPlay(false);
    setScrub(a.meta.gunMs + Number(els.mapTime.value) * 1000, false);
  });
  els.mapTime.addEventListener('change', writeScrubUrl);
  els.mapFullRace.addEventListener('click', () => {
    stopPlay(false);
    setScrub(null, true);
    els.mapPlay.focus();
  });
  els.mapSpeed.addEventListener('click', (ev) => {
    const v = (ev.target as Element).closest('button[data-speed]')?.getAttribute('data-speed');
    if (!v) return;
    playSpeed = parseSpeed(v);
    if (analysis) syncScrub(analysis);
  });
  els.mapTrail.addEventListener('click', (ev) => {
    const v = (ev.target as Element).closest('button[data-trail]')?.getAttribute('data-trail');
    if (!v || !analysis) return;
    scrubTrail = parseTrail(v);
    syncScrub(analysis);
    // Off, it is kept for when the scrubber is used.
    if (scrubT != null) {
      drawScrub(analysis);
      writeScrubUrl();
    }
  });
  // Space plays and pauses from the slider or the map (the play button does so natively).
  for (const el of [els.mapTime, els.map]) {
    el.addEventListener('keydown', (ev) => {
      if (ev.key !== ' ' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      ev.preventDefault();
      togglePlay();
    });
  }

  /** A new race or leg selection: fit its box (Fit: everything, or the leg's segments and marks). */
  function fitMap(a: RaceAnalysis): void {
    if (mapFit && mapFitFor?.a === a && mapFitFor.leg === legSel) return;
    mapFitFor = { a, leg: legSel };
    mapFit = mapBox(a, legSel);
    syncMapView(fitView(mapFit));
  }

  /** Store the map view; presets and touch-action follow it. */
  function syncMapView(v: View): void {
    if (!mapFit) return;
    mapView = clampView(mapFit, v);
    for (const b of els.mapZoom.querySelectorAll('button[data-zoom]')) {
      b.setAttribute('aria-pressed', String(presetActive(mapFit, mapView, Number(b.getAttribute('data-zoom')))));
    }
    els.map.classList.toggle('zoomed', mapView.k > 1);
  }

  /** A redraw slower than this (a big fleet) moves only the viewBox during a gesture… */
  const MAP_SLOW_MS = 30;
  /** …and redraws once the view has rested this long. */
  const MAP_SETTLE_MS = 150;
  let mapFrame = 0;
  let mapSettle = 0;
  let mapDrawMs = 0;
  /** Pan/zoom: store the view now, redraw on the next frame (line widths, labels and the scale bar follow the zoom). */
  function setMapView(v: View): void {
    if (!mapFit) return;
    syncMapView(v);
    hideMapTip();
    if (mapFrame) return;
    mapFrame = requestAnimationFrame(() => {
      mapFrame = 0;
      const svg = els.map.querySelector('svg');
      if (!svg || !mapFit || mapDrawMs <= MAP_SLOW_MS) return renderMap();
      const vb = viewBox(mapFit, mapView);
      svg.setAttribute('viewBox', `${vb.x0} ${vb.y0} ${vb.w} ${vb.h}`);
      clearTimeout(mapSettle);
      mapSettle = window.setTimeout(renderMap, MAP_SETTLE_MS);
    });
  }

  els.mapZoom.addEventListener('click', (ev) => {
    const btn = (ev.target as Element).closest('button[data-zoom]');
    if (!btn || !mapFit) return;
    const next = Number(btn.getAttribute('data-zoom'));
    if (!Number.isFinite(next) || next <= 0) return;
    // Presets zoom about the current centre; Fit goes back to the leg selection's frame.
    setMapView(next === 1 ? fitView(mapFit) : { ...mapView, k: next });
  });

  let coachPlace: { model: NonNullable<CoachModel>; base: ProgressBase } | null = null;
  /**
   * A boat's place at a moment (coach/progress.ts: the fleet by distance to go along the course), once the
   * race's coach model is ready (asked for here); none from interpolated roundings, or with no course.
   */
  function placeReader(a: RaceAnalysis): ((id: string, t: number) => PlaceRead | null) | undefined {
    if (!ensureCoach(a)) return undefined;
    const model = coach?.model;
    if (!model) return undefined;
    if (coachPlace?.model !== model) coachPlace = { model, base: progressBase(a, model) };
    const { base } = coachPlace;
    return (id, t) => {
      const at = progressAt(a, model, base, t);
      const r = at.byId.get(id);
      return r && !r.est ? { place: r.place, of: at.of } : null;
    };
  }

  /** The fix or gap under the pointer (the selected boat's within 40 px, else anyone's within 8; more for a finger): tooltip and dot. */
  function showMapTip(ev: PointerEvent, touch: boolean): void {
    const a = analysis;
    const svg = els.map.querySelector('svg');
    if (!a || !svg || !mapFit) return;
    const p = mapPointsNow(a);
    const rect = svg.getBoundingClientRect();
    const [x, y] = clientToChart(mapFit, mapView, rect, ev.clientX, ev.clientY);
    const vb = viewBox(mapFit, mapView);
    // Map units per css px at this zoom: pick radii and the dot stay the same size on screen.
    const px = 1 / (Math.min(rect.width / vb.w, rect.height / vb.h) || 1);
    const pick = pickMapPoint(p, x, y, (touch ? 44 : 40) * px, (touch ? 20 : 8) * px, highlight);
    if (!pick) return hideMapTip();
    let dot = svg.querySelector<SVGCircleElement>('circle.sog-hover');
    if (!dot) {
      dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('class', 'sog-hover');
      svg.append(dot);
    }
    const [cx, cy] = pickAt(p, pick, x, y);
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', String(4 * px));
    dot.setAttribute('stroke-width', String(1.5 * px));
    const legLine = trackColour === 'sog' ? (l: number) => sogHoverLeg(a, l, legSel, sogScale) : undefined;
    els.mapTip.innerHTML = mapTipHtml(mapTipLines(a, p, pick, { legLine, placeAt: placeReader(a) }));
    els.mapTip.hidden = false;
    // Beside the pointer, above it; flipped left near the right edge and below near the top, and kept inside the map.
    const wrap = els.mapTip.parentElement!.getBoundingClientRect();
    const [w, h] = [els.mapTip.offsetWidth, els.mapTip.offsetHeight];
    const left = ev.clientX - wrap.left;
    const top = ev.clientY - wrap.top;
    const fit = (v: number, room: number): number => Math.max(0, Math.min(v, room));
    els.mapTip.style.left = `${fit(left + 12 + w > wrap.width ? left - 12 - w : left + 12, wrap.width - w)}px`;
    els.mapTip.style.top = `${fit(top - h - 10 < 0 ? top + 16 : top - h - 10, wrap.height - h)}px`;
  }
  /** What the pointer can pick: the scrubber frame's fixes and boats; zoomed in tight, the full-rate fixes near the view; else every drawn fix. */
  function mapPointsNow(a: RaceAnalysis): MapPoints {
    if (scrubT != null && scrubData) {
      if (scrubPts?.f !== scrubData) scrubPts = { f: scrubData, p: scrubPoints(a, scrubData) };
      return scrubPts.p;
    }
    const full = mapFullRate(a);
    if (mapPts?.a !== a || mapPts.leg !== legSel || mapPts.full !== full || (full && mapPts.view !== mapView)) {
      mapPts = { a, leg: legSel, full, view: mapView, p: full ? trackPointsFull(a, legSel, mapView, full) : trackPoints(a, legSel) };
    }
    return mapPts.p;
  }
  function hideMapTip(): void {
    els.map.querySelector('circle.sog-hover')?.remove();
    els.mapTip.hidden = true;
  }
  let hoverFrame = 0;
  let hoverEv: PointerEvent | null = null;
  // Mouse: on hover (not while dragging the map). Touch and pen: on a clean tap (panzoom's onTap), so it never fights a pan or pinch.
  els.map.addEventListener('pointermove', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    if (ev.buttons) return hideMapTip();
    hoverEv = ev;
    if (!hoverFrame) {
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        if (hoverEv) showMapTip(hoverEv, false);
      });
    }
  });
  els.map.addEventListener('pointerleave', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    hoverEv = null;
    hideMapTip();
  });

  attachPanZoom(els.map, {
    getBox: () => mapFit,
    getView: () => mapView,
    setView: setMapView,
    getRect: () => (els.map.querySelector('svg') ?? els.map).getBoundingClientRect(),
    onTap: (ev) => showMapTip(ev, ev.pointerType !== 'mouse'),
    onGesture: retireHint,
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
      else if (tab === 'coach') renderCoach();
      else renderStartSog();
    }
    if (full) return queueFull();
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
    } else if (t === 'race') {
      renderPlaces();
      topScrolls[1].update();
    } else renderCoach();
  }

  /** Show tab `t`: tab and panel state, the URL hash (replaced, not pushed), the saved view; redraw its charts. */
  function setTab(t: Tab, opts: { focus?: boolean; scroll?: boolean; boot?: boolean } = {}): void {
    const changed = t !== tab;
    tab = t;
    for (const k of tabs) {
      const on = k === t;
      els.tabBtn[k].setAttribute('aria-selected', String(on));
      els.tabBtn[k].tabIndex = on ? 0 : -1;
      els.panel[k].hidden = !on;
    }
    // At boot a link without a hash stays as it is on Start (a restored Race tab gets its hash).
    const keep = opts.boot && !location.hash && t === DEFAULT_TAB;
    if (!keep && tabFromHash(location.hash, tabs) !== t) history.replaceState(history.state, '', withTabHash(location.href, t));
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
    const t = parseTab(btn?.id.replace(/^tab-/, ''), tabs);
    if (t) setTab(t);
  });
  els.tabs.addEventListener('keydown', (ev) => {
    const t = tabForKey(tab, ev.key, tabs);
    if (!t) return;
    ev.preventDefault();
    setTab(t, { focus: true });
  });
  addEventListener('hashchange', () => {
    const t = tabFromHash(location.hash, tabs);
    if (t && t !== tab) setTab(t);
  });
  setTab(tab, { scroll: false, boot: true });
  // On a phone the boat strip sticks to the top; the tabs stick just under it.
  // --tabs-h keeps the expand button sticky just below both.
  if (typeof ResizeObserver !== 'undefined') {
    const stick = (): void => {
      els.digest.style.setProperty('--boatbar-h', `${els.boats.offsetHeight}px`);
      els.digest.style.setProperty('--tabs-h', `${els.tabs.offsetHeight}px`);
    };
    const ro = new ResizeObserver(stick);
    ro.observe(els.boats);
    ro.observe(els.tabs);
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
  // The boat a nearby-dot readout belongs to, so a sloppy tap still selects it after the redraw.
  let placeTipId: string | null = null;
  function showPlaceTip(ev: PointerEvent): void {
    const svg = els.places.querySelector('svg');
    if (!svg) {
      els.placesTip.hidden = true;
      placeTipId = null;
      return;
    }
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const k = (vb.width || rect.width) / (rect.width || 1);
    const dots = [...svg.querySelectorAll<SVGCircleElement>('circle.pc-dot[data-tip]')].map((el) => ({
      el,
      cx: Number(el.getAttribute('cx')),
      cy: Number(el.getAttribute('cy')),
      tip: el.getAttribute('data-tip') ?? '',
    }));
    const hit = nearestPlaceDot(dots, (ev.clientX - rect.left) * k, (ev.clientY - rect.top) * k, ev.pointerType === 'mouse' ? PLACE_TIP_MOUSE_REACH : PLACE_TIP_TOUCH_REACH);
    if (!hit) {
      els.placesTip.hidden = true;
      placeTipId = null;
      return;
    }
    placeTipId = hit.el.closest('g.pc-boat[data-id]')?.getAttribute('data-id') ?? null;
    els.placesTip.textContent = hit.tip;
    els.placesTip.hidden = false;
    const wrap = els.placesTip.parentElement!.getBoundingClientRect();
    const r = hit.el.getBoundingClientRect();
    const left = r.left + r.width / 2 - wrap.left;
    const flip = left + 12 + els.placesTip.offsetWidth > wrap.width;
    els.placesTip.style.left = `${Math.max(0, flip ? left - 12 - els.placesTip.offsetWidth : left + 12)}px`;
    els.placesTip.style.top = `${Math.max(0, r.top - wrap.top - els.placesTip.offsetHeight - 6)}px`;
  }
  els.places.addEventListener('pointermove', showPlaceTip);
  els.places.addEventListener('pointerdown', showPlaceTip);
  els.places.addEventListener('pointerleave', (ev) => {
    if (ev.pointerType === 'mouse') {
      els.placesTip.hidden = true;
      placeTipId = null;
    }
  });
  els.places.addEventListener('click', (ev) => {
    const g = (ev.target as Element).closest('g.pc-boat[data-id]');
    const tip = !els.placesTip.hidden ? els.placesTip.textContent : null;
    // A tap near a dot (missed circle, hit the line or the chart) still selects that boat.
    const id = g?.getAttribute('data-id') ?? (tip ? placeTipId : null);
    // Tapping empty chart clears the selection, as on the start chart.
    toggleHighlight(id);
    // A tap that showed a readout keeps it up after the redraw (the SVG is replaced).
    if (tip) {
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
    if (highlight) syncCoachBoat(highlight);
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
      if (highlight) syncCoachBoat(highlight);
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
      if (highlight) syncCoachBoat(highlight);
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

  // Full screen: the card's chart and its controls move into the overlay (their listeners go with them) and back.
  let fullUndo: (() => void)[] = [];
  let fullLock: ScrollLock | null = null;
  /** The chart last closed, for putting focus back on its button. */
  let fullClosed: Full | null = null;
  /** Full screen, Colour: Boat: each boat's colour (small fleets); Speed has its own key. */
  function renderFullKey(): void {
    const key = full === 'start' && startColour === 'boat' && analysis ? startBoatKey(analysis) : '';
    els.fsBoatKey.innerHTML = key;
    els.fsBoatKey.hidden = !key;
  }
  /** Redraw what sizes itself to the overlay (the start chart keeps its zoom). */
  function redrawFull(): void {
    if (!analysis) return;
    if (full === 'start') fitStart(analysis, true);
    else if (full === 'places') renderPlaces();
  }
  let fullFrameReq = 0;
  let fullSize = '';
  /** On resize or rotation: redraw once the overlay has a new size. */
  function queueFull(): void {
    if (!full || fullFrameReq) return;
    fullFrameReq = requestAnimationFrame(() => {
      fullFrameReq = 0;
      const size = `${els.fsBody.clientWidth}x${els.fsBody.clientHeight}`;
      if (full && size !== fullSize) {
        fullSize = size;
        redrawFull();
      }
    });
  }
  const fullscreen = createFullscreen({
    doc: document,
    win: window,
    history,
    href: () => location.href,
    target: els.fs,
    onOpen: () => {
      const f = full!;
      const parts: Record<Full, [HTMLElement[], HTMLElement[], HTMLElement[]]> = {
        // The key: the speed key and the card's own chip line + ⓘ, the same as inline.
        start: [[els.startZoom.parentElement!], [els.startKey, els.startCap], [els.start]],
        map: [[els.legend.parentElement!], [els.speedKey, els.mapCap], [els.map.parentElement!]],
        places: [[], [els.placesCap], [els.places.parentElement!]],
      };
      const [tools, key, body] = parts[f];
      fullLock = lockScroll(window, document.body);
      fullUndo = [inertOthers(document.body, els.fs), moveNodes(tools, els.fsTools), moveNodes(key, els.fsKey), moveNodes(body, els.fsBody)];
      els.fs.setAttribute('aria-label', FULL_LABEL[f]);
      els.fs.dataset.chart = f;
      els.fs.hidden = false;
      document.documentElement.classList.add('fs-on');
      fullSize = `${els.fsBody.clientWidth}x${els.fsBody.clientHeight}`;
      renderFullKey();
      redrawFull();
      els.fsClose.focus();
    },
    onClose: () => {
      const f = full!;
      full = null;
      fullClosed = f;
      els.fs.hidden = true;
      els.fsRotate.hidden = true;
      delete els.fs.dataset.chart;
      renderFullKey();
      // The page live again first (html overflow back, not inert, the chart back in its card and redrawn for it),
      // then the body unlocked at the same scroll and focus back on the expand button. Leaving native fullscreen
      // Chrome resets both on its way out, so `onSettled` puts them back again once it's out.
      document.documentElement.classList.remove('fs-on');
      for (const undo of fullUndo.reverse()) undo();
      fullUndo = [];
      if (analysis && f === 'start') {
        fitStart(analysis, true);
        startW = els.start.clientWidth;
      } else if (f === 'places') renderPlaces();
      fullLock?.release();
      els.fullBtn[f].focus({ preventScroll: true });
    },
    onSettled: () => {
      restoreAfterFull();
      // And once more next frame, after any scroll or focus change of the exit itself.
      requestAnimationFrame(restoreAfterFull);
    },
  });
  /** Closed full screen: the page's scroll where it was and focus on the chart's expand button (unless reopened). */
  function restoreAfterFull(): void {
    if (full || !fullClosed) return;
    fullLock?.rescroll();
    const btn = els.fullBtn[fullClosed];
    if (document.activeElement !== btn) btn.focus({ preventScroll: true });
  }
  for (const f of ['start', 'map', 'places'] as const) {
    els.fullBtn[f].addEventListener('click', () => {
      if (!analysis || fullscreen.isOpen) return;
      full = f;
      fullscreen.open();
    });
  }
  els.fsClose.addEventListener('click', () => fullscreen.close('button'));
  els.fsRotateDismiss.addEventListener('click', () => {
    rotateDismissed = true;
    els.fsRotate.hidden = true;
  });
  // Tab cycles within the overlay.
  els.fs.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return;
    const items = [...els.fs.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
      (el) => el.getClientRects().length > 0,
    );
    const next = trapFocus(items, document.activeElement as HTMLElement | null, ev.shiftKey);
    if (next) {
      ev.preventDefault();
      next.focus();
    }
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(queueFull).observe(els.fsBody);
  addEventListener('orientationchange', queueFull);

  let showGen = 0;
  /** Show an analysis with leg/boat/sort reset, or set from `restore` (dropping what this race lacks). False if superseded. */
  async function show(p: Promise<RaceAnalysis>, restore?: ViewState): Promise<boolean> {
    const g = ++showGen;
    els.digest.classList.add('loading');
    try {
      const a = await p;
      if (g !== showGen) return false;
      analysis = a;
      openScrub(a);
      const v = restore ? applyView(a, restore) : null;
      highlight = v?.boat ?? null;
      // A shared `boat=` wins over lastView so the link opens that boat.
      highlight = coachHighlight(coachBoat, highlight, a.boats.map((b) => b.id));
      if (highlight) {
        coachBoat = highlight;
        setUrl({ [BOAT_PARAM]: highlight });
      }
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
      const off = officialFor(outcomeOf(), listedOf(division, raceNumber));
      const reg = regatta;
      const logs = vkx.buffersFor(id, division, raceNumber);
      const req = { type: 'live' as const, eventId: id, regatta: reg, division, raceNumber, allCompetitors, classLabel, ...(off ? { official: off } : {}), ...(logs.length ? { vkx: logs } : {}) };
      if (!(await show(run(req), view))) return 'superseded';
      current = { eventId: id, division, raceNumber };
      if (analysis) vkx.raceShown({ eventId: id, division, raceNumber, regatta: reg, analysis });
      setUrl({ event: id, div: division, race: String(raceNumber), nc: allCompetitors ? NC_ALL : null });
      save();
      setNotice('');
      reapplyOfficial();
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

  /** The Race select from the race list (official numbers, practice, rebuilt races), keeping the selection. */
  function renderRaceOptions(): void {
    if (!raceList) return;
    const keep = els.race.value;
    const multi = new Set(raceList.races.map((r) => r.division)).size > 1;
    els.race.innerHTML = raceList.races
      .map((r) => `<option value="${esc(r.division)}|${r.raceNumber}">${esc(raceOptionText(r, multi))}</option>`)
      .join('');
    const values = new Set(raceList.races.map((r) => `${r.division}|${r.raceNumber}`));
    if (values.has(keep)) els.race.value = keep;
    else if (current && values.has(`${current.division}|${current.raceNumber}`)) els.race.value = `${current.division}|${current.raceNumber}`;
    const first = raceList.races[0];
    els.race.title = first ? `Times Eastern (${easternZone(first.gunMs)})` : '';
  }

  /** Re-list with what enrich() has found; re-analyse the race on screen if its official results changed. */
  function refreshList(found?: ReadonlyMap<string, readonly OrphanFound[]>): void {
    if (!regatta) return;
    raceList = buildRaceList(currentDoc(regatta), { links: linksOf(outcomeOf()), ...(found ? { orphans: found } : orphansFound ? { orphans: orphansFound } : {}) });
    renderRaceOptions();
    // The header names the race as the picker does: relabel it too (title, RS tag and chips), and the Coach strip.
    renderSummary();
    renderCoach();
    reapplyOfficial();
  }

  /** The race on screen was analysed without (or with) official results it should (not) have: load it again, keeping the view. */
  function reapplyOfficial(): void {
    const a = analysis;
    if (!a || !current || a.meta.division !== current.division || a.meta.raceNumber !== current.raceNumber || current.eventId !== eventId) return;
    const want = officialFor(outcomeOf(), listedOf(current.division, current.raceNumber)) != null;
    if (want !== (a.meta.results?.places === 'official')) void loadRace(current.division, current.raceNumber);
  }

  let orphansFound: Map<string, OrphanFound[]> | null = null;
  let enrichGen = 0;
  /**
   * After the race list first renders: link official results (or follow `ys=`), relabel, then look
   * for unlisted races in the feed (bounded: data/orphans.ts) and list them. Never blocks the first
   * race; every failure ends as a chip with RaceSense numbering kept.
   */
  async function enrich(id: string, req: number): Promise<void> {
    const gen = ++enrichGen;
    const stale = (): boolean => gen !== enrichGen || req !== eventReq || id !== eventId;
    const base = baseRegatta;
    if (!base) return;
    const doc = currentDoc(base);
    if (ysParam === 0) official = { status: 'off' };
    else {
      official = { status: 'pending' };
      renderRaceHead();
      const landing = events.find((e) => e.eventId === id);
      const outcome = await linkOfficial(httpYsSource(), linkRequest(doc, landing, ysParam ? { eventId: ysParam, cls: yscParam ?? null } : null));
      if (stale()) return;
      official = { status: 'done', outcome };
    }
    orphansFound = null;
    regatta = base;
    refreshList();
    const contexts = orphanContexts(doc, raceList!, outcomeOf());
    const fetchRows = probeFetcher(id, eventFinished(doc));
    const found = new Map<string, OrphanFound[]>();
    feed = { status: 'running', used: 0, max: PROBE_BUDGET, found: 0, exhausted: false };
    renderRaceHead();
    for (const c of contexts) {
      const before = feed.used;
      const r = await discoverOrphans(c, fetchRows, {
        budget: PROBE_BUDGET - before,
        onProgress: (u) => {
          if (stale()) return;
          feed = { ...feed, used: before + u };
          renderRaceHead();
        },
      });
      if (stale()) return;
      feed = { ...feed, used: before + r.used, exhausted: feed.exhausted || r.exhausted };
      if (r.found.length) found.set(c.division, r.found);
    }
    feed = { ...feed, status: 'done', found: [...found.values()].reduce((n, l) => n + l.length, 0) };
    orphansFound = found;
    regatta = mergeOrphans(base, found);
    refreshList(found);
  }

  /** The ⓘ form: link official results by hand (`ys=`), turn them off (`ys=0`) or back to automatic. */
  function setYs(v: number | undefined): void {
    ysParam = v;
    yscParam = undefined;
    setUrl({ [YS_PARAM]: v === undefined ? null : String(v), [YSC_PARAM]: null });
    save();
    if (eventId) void enrich(eventId, eventReq);
  }
  els.raceHead.addEventListener('submit', (ev) => {
    const form = (ev.target as HTMLElement).closest<HTMLFormElement>('form[data-ys-form]');
    if (!form) return;
    ev.preventDefault();
    const input = form.elements.namedItem('ys') as HTMLInputElement | null;
    const id = input ? parseYsEventId(input.value) : null;
    if (!id) {
      input?.setCustomValidity('Paste a yachtscoring.com/emenu/… link or an event number');
      input?.reportValidity();
      return;
    }
    input?.setCustomValidity('');
    setYs(id);
  });
  els.raceHead.addEventListener('input', (ev) => (ev.target as HTMLInputElement).setCustomValidity?.(''));
  els.raceHead.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-ys]');
    if (b) setYs(b.dataset.ys === 'off' ? 0 : undefined);
  });

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
      // A cached copy with no finishers may predate them; that refetches once before 'empty'.
      const next = await fetchUsableRegatta(id, (r) => listRaces(currentDoc(r)).some((x) => x.finishers > 0));
      if (req !== eventReq) return 'superseded'; // a newer pick
      const doc = currentDoc(next);
      // Zero-finisher races are listed too (tracker or official finishes); bogus ones are hidden.
      let list = buildRaceList(doc);
      if (!list.races.length) return 'empty';
      if (id !== eventId) {
        // Another event: the Regatta view's queue for the last one stops (its cache stays, keyed by event).
        regattaRunner.want([]);
        official = { status: ysParam === 0 ? 'off' : 'pending' };
        feed = { status: 'idle', used: 0, max: 0, found: 0, exhausted: false };
      }
      baseRegatta = next;
      regatta = next;
      raceList = list;
      eventId = id;
      renderEventOptions();
      renderRaceOptions();
      els.race.disabled = false;
      // The picker is on screen before official matching or the feed probe (those only relabel).
      const enrichment = enrich(id, req);
      // A rebuilt race (`race=` its gun minute) exists only once the feed check has run: wait for it.
      if (want && isOrphanKey(want.raceNumber) && !findListed(list, want.division, want.raceNumber)) {
        await enrichment;
        if (req !== eventReq) return 'superseded';
        list = raceList ?? list;
      }
      const races = list.races;
      const pick = pickRace(races, want, defaultRace(doc), opts.strict);
      if (!pick) return 'missing';
      els.race.value = `${pick.division}|${pick.raceNumber}`;
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
    // A hand-set official link belongs to the event it was set on.
    if (ysParam !== undefined) {
      ysParam = undefined;
      yscParam = undefined;
      setUrl({ [YS_PARAM]: null, [YSC_PARAM]: null });
    }
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
  /** Open a race of the list, as the Race menu does (the menu shows it; `restore` sets the view, else it carries over or resets). */
  function chooseRace(division: string, raceNumber: number, restore?: ViewState): void {
    els.race.value = `${division}|${raceNumber}`;
    void loadRace(division, raceNumber, restore);
  }
  els.race.addEventListener('change', () => {
    const [div, n] = els.race.value.split('|');
    chooseRace(div, Number(n));
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
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || els.search.disabled || full) return;
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
