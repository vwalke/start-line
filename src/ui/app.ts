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
import { type BoatResult, type FullRateTrack, type RaceAnalysis } from '../analysis/types';
import type { StartReplay } from '../analysis/startReplay';
import { linkOfficial, type LinkOutcome } from '../data/official/link';
import { httpYsSource, parseYsEventId } from '../data/official/yachtscoring';
import { PROBE_BUDGET, discoverOrphans, isOrphanKey, type OrphanFound } from '../data/orphans';
import { buildRaceList, findListed, type ListedRace, type RaceList } from '../data/raceList';
import { NO_TRACKS, currentDoc, defaultRace, findRace, listRaces, tzOffsetMs } from '../data/racesense/adapter';
import { fetchLanding, fetchRegatta, fetchUsableRegatta } from '../data/racesense/api';
import { gunLive, liveTag, raceLive, unaccountedBoats } from '../data/live';
import type { LandingEvent, RegattaDoc, RegattaResponse } from '../data/racesense/types';
import { eventFinished, linkRequest, linksOf, mergeOrphans, officialFor, officialForLoad, orphanContexts, probeFetcher } from '../data/recovery';
import { raceWindowsFromListed } from '../data/vkx/match';
import type { WorkerRequest, WorkerResponse } from '../worker';
import { boatList, findingsClick, findingsList } from './boats';
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
import { askLogHtml, askPanelHtml, askPanelShown, askStarters, askStartersHtml, createAskCoach, leftText, type AskPanelState } from './coachAsk';
import { raceAskContext, regattaAskContext } from './coachAskContext';
import type { AskContext } from '../analysis/coach/askContext';
import type { AskIds } from '../data/askCoach/protocol';
import { cardSpans, coachCardsHtml } from './coachCards';
import { legStoriesHtml } from './coachLegs';
import { buildReport, reportBoatFor, reportFromUrl, reportHref } from './report';
import { reportHtml, reportThumb } from './reportView';
import { summarizeRegatta } from '../analysis/coach/regatta';
import { pickerOptions, matchCountLabel, searchKeyAction } from './eventSearch';
import {
  applyView,
  clearLastView,
  isTransientError,
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
  mapFollowInput,
  startBoatKey,
  startFitBox,
  startFullFrame,
  startScale,
  startSnapshot,
  scrubFrame,
  scrubRungs,
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
  WINDOW_TRAIL,
  clampTime,
  fadingTrailMs,
  paramOfTime,
  parseSpeed,
  parseTParam,
  parseTrail,
  playStep,
  scrubLabel,
  scrubParams,
  scrubWindow,
  timeOfParam,
  trailWindow,
  type Speed,
  type Trail,
} from './scrub';
import {
  REPLAY_PARAM,
  REPLAY_PRE_S,
  REPLAY_TRAIL,
  replayControls,
  replayPendFromUrl,
  replayPending,
  replayArrive,
  replayRaceKey,
  replayView,
  startReplayLinks,
  type ReplayPend,
} from './replay';
import {
  NO_FOCUS,
  cardMapActions,
  cardRoute,
  focusArrive,
  focusFrom,
  focusParams,
  focusPendFromUrl,
  focusPlayFrom,
  focusTime,
  focusTrail,
  focusView,
  mapFocusLegend,
  trailAfterFocus,
  withMapActions,
  focusColouring,
  focusOnPop,
  keyLeg,
  legStep,
  shownLeg,
  FOCUS_KEYS,
  LEG_STATE_KEY,
  stampedLeg,
  type Colouring,
  type LegBefore,
  type LegEvent,
  legFocus,
  legMapHref,
  type MapFocus,
} from './mapLink';
import { mapKey, raceNotesKey, startKey } from './captions';
import { mapTipHtml, mapTipLines, mapTipPos, pickAt, pickMapPoint, type MapPoints, type PlaceRead, type TipPoint } from './mapPoints';
import { createFullscreen, inertOthers, lockScroll, moveNodes, trapFocus, type ScrollLock } from './fullscreen';
import { boatLabel, esc, f1, gunTimeLine, legCount } from './format';
import { dismissHint, hintStore, showHint } from './hints';
import { renderKeepOpen, renderKeyLine } from './info';
import { START_NAMES_KEY, parseStartNames, startNamesControls } from './labels';
import { laneCueSecond, mountLaneSnapshots } from './laneSnapshotsView';
import { attachTopScroll } from './hscroll';
import { attachPanZoom } from './panzoom';
import { gunReadoutHtml } from './gunReadout';
import { ATTEMPT_PARAM, attemptNumbered, earlierAttempts, parseAttemptParam, type EarlierAttempt } from '../data/attempts';
import { attemptButtonsHtml, attemptNote, attemptTitle } from './attemptView';
import { latestLoader } from './latestOnly';
import { keepScroll } from './keepScroll';
import { liveArmDelay, liveLabel, liveScrubT, liveView, startLivePoller, waitingNotice, type LivePoller, type LiveTick } from './live';
import { biasBullets, lineChips } from './startLine';
import { downloadSvgAsPng, pageCss, startPngName, startPngSvg } from './startPng';
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
  needsCoach,
  parseRankBy,
  parseSogScale,
  parseSpeedTop,
  parseTrackColour,
  readPref,
  speedKey,
  writePref,
} from './speed';
import { vmgHoverLeg, vmgKey, vmgTipLine } from './vmg';
import { gainKey, gainTipLine } from './gain';
import { legsNotesHtml, legsTable, startNotesHtml, startTable, toggleSort, type SortState } from './table';
import { followAfter, followCam, followStep, followTarget, reducedMotion, resetFollow } from './follow';
import { MAP_SETTLE_MS, mapPaint } from './mapPaint';
import { paintTrails } from './trailLayer';
import { paintRungs } from './rungs';
import { paintWindArrow, windArrowOf } from './windArrow';
import { mapScreenOf, type MapScreen } from './mapExtent';
import { ladderReader, type LadderNow } from '../analysis/coach/ladderNow';
import { boatsZoomTarget, carryView, clampView, clientToChart, fitView, presetActive, viewBox, zoomPreset, type Box, type View } from './view';
import { createVkxUpload } from './vkxUpload';
import { createPaywall, hereWithout, lockedRange, startRace } from './paywall';
import { eventCardHtml, eventCardView } from './eventCard';
import { NOTIFY_PARAM, createAlerts, handleNotify, handleNotifyParam, notifyButtonHtml, watchAlerts, withNotify } from './notify';
import { eventStarted, upcomingEvents } from '../data/upcoming';
import { createNav, popAction, type Screen } from './nav';
import { raceId, setTrackAuth, setTrackPage, track } from './track';
import { setPageState } from '../feedback/state';
import { freeRacesOf, type FreeRaces } from '../data/freeRace';
import { isPaywallError } from '../data/paywall';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The charts that open full screen, and the overlay's label for each. */
type Full = 'start' | 'map' | 'places';
const FULL_LABEL: Record<Full, string> = {
  start: 'Start chart, full screen',
  map: 'Race Viewer, full screen',
  places: 'Rounding & Finish Positions, full screen',
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
    mapReplay: $('map-replay'),
    mapFocus: $('map-focus'),
    startReplay: $('start-replay'),
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
    startGun: $('start-gun'),
    startExport: $('start-export'),
    startPng: $('start-png') as HTMLButtonElement,
    attemptCard: $('attempt-card'),
    attemptTitle: $('attempt-title'),
    attemptNote: $('attempt-note'),
    attemptTools: $('attempt-tools'),
    attemptChart: $('attempt-chart'),
    attemptCap: $('attempt-cap'),
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
    report: $('report'),
    reportOpen: $('report-open'),
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
  /** The URL's history entries (nav.ts): a user's move to another event, race, tab, the report or a map focus (a leg's view, a card's window) pushes one. */
  const nav = createNav({ history, href: () => location.href, keyParams: FOCUS_KEYS });
  const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  /** Paywall (only when /api/auth/me says it is on): a lock card instead of the digest for a race the viewer can't open. */
  /** The signed-in user's race emails (notify.ts): the toggles and the account sheet's list. */
  const alerts = createAlerts();
  const paywall = createPaywall({
    onChange: () => paywallChanged(),
    notice: (text) => setNotice(text),
    eventTitle: (id) => titleOf(id),
    alerts,
  });
  // paywall.ready doesn't call onChange: the toggles re-render through the store instead, when /api/auth/me
  // answers (load starts) and again when the list is in. A card drawn before then has no toggle yet.
  watchAlerts(paywall.ready, alerts, () => {
    if (cardEventId) renderEventCard();
    else renderSummary();
  });
  /** Signed out: the sheet, coming back here with `notify=1`. */
  const notifySignIn = (): void => paywall.signIn(withNotify(hereWithout(location.href)));
  /** A Notify me click: the only way the emails are turned on. */
  const notify = (id: string): void => void handleNotify(id, paywall.me(), { signIn: notifySignIn, alerts });
  const authOf = (me: ReturnType<typeof paywall.me>): 'yes' | 'no' | 'unknown' => (me.paywall ? (me.user ? 'yes' : 'no') : 'unknown');
  void paywall.ready.then((me) => setTrackAuth(authOf(me)));
  const freeMemo = new WeakMap<RegattaResponse, FreeRaces>();
  /** Race 1 of each division, from the regatta as fetched (rebuilt races are never free). */
  const freeOf = (r: RegattaResponse): FreeRaces => {
    let f = freeMemo.get(r);
    if (!f) freeMemo.set(r, (f = freeRacesOf(r)));
    return f;
  };
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
    // The map's over-early replays, likewise.
    const replayWait = replayWaits.get(msg.id);
    if (replayWait) {
      replayWaits.delete(msg.id);
      replayWait(msg.type === 'start-replay' ? msg.replays : null);
      return;
    }
    // An earlier start attempt's analysis (its progress messages are left out).
    const attemptWait = attemptWaits.get(msg.id);
    if (attemptWait) {
      if (msg.type === 'progress') return;
      attemptWaits.delete(msg.id);
      attemptWait(msg.type === 'attempt' ? msg.analysis : new Error(msg.type === 'error' ? msg.message : 'unexpected reply'));
      return;
    }
    // Coach requests count down from -1, apart from the race loads.
    const coachWait = coachPending.get(msg.id);
    if (coachWait) {
      coachPending.delete(msg.id);
      coachWait(msg.type === 'coach-raw' ? msg.raw : null);
      return;
    }
    if (msg.id !== reqId || msg.type === 'coach-raw' || msg.type === 'regatta-race' || msg.type === 'full-rate' || msg.type === 'start-replay' || msg.type === 'attempt') return; // a newer request superseded this one
    const p = pending.get(msg.id);
    // A live race's refresh runs in the background: no status line.
    if (msg.type === 'progress') {
      if (msg.id !== quietReq) setStatus(msg.message);
    } else if (msg.type === 'done') p?.resolve(msg.analysis);
    else if (msg.type === 'error') p?.reject(new Error(msg.message));
    if (msg.type !== 'progress') pending.delete(msg.id);
  };
  /** The worker request of a live race's refresh in flight (its progress isn't shown). */
  let quietReq = 0;
  const run = (req: DistributiveOmit<WorkerRequest, 'id'>, quiet = false): Promise<RaceAnalysis> =>
    new Promise((resolve, reject) => {
      const id = ++reqId;
      if (quiet) quietReq = id;
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
  const attemptWaits = new Map<number, (r: RaceAnalysis | Error) => void>();
  const replayWaits = new Map<number, (r: StartReplay[] | null) => void>();
  /** The over-early boats' start facts of a race, from the worker's raw fixes (null: it no longer holds that race, or failed: no replay). */
  const startReplaysOf = (a: RaceAnalysis): Promise<StartReplay[] | null> =>
    new Promise((resolve) => {
      const id = --coachReq;
      replayWaits.set(id, resolve);
      worker.postMessage({ id, type: 'start-replay', key: raceKeyOf(a) } satisfies WorkerRequest);
    });
  // Open by default but worked out only while the Start tab is on screen (remeasure draws it on show).
  const lanes = mountLaneSnapshots(
    $<HTMLDetailsElement>('lane-snapshots'),
    () => ({ a: analysis, me: highlight, group: coachGroup }),
    startReplaysOf,
    () => tab === 'start' && !reportOn,
  );

  let analysis: RaceAnalysis | null = null;
  // ---- A race in progress (data/live.ts raceLive, ui/live.ts): refreshed about each minute while on screen (refreshLive).
  /** The live race on screen: its poller, when it was last brought up to date (load or refresh) and how many refreshes. */
  let live: { key: string; poller: LivePoller; updatedMs: number; refreshes: number } | null = null;
  /**
   * A race opened before any boat's track is in (its gun to come, mostly: waitForTracks): tried again each minute (`poller`)
   * from its live window on, a timer (`arm`) until then.
   */
  let waiting: { key: string; poller: LivePoller | null; arm: ReturnType<typeof setTimeout> | undefined } | null = null;
  /** The live mark the gun line has now (renderSummary). */
  let liveMarkShown = '';
  const liveKeyOf = (c: { eventId: string; division: string; raceNumber: number }): string => `${c.eventId}|${c.division}|${c.raceNumber}`;
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
  /** The leg selection a focus (a leg's view drawing its own leg) replaced, put back when it's left (mapLink.ts focusLeg); null: none replaced. */
  let legBefore: LegBefore | null = null;
  /** The user's own leg selection (saved): the one a leg's view replaced while one is open. */
  const userLeg = (): number | null => (legBefore ? legBefore.leg : legSel);
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
  /** Point details: the map's point lookup for a race and leg, built on first hover or tap. */
  let mapPts: { a: RaceAnalysis; leg: number | null; full: FullRateSet | null; view: View; p: MapPoints } | null = null;
  let fitBox: Box | null = null;
  let view: View = { cx: 0, cy: 0, k: 1 };
  /** The chart open full screen, if any (it shares the selection, zoom and names with the page). */
  let full: Full | null = null;
  let regatta: RegattaResponse | null = null;
  /** The event whose races are loaded (and shown in the digest); '' until one loads. */
  let eventId = '';
  /** Every listed event that has started, most recent first; the search filters this. */
  let events: LandingEvent[] = [];
  /** Events starting within the next two weeks, soonest first (data/upcoming.ts): the picker's Upcoming group. */
  let upcoming: LandingEvent[] = [];
  /** Everything /api/landing lists (names and dates for an event linked from further ahead). */
  let listed: LandingEvent[] = [];
  /** The event on the event card (no races yet: eventCard.ts), shown in place of the digest; '' when none. */
  let cardEventId = '';
  /** Back at the bare /regattas (showPicker): no event on screen, though the last one stays loaded. */
  let pickerShown = false;
  let cardDoc: RegattaDoc | null = null;
  /** The document of the last event loadEvent found with no races, for its card. */
  let emptyDoc: RegattaDoc | null = null;
  const cardEl = document.createElement('div');
  cardEl.id = 'event-card';
  cardEl.className = 'event-card-wrap';
  cardEl.hidden = true;
  els.digest.before(cardEl);
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
  /** Settles once enrich() has linked and listed the official results (or given up), while `official` is pending. */
  let officialLinking: Promise<void> | null = null;
  let feed: FeedCheck = { status: 'idle', used: 0, max: 0, found: 0, exhausted: false };
  const outcomeOf = (): LinkOutcome | null => (official.status === 'done' ? official.outcome : null);
  const listedOf = (division: string, raceNumber: number): ListedRace | undefined => (raceList ? findListed(raceList, division, raceNumber) : undefined);

  /**
   * The history entry on screen keeps the user's leg selection (it isn't in the URL), for Back / forward to put back
   * (popFocus); written only when it changes.
   */
  function stampLegs(): void {
    const leg = userLeg();
    if (stampedLeg(history.state, Infinity) === leg) return;
    const s: unknown = history.state;
    try {
      history.replaceState({ ...(s && typeof s === 'object' ? s : {}), [LEG_STATE_KEY]: leg }, '', location.href);
    } catch {
      // no history (a sandbox)
    }
  }

  /** Record the race on screen and how it's viewed, so a relaunch can come back to it. */
  function save(): void {
    if (!current || !analysis) return;
    // A load that has swapped `analysis` but not yet `current` (or the reverse) must not mix them.
    if (analysis.meta.division !== current.division || analysis.meta.raceNumber !== current.raceNumber) return;
    if (analysis.meta.eventId != null && analysis.meta.eventId !== current.eventId) return;
    stampLegs();
    // Names for the landing page's "Continue" link (the event's id is all a record needs).
    const title = titleOf(current.eventId);
    const listed = current.eventId === eventId ? listedOf(current.division, current.raceNumber) : undefined;
    writeLastView({
      v: 1,
      ...current,
      ...(allCompetitors ? { allCompetitors: true } : {}),
      leg: userLeg(),
      boat: highlight,
      sort,
      startSort,
      tab,
      ...(ysParam !== undefined ? { ys: ysParam } : {}),
      ...(ysParam && yscParam ? { ysc: yscParam } : {}),
      ...(title !== current.eventId ? { eventTitle: title } : {}),
      ...(listed ? { raceName: raceName(listed) } : {}),
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
    // Never the landing page's URL: the path names the view (nav.ts), under /regattas. Never pushed while full screen is open.
    nav.write(u.href, { push: !full });
  }

  /** The race header's chips and ⓘ (official link, numbering, finishes, feed check); kept open across redraws. */
  function renderRaceHead(): void {
    const m = analysis?.meta;
    const race = m && (m.eventId == null || m.eventId === eventId) ? listedOf(m.division, m.raceNumber) : undefined;
    const k = raceHead({ race, official, feed, results: m?.results, ys: ysParam ?? null, inProgress: !!m?.inProgress });
    renderKeepOpen(els.raceHead, (open) => raceHeadHtml(k, open));
    els.raceHead.hidden = !m;
  }

  /** The race emails' toggle, small, after the gun line: while the event is on (or the emails are), never on a finished one. */
  function raceEmailsToggle(id: string | null | undefined): string {
    if (!id) return '';
    const state = alerts.state(id);
    const end = landingOf(id)?.endMs ?? 0;
    if (!state.on && end > 0 && Date.now() > end + 2 * 86_400_000) return '';
    const html = notifyButtonHtml(id, paywall.me(), undefined, state, { quiet: true });
    return html ? ` · ${html}` : '';
  }

  /** The race title and gun line (`#summary`): re-run whenever the race list is relabelled, as well as on every render. */
  function renderSummary(): void {
    const a = analysis;
    if (!a) return;
    const m = a.meta;
    const listed = m.eventId == null || m.eventId === eventId ? listedOf(m.division, m.raceNumber) : undefined;
    liveMarkShown = liveMarkHtml();
    els.summary.innerHTML = `${raceTitleHtml(m, listed, paywall.free(m.eventId ?? eventId), titleLive(m, listed), liveMarkShown)}
      <p>${esc(gunTimeLine(m.gunMs, m.tzOffsetMs))} ·
      ${a.boats.length} boats · ${legCount(a.legs.length)} ·
      <span class="muted">${esc(m.sourceLabel)}</span>${raceEmailsToggle(m.eventId ?? eventId)}</p>`;
    renderRaceHead();
    vkx.mount(els.raceHead, a);
  }

  /** True while render() runs (a focus left from inside it needs no second render). */
  let rendering = false;
  function render(): void {
    rendering = true;
    try {
      renderNow();
    } finally {
      rendering = false;
    }
  }
  function renderNow(): void {
    const a = analysis;
    if (!a) return;
    syncRacing();
    renderSummary();
    renderStart();
    els.startColour.innerHTML = startColourControls(startColour) + startNamesControls(startNames);
    els.startKey.innerHTML =
      startColour === 'speed'
        ? sogKey(startSogRange(a))
        : '';
    els.startKey.hidden = startColour !== 'speed';
    renderFullKey();
    fitMap(a);
    renderMap();
    askReplays(a);
    renderReplayControls();
    renderFocusLegend();
    els.legend.innerHTML = legLegend(a, shownLeg(legSel, focusOn));
    // In Rank or Boat speed the leg swatches would read as a colour key for the tracks; the buttons stay, the swatches go.
    els.legend.classList.toggle('speed', trackColour !== 'leg');
    // The controls, keys and caption as the leg buttons: in a leg's view, its leg (mapLink.ts keyLeg).
    const k = keyed();
    els.colour.innerHTML = colourControls(trackColour, k.rankBy, k.leg, speedTop, k.sogScale);
    els.speedKey.innerHTML =
      trackColour === 'rank'
        ? speedKey(a, k.leg, k.rankBy, speedTop, highlight)
        : trackColour === 'sog'
          ? k.leg == null && k.sogScale === 'leg'
            ? sogLegKey(a)
            : sogKey(trackSogRange(a, k.leg), k.leg == null ? 'Whole race' : `${a.legs[k.leg]?.name ?? 'This leg'}`)
          : trackColour === 'vmg'
            ? vmgKey(a, coachModelFor(a), k.leg, k.sogScale)
            : trackColour === 'gain'
              ? gainKey(a, coachModelFor(a), k.leg)
              : '';
    els.speedKey.hidden = trackColour === 'leg';
    renderKeyLine(els.mapCap, mapKey(a, { highlight, colour: trackColour, rankBy: k.rankBy, sogScale: k.sogScale, leg: k.leg }));
    renderKeyLine(els.placesCap, placesKey(a));
    els.startTable.innerHTML = startTable(a, highlight, startSort);
    renderKeepOpen(els.startNotes, (open) => startNotesHtml(a, open));
    els.table.innerHTML = legsTable(a, highlight, sort);
    renderKeepOpen(els.legsNotes, (open) => legsNotesHtml(a, open));
    els.boats.innerHTML = boatList(a, highlight, ncOpen);
    const found = splitFindings(a.findings);
    els.startFindings.innerHTML = findingsList(found.start, highlight);
    const gun = gunReadoutHtml(a, highlight);
    els.startGun.innerHTML = gun;
    els.startGun.hidden = !gun;
    // The picture needs a boat with a bow at the gun (its close-up).
    els.startExport.hidden = !(highlight && a.drawings.some((d) => d.id === highlight && d.bow));
    renderAttempt();
    els.startFindingsBox.hidden = !found.start.length && !gun;
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
    renderReport();
    lanes.refresh();
  }

  // ---- Coach: built lazily the first time the tab shows a race.
  const query = new URLSearchParams(location.search);
  let coachGroup: Group = parseGroupParam(query.get(GROUP_PARAM)) ?? defaultLadderGroup();
  /** The coached boat, kept across races: the URL's, then the last one selected. */
  let coachBoat: string | null = parseBoatParam(query.get(BOAT_PARAM));
  let coachEach = true;
  let coachCustomOpen = false;
  let coach: { a: RaceAnalysis; model: CoachModel | null } | null = null;
  /** The fleet's places at any moment (placeReader), from the coach model. */
  let coachPlace: { model: NonNullable<CoachModel>; base: ProgressBase } | null = null;
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
      if (reportOn) renderReport();
    },
  );

  const coachModelOf = (a: RaceAnalysis, raw: CoachRaw | null): CoachModel | null =>
    buildCoach(a, raw?.wind, raw?.crossMs ?? null, raw?.zones ?? null, raw?.heel ?? null, raw?.turns ?? null, raw?.overStart ?? null);
  /** True when the coach model of `a` is ready; else starts building it (the wind from the worker) and re-renders when done. */
  function ensureCoach(a: RaceAnalysis): boolean {
    if (coach?.a === a) return true;
    if (coachBuilding === a) return false;
    coachBuilding = a;
    void coachRawOf(raceKeyOf(a)).then((raw) => {
      if (coachBuilding !== a) return;
      coachBuilding = null;
      coach = { a, model: coachModelOf(a, raw) };
      if (analysis === a) {
        // VMG's and Gain/loss's tracks and key wait for the Coach's wind and ladder: the whole view again (the Coach and the report with it).
        if (needsCoach(trackColour)) return render();
        renderCoach();
        renderReport();
        // The ladder rungs wait for the Coach's ladder (ladderAt).
        if (scrubT != null) drawScrub(a);
      }
    });
    return false;
  }

  /** The coach model of `a` for the map's coloring: undefined while it is on its way (asked for here), null when the race has none. */
  function coachModelFor(a: RaceAnalysis): CoachModel | null | undefined {
    return ensureCoach(a) ? coach!.model : undefined;
  }

  // ---- Report (ui/report.ts, reportView.ts): one printable page for the selected boat, on `#report` or `report=1`; built only while open.
  let reportOn = reportFromUrl(location.search, location.hash);
  function renderReport(): void {
    document.body.classList.toggle('report-on', reportOn);
    els.report.hidden = !reportOn;
    const a = analysis;
    if (!reportOn || !a) return;
    // A cleared selection keeps the boat last selected (coachBoat, still in `boat=`): the report and the URL agree.
    const me = a.boats.find((b) => b.id === reportBoatFor(a, highlight, coachBoat));
    const regattaOn = coachView === 'regatta';
    if (regattaOn && me && official.status !== 'pending') regattaRunner.want(jobsFor(a, me.sail));
    // The Coach's own model and debrief (the same group, the same cache), so the report says what the Coach tab says.
    const model = me && ensureCoach(a) ? coach!.model : undefined;
    if (me && model && (coachDeb?.model !== model || coachDeb.boat !== me.id)) {
      coachDeb = { model, boat: me.id, d: coachDebrief(a, model, me.id) };
      coachSel = null;
    }
    const listed = a.meta.eventId == null || a.meta.eventId === eventId ? listedOf(a.meta.division, a.meta.raceNumber) : undefined;
    const off = officialFor(outcomeOf(), listed);
    const m = buildReport({
      a,
      boat: me?.id ?? null,
      raceName: listed ? raceName(listed) : undefined,
      model,
      deb: model && coachDeb?.model === model ? coachDeb.d : undefined,
      group: coachGroup,
      official: off,
      // Held as pending while official results are being linked, or the race is to be analysed again with (without) them.
      settling: official.status === 'pending' || (off != null) !== (a.meta.results?.places === 'official'),
      regatta: regattaOn && me && official.status !== 'pending' ? summarizeRegatta(regattaRunner.races()) : null,
      scope: regattaOn ? 'regatta' : 'race',
    });
    els.report.innerHTML = reportHtml(m, { thumb: me && !regattaOn ? reportThumb(a, me.id) : '', stamp: `printed ${new Date().toLocaleString()}` });
    els.report.dataset.state = m.state;
  }
  function setReport(on: boolean): void {
    if (on === reportOn) return;
    reportOn = on;
    nav.write(reportHref(location.href, on, `#${tab}`), { push: !full });
    if (on) track('report_open');
    renderReport();
    if (!on) remeasure(tab);
    scrollTo({ top: 0 });
  }
  els.reportOpen.addEventListener('click', () => {
    nav.begin();
    setReport(true);
  });
  els.report.addEventListener('click', (ev) => {
    const el = ev.target as HTMLElement;
    const v = el.closest('[data-report-scope]')?.getAttribute('data-report-scope');
    if (el.closest('[data-report-close]')) {
      nav.begin();
      setReport(false);
    }
    else if (el.closest('[data-report-print]')) window.print();
    else if (v && v !== coachView) {
      coachView = parseCoachView(v);
      setUrl({ [VIEW_PARAM]: coachView === 'regatta' ? 'regatta' : null });
      renderReport();
    }
  });

  // ---- Ask Coach (optional): the panel (top of the Coach tab, open by default) shows only when /api/coach/status says it is on.
  /** Builds the context of what is on screen, at the moment a question is sent; null with no boat. */
  let askContextNow: (() => AskContext) | null = null;
  let askIds: AskIds = {};
  let askPanelView: CoachView | null = null;
  let askOpen = true;
  let askShownKey = '';
  /** The starter questions on show (redrawn only when they change, so a focused chip keeps its focus). */
  let askStarterText = '';
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
      askStarterText = '';
    }
    ask.setKey([coachView, raceKeyOf(a), me.id, group].join('#'));
    if (on) renderAsk(ask.state());
  }

  /** The starter chips from the boat's own race (askStarters); sent like a typed question. */
  function syncAskStarters(a: RaceAnalysis, me: BoatResult, deb: CoachDebrief | null): void {
    const list = askBox<HTMLElement>('[data-ask-sugs]');
    const qs = askStarters(coachView, a, me, deb);
    if (!list || qs.join('\n') === askStarterText) return;
    askStarterText = qs.join('\n');
    const st = ask.state();
    list.innerHTML = askStartersHtml(qs, st.busy || st.remaining === 0);
  }

  function sendAsk(text: string): void {
    const ctx = askContextNow?.();
    const st = ask.state();
    // Busy / no questions left: keep the draft (Enter still fires while Ask is disabled).
    if (!ctx || !text.trim() || st.busy || !st.avail?.enabled || st.remaining === 0) return;
    track('coach_ask');
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
      syncAskStarters(a, me, null);
      return;
    }
    const listed = raceList ? findListed(raceList, a.meta.division, a.meta.raceNumber) : undefined;
    const raceTitle = listed ? raceName(listed) : undefined;
    if (!ensureCoach(a)) {
      askContextNow = () => raceAskContext({ a, me, raceName: raceTitle, head: coachChips(a, me), deb: null, stories: [], group: coachGroup });
      syncAskStarters(a, me, null);
      renderKeepOpen(els.coachHead, (open) => coachHeadHtml(coachChips(a, me), open));
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
    renderKeepOpen(els.coachHead, (open) => coachHeadHtml(coachChips(a, me, deb?.totalS ?? null), open));
    els.coachGroup.innerHTML = coachGroupHtml(a, me.id, coachGroup, coachEach, coachCustomOpen);
    const widthPx = els.coachLadder.clientWidth || undefined;
    const band = deb && coachSel != null ? cardSpans(deb.cards[coachSel]) : undefined;
    els.coachLadder.innerHTML =
      model && coachLadder
        ? ladderChart(a, model, coachLadder, coachGroup, { widthPx, each: coachEach, highlight: band })
        : '<p class="muted coach-none">No course to measure against in this race.</p>';
    // Each card with a window gets a "Show on map" link (mapLink.ts), appended to the cards as built.
    els.coachCards.innerHTML = deb
      ? withMapActions(coachCardsHtml(a, deb, coachSel), deb.noData ? [] : cardMapActions(a, me.id, deb.cards, replaysOf(a), location.search))
      : '';
    // Leg stories over the picked group; the legs open now stay open.
    const openLegs = new Set([...els.coachLegs.querySelectorAll<HTMLElement>('details.coach-leg[open]')].map((d) => Number(d.dataset.leg)));
    const stories = model ? legStories(a, model, me.id, coachGroup) : [];
    renderKeepOpen(els.coachLegs, (open) => legStoriesHtml(stories, a, me.id, coachGroup, openLegs, open));
    const head = coachChips(a, me, deb?.totalS ?? null);
    const group = coachGroup;
    askContextNow = () => raceAskContext({ a, me, raceName: raceTitle, head, deb, stories, group });
    syncAskStarters(a, me, deb);
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
      els.coachRegatta.innerHTML = '<p class="regatta-status busy" role="status">Checking for official results before analyzing the races…</p>';
      return;
    }
    regattaRunner.want(jobsFor(a, sail));
    els.coachRegatta.innerHTML = regattaViewHtml(regattaRunner, location.search);
  }
  // The start strip: a real link to each race's Start view (a new tab opens it as a deep link); here, that race on the Start tab, the boat kept.
  els.coachRegatta.addEventListener('click', (ev) => {
    const me = ev as MouseEvent;
    if (me.button !== 0 || me.ctrlKey || me.metaKey || me.shiftKey || me.altKey) return;
    const n = Number((ev.target as Element).closest('a[data-start-race]')?.getAttribute('data-start-race'));
    const division = current?.division;
    if (!Number.isFinite(n) || !division) return;
    ev.preventDefault();
    nav.begin();
    setTab('start');
    window.scrollTo({ top: 0 });
    chooseRace(division, n);
  });

  function setCoachGroup(g: Group): void {
    coachGroup = g;
    setUrl({ [GROUP_PARAM]: groupParam(g) });
    renderCoach();
    lanes.refresh();
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
    track('coach_view', { detail: coachView });
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
  // A card's "Show on map": a real link (a new tab opens it as a deep link); here, the Race tab on the card's window, or C's replay.
  els.coachCards.addEventListener('click', (ev) => {
    const me = ev as MouseEvent;
    if (me.button !== 0 || me.ctrlKey || me.metaKey || me.shiftKey || me.altKey) return;
    const i = Number((ev.target as Element).closest('a[data-map-opp]')?.getAttribute('data-map-opp'));
    const a = analysis;
    const deb = coachDeb?.d;
    const c = Number.isInteger(i) ? deb?.cards[i] : undefined;
    if (!a || !coachDeb || !c) return;
    const route = cardRoute(a, coachDeb.boat, c, replaysOf(a));
    const r = route?.kind === 'replay' ? replaysOf(a).find((x) => x.boat === route.boat) : undefined;
    if (!route || (route.kind === 'replay' && !r)) return;
    ev.preventDefault();
    const began = nav.begin();
    setTab('race');
    if (r) openReplay(r);
    else if (route.kind === 'focus') openFocus(route.focus);
    if (began) nav.cancel();
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

  /** Start Speed Control, sized for its card's width (re-run on resize). */
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
    const legHref = (leg: number): string | null => (highlight ? legMapHref(location.search, a, highlight, leg) : null);
    els.places.innerHTML = placesChart(a, highlight, { widthPx: els.places.clientWidth || undefined, heightPx, legHref });
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

  // ---- Start tab: an earlier start attempt of the race (data/attempts.ts), drawn on request apart from everything else.
  /** The attempt open (1-based), from `attempt=` at first, for the race the URL names (`attemptFor`); null: none. */
  let attemptOpen: number | null = parseAttemptParam(query.get(ATTEMPT_PARAM));
  let attemptFor: string | null = attemptOpen != null ? replayRaceKey(query.get('event'), query.get('div') ?? '', query.get('race') ?? '') : null;
  /** The attempt analysed last (its race and number). */
  let attemptGot: { key: string; n: number; a: RaceAnalysis | null; error?: string } | null = null;
  const attemptsOf = (a: RaceAnalysis): EarlierAttempt[] => {
    if (!regatta) return [];
    try {
      return earlierAttempts(findRace(currentDoc(regatta), { division: a.meta.division, raceNumber: a.meta.raceNumber }).race);
    } catch {
      return [];
    }
  };
  /**
   * The worker's analysis of an attempt, the latest asked for only (ui/latestOnly.ts): opening another, closing it or
   * leaving the race cancels the one loading (the worker stops fetching it) and a late answer to it is dropped.
   */
  const attemptLoader = latestLoader<{ a: RaceAnalysis; at: EarlierAttempt; regatta: RegattaResponse }, RaceAnalysis | Error>(
    ({ a, at, regatta: reg }) => {
      const id = --coachReq;
      const classLabel = events.find((e) => e.eventId === a.meta.eventId)?.classLabel;
      const req = { id, type: 'attempt' as const, index: at.index, eventId: a.meta.eventId ?? eventId, regatta: reg, division: a.meta.division, raceNumber: a.meta.raceNumber, allCompetitors, classLabel };
      const done = new Promise<RaceAnalysis | Error>((resolve) => {
        attemptWaits.set(id, resolve);
        worker.postMessage(req satisfies WorkerRequest);
      });
      const abort = (): void => {
        attemptWaits.delete(id);
        worker.postMessage({ id, type: 'cancel' } satisfies WorkerRequest);
      };
      return { done, abort };
    },
    ({ a, at }, r) => {
      const key = replayRaceOf(a);
      attemptGot = { key, n: at.attempt, a: r instanceof Error ? null : r, ...(r instanceof Error ? { error: r.message } : {}) };
      if (analysis && replayRaceOf(analysis) === key) renderAttempt();
    },
  );
  function renderAttempt(): void {
    const a = analysis;
    const list = a ? attemptsOf(a) : [];
    els.attemptCard.hidden = !list.length;
    if (!a || !list.length) {
      attemptLoader.cancel();
      return;
    }
    const key = replayRaceOf(a);
    // `attempt=` belongs to the race it was written for.
    if (attemptOpen != null && attemptFor !== key) {
      attemptOpen = null;
      attemptFor = null;
      setUrl({ [ATTEMPT_PARAM]: null });
    }
    const at = attemptNumbered(list, attemptOpen);
    const listed = listedOf(a.meta.division, a.meta.raceNumber);
    const raceLabel = listed ? raceName(listed) : `Race ${a.meta.raceNumber}`;
    els.attemptTitle.textContent = list.length === 1 ? attemptTitle(raceLabel, list[0]) : `${raceLabel.replace(/^Race\b/, 'Start')} · earlier attempts`;
    els.attemptNote.textContent = attemptNote(at ? [at] : list, a.meta.tzOffsetMs);
    const got = at && attemptGot?.key === key && attemptGot.n === at.attempt ? attemptGot : null;
    els.attemptTools.innerHTML = attemptButtonsHtml(list, at?.attempt ?? null, !!at && !got);
    const att = got?.a ?? null;
    els.attemptChart.hidden = !got;
    els.attemptCap.hidden = !att;
    if (att) {
      const hl = highlight && att.boats.some((b) => b.id === highlight) ? highlight : null;
      els.attemptChart.innerHTML = startSnapshot(att, hl, undefined, startColour, { names: startNames, widthPx: els.attemptChart.clientWidth || els.start.clientWidth || undefined });
      renderKeyLine(els.attemptCap, { chips: lineChips(att), bullets: ['The boats at that gun; distances from the bow, as in the Start view above.', ...biasBullets(att)] });
    } else if (got) els.attemptChart.innerHTML = `<p class="muted">Couldn't load that start${got.error ? ` (${esc(got.error)})` : ''}.</p>`;
    if (at && !got && regatta) attemptLoader.want(`${key}|${at.attempt}`, { a, at, regatta });
    else if (!at || got) attemptLoader.cancel();
  }
  els.attemptTools.addEventListener('click', (ev) => {
    const n = Number((ev.target as Element).closest('button[data-attempt]')?.getAttribute('data-attempt'));
    const a = analysis;
    if (!a || !Number.isInteger(n)) return;
    attemptOpen = attemptOpen === n ? null : n;
    attemptFor = attemptOpen != null ? replayRaceOf(a) : null;
    setUrl({ [ATTEMPT_PARAM]: attemptOpen != null ? String(attemptOpen) : null });
    renderAttempt();
    els.attemptTools.querySelector<HTMLElement>(`button[data-attempt="${n}"]`)?.focus();
  });

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
  /** The map's SVG on screen (mapExtent.ts), measured once per size: a new map at the same size keeps it. */
  let mapScreen: MapScreen | null = null;
  let mapScreenStale = true;
  function mapScreenNow(svg: Element): MapScreen | null {
    if (!mapScreenStale) return mapScreen;
    mapScreenStale = false;
    // The SVG fills #map-chart, which spans the card's padding and clips (style.css): its box is what is visible.
    mapScreen = mapScreenOf(svg.getBoundingClientRect());
    return mapScreen;
  }
  /** The map drawn for the race, leg selection, colouring, selection and view; any tooltip goes with the old drawing. */
  function renderMap(): void {
    const a = analysis;
    if (!a) return;
    // A replay ends with the full race (✕ Full race), one leg picked, or another boat selected.
    if (replayOn && (scrubT == null || legSel != null || highlight !== replayOn.boat)) leaveReplay(false);
    // So does a card's window (Map D), or a leg's view, by another leg picked (a leg's view draws its own).
    if (focusOn && (scrubT == null || legSel !== (focusOn.leg ?? null) || highlight !== focusOn.boat)) leaveFocus(false);
    // A leg's view frames its own leg; left, it puts back the leg selection it replaced: its frame.
    fitMap(a);
    const t0 = performance.now();
    // Scrubbing: the static map, then this moment's trails and boats into its two layers (drawScrub, every frame).
    // Its size on screen (the SVG fills #map-chart) sets the hulls' smallest size in css px and the scale note.
    els.map.innerHTML = trackMap(a, highlight, legSel, { ...mapOpts(), full: mapFullRate(a), scrub: scrubT != null, screen: mapScreenNow(els.map) });
    mapPainter.rendered(mapView);
    scrubData = null;
    if (scrubT != null) drawScrub(a);
    mapDrawMs = performance.now() - t0;
    els.mapTip.hidden = true;
    syncScrub(a);
  }

  /** The leg the map's keys describe and the ranking and speed scale it draws with (mapLink.ts keyLeg). */
  const keyed = (): ReturnType<typeof keyLeg> => keyLeg(legSel, focusOn, rankBy, sogScale);
  const mapOpts = (): TrackMapOptions => {
    const k = keyed();
    const coachNow = needsCoach(trackColour) && analysis ? coachModelFor(analysis) : undefined;
    return { colour: trackColour, rankBy: k.rankBy, top: speedTop, sogScale: k.sogScale, view: mapView, replay: replayOn, vs: focusOn?.vs, coach: coachNow };
  };

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
  /**
   * The look-ahead follow (drawScrub, follow.ts): on from the presets, + / −, Fit and a boat selected; off once the
   * map is panned by hand, or a replay or card frames it; a wheel or pinch zoom leaves it as it was.
   */
  let mapFollow = true;
  const mapCam = followCam();
  /** The boat the follow was last turned on (or a replay / card turned it off) for. */
  let mapFollowFor: string | null = null;

  /** A race opens: at the URL's `t=` (gun-relative, clamped to its window), else the full race; playback stops. */
  function openScrub(a: RaceAnalysis): void {
    stopPlay(false);
    const s = parseTParam(new URLSearchParams(location.search).get(T_PARAM));
    scrubT = s == null ? null : timeOfParam(s, a.meta.gunMs, scrubWindow(a));
    if (scrubT != null) setUrl(scrubParams(scrubT, a.meta.gunMs, scrubTrail));
    // `replay=` (a deep link, or the replay open): kept for every load of the race it was written for (a reload, e.g.
    // when official results arrive, re-opens it once the race's replays are in again: askReplays); dropped by another race.
    replayOn = null;
    replayPend = replayPending(replayPend, { type: 'shown', race: replayRaceOf(a) });
    if (!replayPend) setUrl({ [REPLAY_PARAM]: null });
    // `win=` / `vs=` (a Coach card's focus: a deep link, or the focus open), kept per race the same way: show()
    // reopens it once drawn, on every load of its race (a reload keeps it); another race drops it.
    focusOn = null;
    applyFocusColouring(null);
    // The leg selection is the race's own (show sets it).
    legBefore = null;
    focusPend = replayPending(focusPend, { type: 'shown', race: replayRaceOf(a) });
    if (!focusPend) setUrl(NO_FOCUS);
  }

  // ---- Track map: "Replay start" for a boat over early (Map C). Its facts come from the worker (analysis/startReplay.ts).
  /** The race's replays (the over-early boats), once the worker has sent them. */
  let replays: { a: RaceAnalysis; list: StartReplay[] } | null = null;
  /** The replay showing (its boat selected, the scrubber on over the whole race); null: none. */
  let replayOn: StartReplay | null = null;
  /** The `replay=` wanted, keyed on its race (ui/replay.ts replayPending): the page's deep link, then the replay opened. */
  let replayPend: ReplayPend | null = replayPendFromUrl(location.search);
  const replayRaceOf = (a: RaceAnalysis): string => replayRaceKey(a.meta.eventId, a.meta.division, a.meta.raceNumber);
  /** The race's replays as far as known (none until the worker has sent them). */
  const replaysOf = (a: RaceAnalysis): StartReplay[] => (replays?.a === a ? replays.list : []);

  /** Ask the worker for the race's replays (once per analysis); then offer them, and open the pending `replay=`'s. */
  function askReplays(a: RaceAnalysis): void {
    if (replays?.a === a) return;
    const asked: { a: RaceAnalysis; list: StartReplay[] } = { a, list: [] };
    replays = asked;
    void startReplaysOf(a).then((list) => {
      if (replays !== asked) return;
      asked.list = list ?? [];
      if (analysis !== a) return;
      const { open: r, state } = replayArrive(replayPend, replayRaceOf(a), asked.list);
      replayPend = state;
      if (r) openReplay(r, true);
      else {
        if (!replayPend) setUrl({ [REPLAY_PARAM]: null });
        renderReplayControls();
        // The Coach cards' map links route an over-early start card to its replay now.
        renderCoach();
      }
    });
  }

  /** The map's "Replay start" control and the Start tab's links, for the selection. */
  function renderReplayControls(): void {
    const a = analysis;
    const list = a && replays?.a === a ? replays.list : [];
    const map = a ? replayControls(a, list, highlight, replayOn?.boat ?? null) : '';
    els.mapReplay.innerHTML = map;
    els.mapReplay.hidden = !map;
    const start = a ? startReplayLinks(a, list, highlight) : '';
    els.startReplay.innerHTML = start;
    els.startReplay.hidden = !start;
  }

  /**
   * Replay boat `r.boat`'s start: select it, the whole race, the scrubber on at REPLAY_PRE_S before the gun with
   * the whole trail, paused (Play plays it at 1×), the view framing the start line and its track to REPLAY_POST_S
   * after it cleared; `replay=` in the URL with `t=` and `trail=`. `resume` (the pending `replay=` of a deep link or
   * a reload): at the URL's `t=` when it gave one.
   */
  function openReplay(r: StartReplay, resume = false): void {
    const a = analysis;
    if (!a) return;
    stopPlay(false);
    leaveFocus(false);
    highlight = r.boat;
    syncCoachBoat(r.boat);
    legSel = null;
    scrubTrail = REPLAY_TRAIL;
    playSpeed = 1;
    replayOn = r;
    replayPend = replayPending(replayPend, { type: 'opened', race: replayRaceOf(a), boat: r.boat });
    scrubT = resume && scrubT != null ? scrubT : clampTime(a.meta.gunMs - REPLAY_PRE_S * 1000, scrubWindow(a));
    fitMap(a);
    if (mapFit) syncMapView(replayView(a, r, mapFit));
    mapFollowFor = r.boat;
    mapFollow = followAfter(mapFollow, 'frame');
    render();
    setUrl({ ...scrubParams(scrubT, a.meta.gunMs, scrubTrail), [REPLAY_PARAM]: r.boat });
    save();
  }

  /** Leave the replay's styling (the scrubber and the view stay as they are); `redraw` the map's moving layers now. */
  function leaveReplay(redraw: boolean): void {
    // A deep link still waiting for its replay is left too.
    if (replayPend) {
      replayPend = replayPending(replayPend, { type: 'left' });
      setUrl({ [REPLAY_PARAM]: null });
    }
    if (!replayOn) return;
    replayOn = null;
    renderReplayControls();
    if (redraw && analysis && scrubT != null) drawScrub(analysis);
  }

  // ---- Track map: a Coach card's window (Map D, ui/mapLink.ts): its boat with the boats it was measured against.
  /** The card window showing (its boat selected, the scrubber on over the whole race, the comparison boats ringed); null: none. */
  let focusOn: MapFocus | null = null;
  /** The coloring a leg's view replaced, put back when it's left (mapLink.ts focusColouring); null: none replaced. */
  let colourBefore: Colouring | null = null;
  /** Set the coloring for focus `f` (null: none); true when it changed. */
  function applyFocusColouring(f: MapFocus | null): boolean {
    const was: Colouring = { colour: trackColour, rankBy, top: speedTop };
    const next = focusColouring(was, colourBefore, f);
    colourBefore = next.before;
    trackColour = next.now.colour;
    rankBy = next.now.rankBy;
    speedTop = next.now.top;
    return was.colour !== trackColour || was.rankBy !== rankBy || was.top !== speedTop;
  }
  /**
   * The leg buttons after `e` (mapLink.ts legStep): `changed`, the selection the map draws; `leave`, the focus open is
   * to be left. A leg's view left fits the map again (on the next fitMap) for the selection it comes back to.
   */
  function stepLegs(e: LegEvent): { changed: boolean; leave: boolean } {
    const was = legSel;
    const next = legStep({ sel: legSel, before: legBefore }, e);
    legSel = next.state.sel;
    legBefore = next.state.before;
    if (next.refit) mapFitFor = null;
    return { changed: was !== legSel, leave: next.leave };
  }
  /** The `win=` focus wanted, keyed on its race (replay.ts replayPending, as `replay=`): the page's deep link, then the focus opened. */
  let focusPend: ReplayPend | null = focusPendFromUrl(location.search);

  /**
   * Show focus `f`: select its boat, the whole race (a leg's view: its leg only), the scrubber paused at the window's end with the window's own
   * trail (from its start: the whole window drawn), or `at` (a link's own `t=` / `trail=`, mapLink.ts focusResume),
   * the view framing the boat's and the comparison boats' tracks over the window; `boat=`, `vs=`, `win=`, `t=` and
   * `trail=` in the URL. Play from there plays the window from its start (focusPlayFrom).
   */
  function openFocus(f: MapFocus, at?: { t: number; trail: Trail }): void {
    const a = analysis;
    if (!a) return;
    stopPlay(false);
    leaveReplay(false);
    highlight = f.boat;
    syncCoachBoat(f.boat);
    // A leg's view draws its own leg only (its button pressed), a card's window the whole race (the scrubber's); either
    // keeps the leg selection it replaced (the user's, saved). fitMap then fits the leg drawn, which the view frames.
    stepLegs({ kind: 'open', focus: f });
    scrubTrail = at?.trail ?? focusTrail(f);
    playSpeed = 1;
    focusOn = f;
    // A leg's view (`fast=`): the tracks by speed rank on each leg, its fastest picked out, as the Colour controls set it
    // (not saved); any other focus puts back the coloring a leg's view replaced.
    applyFocusColouring(f);
    focusPend = replayPending(focusPend, { type: 'opened', race: replayRaceOf(a), boat: f.boat });
    scrubT = clampTime(at?.t ?? focusTime(f), scrubWindow(a));
    fitMap(a);
    if (mapFit) syncMapView(focusView(a, f, mapFit));
    mapFollowFor = f.boat;
    mapFollow = followAfter(mapFollow, 'frame');
    render();
    setUrl({ ...scrubParams(scrubT, a.meta.gunMs, scrubTrail), ...focusParams(a, f), [REPLAY_PARAM]: null });
    save();
  }

  /**
   * Leave the focus's comparison boats (the scrubber and the view stay as they are; the window's trail becomes the
   * shortest usual one covering the window); `redraw` the map's moving layers now.
   */
  function leaveFocus(redraw: boolean): void {
    // A deep link still waiting for its focus is left too.
    if (focusPend) {
      focusPend = replayPending(focusPend, { type: 'left' });
      setUrl(NO_FOCUS);
    }
    const f = focusOn;
    focusOn = null;
    // The coloring a leg's view replaced and the leg selection any focus did come back, a leg's view's Fit with them
    // (drawn now unless the map is being drawn already).
    const recoloured = applyFocusColouring(null);
    if ((stepLegs({ kind: 'leave', focus: f }).changed || recoloured || f?.leg != null) && !rendering) render();
    if (scrubTrail === WINDOW_TRAIL) {
      scrubTrail = trailAfterFocus(scrubTrail, f);
      if (analysis) syncScrub(analysis);
      writeScrubUrl();
    }
    if (!f) return;
    renderFocusLegend();
    if (redraw && analysis && scrubT != null) drawScrub(analysis);
  }

  /** The "vs USA 11 · GBR 015" line under a focus. */
  function renderFocusLegend(): void {
    const html = analysis ? mapFocusLegend(analysis, focusOn) : '';
    els.mapFocus.innerHTML = html;
    els.mapFocus.hidden = !html;
  }

  els.mapReplay.addEventListener('click', (ev) => {
    const id = (ev.target as Element).closest('button[data-replay]')?.getAttribute('data-replay');
    const r = id != null && replays?.a === analysis ? replays.list.find((x) => x.boat === id) : undefined;
    if (!r) return;
    // The pressed button leaves the replay (as ✕ Full race or Fit do), keeping the time and the view.
    if (replayOn?.boat === r.boat) {
      leaveReplay(true);
      [...els.mapReplay.querySelectorAll<HTMLButtonElement>('button[data-replay]')].find((b) => b.getAttribute('data-replay') === r.boat)?.focus();
      return;
    }
    track('replay_boat', { detail: 'map' });
    openReplay(r);
    els.map.focus({ preventScroll: true });
  });
  // The Start tab's "Replay start →": the boat selected and its start played in "Start Playback" just below (the
  // slider cued a few seconds before it went over: laneCueSecond), paused there with reduced motion; the track
  // map's replay (#map-replay, `replay=` links) is untouched.
  els.startReplay.addEventListener('click', (ev) => {
    const id = (ev.target as Element).closest('[data-replay]')?.getAttribute('data-replay');
    const r = id != null && replays?.a === analysis ? replays.list.find((x) => x.boat === id) : undefined;
    if (!r) return;
    ev.preventDefault();
    track('replay_boat', { detail: 'start' });
    if (highlight !== r.boat) {
      highlight = r.boat;
      syncCoachBoat(r.boat);
      render();
      save();
    }
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const section = $<HTMLDetailsElement>('lane-snapshots');
    lanes.cue(laneCueSecond(r), !still);
    section.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    section.querySelector<HTMLElement>('.lane-play')?.focus({ preventScroll: true });
  });

  /** What each drawn map's tracks layer holds (a new map, a new layer). */
  const scrubTracks = new WeakMap<Element, string>();
  /** Draw this moment's trails and boats into the static map's layers. */
  function drawScrub(a: RaceAnalysis): void {
    const svg = els.map.querySelector('svg');
    const trk = svg?.querySelector('g.scrub-trk');
    const dots = svg?.querySelector('g.scrub-dots');
    const trails = svg?.querySelector('g.scrub-trails');
    const ocs = svg?.querySelector('g.scrub-ocs');
    const rungs = svg?.querySelector('g.scrub-rungs');
    if (scrubT == null || !trk || !dots) return;
    // A boat selected (here or on another view): follow it, snapping to it once zoomed in.
    if (highlight !== mapFollowFor) {
      mapFollowFor = highlight;
      if (highlight != null) {
        mapFollow = followAfter(mapFollow, 'select');
        resetFollow(mapCam);
      }
    }
    // Zoomed in: the look-ahead camera on the selected boat (the zoom stays) first, so the frame is drawn in the
    // view it moves to; the pan only moves the viewBox (followMapView).
    let full = mapFullRate(a);
    const input = mapFollow && mapFit && mapView.k > 1 && highlight != null ? mapFollowInput(a, highlight, scrubT, full) : null;
    if (input && mapFit) {
      const next = followStep(mapCam, mapFit, mapView, input, reducedMotion());
      if (next !== mapView) {
        followMapView(next);
        full = mapFullRate(a);
      }
    }
    const win = trailWindow(scrubT, scrubTrail, scrubWindow(a), focusOn ? focusFrom(focusOn) : null);
    const ladder = ladderAt(a, scrubT);
    const f = scrubFrame(a, highlight, legSel, mapOpts(), { t: scrubT, win, full, trailMs: fadingTrailMs(scrubTrail), ladder, screen: svg ? mapScreenNow(svg) : null });
    // The tracks layer is empty with a short trail (but a replay's or a card's), so it is only set when it changes;
    // the fading trails reuse their paths (trailLayer.ts); never the map's full redraw.
    if (f.tracks !== scrubTracks.get(trk)) {
      trk.innerHTML = f.tracks;
      scrubTracks.set(trk, f.tracks);
    }
    if (trails) paintTrails(trails, f.trails);
    // A replay's over-the-line tracks, over the trails (only set when they change, as the tracks).
    if (ocs && f.ocs !== scrubTracks.get(ocs)) {
      ocs.innerHTML = f.ocs;
      scrubTracks.set(ocs, f.ocs);
    }
    // The ladder rungs reuse their lines and labels (rungs.ts).
    if (rungs) paintRungs(rungs, f.rungs);
    // The wind arrow turns with the wind the rungs lie square to (windArrow.ts); the gun's until the Coach's wind is ready.
    const arrow = svg && windArrowOf(svg);
    if (arrow) paintWindArrow(arrow, ladder ? ladder.twdDeg : a.wind.twdAtGunDeg, a.wind.twdAtGunDeg);
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
    els.mapTime.max = String(Math.max(lo, paramOfTime(w.t1, gun)));
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
    for (const b of els.mapTrail.querySelectorAll<HTMLButtonElement>('button[data-trail]')) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-trail') === scrubTrail));
      // "Window" (a card's window, from its start) only with one open.
      if (b.getAttribute('data-trail') === WINDOW_TRAIL) b.hidden = !focusOn;
    }
  }

  /** Real time × speed per frame; a frame after a long stall (a hidden tab) counts as at most this, ms. */
  const PLAY_MAX_STEP_MS = 250;
  function startPlay(): void {
    const a = analysis;
    if (!a) return;
    // From the time shown; from the start when off or at the end; parked at a card window's end, from the window's start.
    const from = focusPlayFrom(focusOn, scrubT, scrubWindow(a));
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
  /** Pause, keeping the time; `writeUrl` (a pause or the end, not another race or window opening) records it, and redraws a map the follow panned. */
  function stopPlay(writeUrl: boolean): void {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(playFrame);
    playFrame = 0;
    if (analysis) syncScrub(analysis);
    if (writeUrl) {
      writeScrubUrl();
      mapPainter.settle();
    }
  }
  const togglePlay = (): void => {
    if (playing) return stopPlay(true);
    track('replay_play');
    startPlay();
  };

  els.mapPlay.addEventListener('click', togglePlay);
  // Dragging or arrowing the slider pauses and moves the time; the URL follows once it is let go.
  els.mapTime.addEventListener('input', () => {
    const a = analysis;
    if (!a) return;
    track('replay_scrub');
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
  // Full screen: Space from the overlay (Close, tools) plays too; the map, slider and play button already do.
  els.fs.addEventListener('keydown', (ev) => {
    if (full !== 'map' || ev.key !== ' ' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t === els.mapTime || t === els.map || t === els.mapPlay || t?.closest?.('input, textarea, select')) return;
    ev.preventDefault();
    togglePlay();
  });

  /** A new race or leg selection: fit its box (Fit: everything, or the leg's segments and marks). */
  function fitMap(a: RaceAnalysis): void {
    if (mapFit && mapFitFor?.a === a && mapFitFor.leg === legSel) return;
    mapFitFor = { a, leg: legSel };
    mapFit = mapBox(a, legSel);
    syncMapView(fitView(mapFit));
  }

  /**
   * What the presets and + / − center on at zoom `k`: scrubbing, the selected boat at the moment shown with the
   * follow camera's look-ahead, else the middle of the fleet then, else the map's center (null); the full race (no
   * moment) keeps the view's center.
   */
  function mapTarget(k: number = mapView.k): [number, number] | null {
    if (scrubT == null || !scrubData || !mapFit || !analysis) return [mapView.cx, mapView.cy];
    const input = highlight != null ? mapFollowInput(analysis, highlight, scrubT, mapFullRate(analysis)) : null;
    if (!input) return boatsZoomTarget(scrubData.boats, highlight, (b) => [b.mx, b.my]);
    const vb = viewBox(mapFit, { cx: 0, cy: 0, k: Math.max(1, k) });
    return followTarget(input.pos, input.dirs, input.down, vb.w, vb.h);
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

  let mapDrawMs = 0;
  /** Full redraws or viewBox moves for a new view (mapPaint.ts). */
  const mapPainter = mapPaint({
    render: renderMap,
    move: (drawn) => {
      const svg = els.map.querySelector('svg');
      if (!svg || !mapFit) return renderMap();
      const vb = viewBox(mapFit, mapView);
      svg.setAttribute('viewBox', `${vb.x0} ${vb.y0} ${vb.w} ${vb.h}`);
      // The ladder rungs run edge to edge across what is visible: across the new view.
      paintMapRungs(svg);
      // The scale bar and wind arrow sit in the view's corner: shifted by the pan from the view drawn.
      const hud = drawn && svg.querySelector('g.map-hud');
      if (!hud || !drawn) return;
      const d = viewBox(mapFit, drawn);
      hud.setAttribute('transform', `translate(${(vb.x0 - d.x0).toFixed(2)} ${(vb.y0 - d.y0).toFixed(2)})`);
    },
    drawMs: () => mapDrawMs,
    view: () => mapView,
  });
  /** The ladder rungs alone, for a view or a size changed without a new frame (the boats where they were). */
  function paintMapRungs(svg: Element): void {
    const rungs = svg.querySelector('g.scrub-rungs');
    if (rungs && scrubT != null && analysis) paintRungs(rungs, scrubRungs(analysis, highlight, legSel, mapOpts(), ladderAt(analysis, scrubT), mapScreenNow(svg)));
  }
  // A new size (the window, the card's layout, full screen, another leg's shape): measured again, the rungs redrawn to
  // it; while scrubbing, the map redrawn once the size rests (the hulls' smallest size and the scale note are css px).
  let resized = 0;
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      const was = mapScreen;
      mapScreenStale = true;
      const svg = els.map.querySelector('svg');
      if (svg) paintMapRungs(svg);
      const now = mapScreenNow(els.map);
      if (scrubT == null || (was && now && was.w === now.w && was.h === now.h) || (!was && !now)) return;
      clearTimeout(resized);
      resized = window.setTimeout(renderMap, MAP_SETTLE_MS);
    }).observe(els.map);
  }

  /** Pan/zoom: store the view now, redraw on the next frame (line widths, labels and the scale bar follow the zoom). */
  function setMapView(v: View): void {
    if (!mapFit) return;
    syncMapView(v);
    hideMapTip();
    mapPainter.gesture();
  }
  /** The follow camera's pan (the zoom unchanged): store the view and move the viewBox now; drawScrub draws the boats. */
  function followMapView(v: View): void {
    if (!mapFit) return;
    syncMapView(v);
    hideMapTip();
    mapPainter.follow(playing);
  }

  els.mapZoom.addEventListener('click', (ev) => {
    const btn = (ev.target as Element).closest('button[data-zoom]');
    if (!btn || !mapFit) return;
    const next = Number(btn.getAttribute('data-zoom'));
    if (!Number.isFinite(next) || next <= 0) return;
    // Presets centre on the selected boat (else the fleet) at the moment shown and follow it; Fit goes back to
    // the leg selection's frame (and leaves a replay or a card's window).
    if (next === 1) {
      leaveReplay(true);
      leaveFocus(true);
    }
    mapFollow = followAfter(mapFollow, 'preset');
    setMapView(zoomPreset(mapFit, next, mapTarget(next)));
  });

  /**
   * A boat's place at a moment (coach/progress.ts: the fleet by distance to go along the course, up the ladder the
   * rungs draw, on the wind then), once the race's coach model is ready (asked for here); none from interpolated
   * roundings, or with no course.
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

  /**
   * The fleet up the wind ladder at `t` for the ladder rungs (coach/ladderNow.ts: the wind then and the Coach's rungs,
   * the reads the tooltip's places rank, so the leader is its first place); null until the race's coach model is
   * ready (asked for here: the wind comes from its wind series, read from the raw fixes in the worker).
   */
  function ladderAt(a: RaceAnalysis, t: number): LadderNow | null {
    if (!ensureCoach(a)) return null;
    const model = coach?.model;
    return model ? ladderReader(a, model)(t) : null;
  }

  /** The point under the pointer (the selected boat's within 40 px, else anyone's within 8; more for a finger): tooltip and dot. */
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
    const [cx, cy] = pickAt(p, pick);
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', String(4 * px));
    dot.setAttribute('stroke-width', String(1.5 * px));
    const vm = trackColour === 'vmg' ? coachModelFor(a) : null;
    const legLine =
      trackColour === 'sog' ? (l: number) => sogHoverLeg(a, l, legSel, keyed().sogScale) : vm ? (l: number) => vmgHoverLeg(a, vm, l, legSel, keyed().sogScale) : undefined;
    const gm = trackColour === 'gain' ? coachModelFor(a) : null;
    const valueLine = vm ? (q: TipPoint) => vmgTipLine(vm, q) : gm ? (q: TipPoint) => gainTipLine(a, gm, q.id, q.t) : undefined;
    els.mapTip.innerHTML = mapTipHtml(mapTipLines(a, p, pick, { legLine, placeAt: placeReader(a), valueLine }));
    els.mapTip.hidden = false;
    // Beside the pointer, above it; flipped left near the right edge and below near the top, and kept inside the map;
    // off a replay's label (another corner of the pointer) so it never hides the replay's facts.
    const wrap = els.mapTip.parentElement!.getBoundingClientRect();
    const lbl = svg.querySelector('text.ocs-lbl')?.getBoundingClientRect();
    const avoid = lbl ? { left: lbl.left - wrap.left, top: lbl.top - wrap.top, width: lbl.width, height: lbl.height } : null;
    const pos = mapTipPos(ev.clientX - wrap.left, ev.clientY - wrap.top, { w: els.mapTip.offsetWidth, h: els.mapTip.offsetHeight }, { w: wrap.width, h: wrap.height }, avoid);
    els.mapTip.style.left = `${pos.left}px`;
    els.mapTip.style.top = `${pos.top}px`;
  }
  /** What the pointer can pick: the scrubber frame's fixes and boats; zoomed in tight, the full-rate fixes near the view; else every drawn fix. */
  function mapPointsNow(a: RaceAnalysis): MapPoints {
    if (scrubT != null && scrubData) {
      if (scrubPts?.f !== scrubData) scrubPts = { f: scrubData, p: scrubPoints(scrubData) };
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
    getTarget: mapTarget,
    follow: (on) => (mapFollow = on),
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
      lanes.refresh();
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
    if (!keep && !reportOn && tabFromHash(location.hash, tabs) !== t) nav.write(withTabHash(location.href, t), { push: !full });
    if (changed && !opts.boot) track('tab', { detail: t });
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
    if (!t) return;
    if (t !== tab) nav.begin();
    setTab(t);
  });
  els.tabs.addEventListener('keydown', (ev) => {
    const t = tabForKey(tab, ev.key, tabs);
    if (!t) return;
    ev.preventDefault();
    if (t !== tab) nav.begin();
    setTab(t, { focus: true });
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

  // Start Speed Control: a crosshair and the speed under the pointer (the selected boat's, else the nearest line's).
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

  // Rounding & Finish Positions: a dot's place on hover or tap (beside it, as the map's tip); a click on a line, dot or name selects the boat.
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
  // Save start picture: the line at the gun and a close-up of the selected boat, captioned, as a PNG (ui/startPng.ts).
  els.startPng.addEventListener('click', () => {
    const a = analysis;
    const b = a && highlight ? a.boats.find((x) => x.id === highlight) : undefined;
    if (!a || !b) return;
    const listed = listedOf(a.meta.division, a.meta.raceNumber);
    const race = listed ? raceName(listed) : `Race ${a.meta.raceNumber}`;
    const { svg, width, height } = startPngSvg(a, b.id, startColour, { event: a.meta.eventName, division: a.meta.division, race }, pageCss(document));
    const n = listed?.officialNumber ?? a.meta.raceNumber;
    els.startPng.disabled = true;
    void downloadSvgAsPng(svg, width, height, startPngName(a.meta.eventName, n, b.sail))
      .catch((e: unknown) => setNotice(`Couldn't save the picture (${e instanceof Error ? e.message : String(e)}).`))
      .finally(() => (els.startPng.disabled = false));
  });
  els.places.addEventListener('pointermove', showPlaceTip);
  els.places.addEventListener('pointerdown', showPlaceTip);
  els.places.addEventListener('pointerleave', (ev) => {
    if (ev.pointerType === 'mouse') {
      els.placesTip.hidden = true;
      placeTipId = null;
    }
  });
  els.places.addEventListener('click', (ev) => {
    // A leg of the selected boat's line: a real link to that leg's view on the map (a new tab opens it as a deep link); here, the Race tab on it.
    const legLink = (ev.target as Element).closest('a[data-leg-map]');
    if (legLink) {
      const me = ev as MouseEvent;
      const leg = Number(legLink.getAttribute('data-leg-map'));
      const f = analysis && highlight ? legFocus(analysis, highlight, leg) : null;
      if (me.button !== 0 || me.ctrlKey || me.metaKey || me.shiftKey || me.altKey || !f) return;
      ev.preventDefault();
      // A history entry of its own (Back comes back to the view before it), but not from full screen, whose close
      // goes back past its own entry (that back is still to land).
      const wasFull = fullscreen.isOpen;
      if (wasFull) fullscreen.close('button');
      const began = !wasFull && nav.begin();
      setTab('race');
      openFocus(f);
      if (began) nav.cancel();
      return;
    }
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
    if (highlight) track('boat_select');
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
      if (highlight) track('boat_select', { detail: which });
      if (highlight) syncCoachBoat(highlight);
      save();
      renderKeepingFocus(wrap, focusSel(tr, 'data-id'));
    };
    wrap.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('button[data-sort]');
      if (btn && analysis) {
        const key = btn.getAttribute('data-sort')!;
        track('table_sort', { detail: which });
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
      if (highlight) track('boat_select', { detail: 'list' });
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
  // Start findings: the best and worst start boats select the boat, as in the list.
  els.startFindings.addEventListener('click', (ev) => {
    const item = (ev.target as HTMLElement).closest('button[data-id]');
    const next = findingsClick(ev.target as HTMLElement, highlight);
    if (!item || next === undefined) return;
    highlight = next;
    if (highlight) track('boat_select', { detail: 'findings' });
    if (highlight) syncCoachBoat(highlight);
    save();
    renderKeepingFocus(els.startFindings, focusSel(item, 'data-id'));
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
    // As shown: in a leg's view its leg's button is the pressed one. A leg chosen by hand stands, and leaves the leg's view.
    const sel = focusSel(btn, 'data-leg');
    const step = stepLegs({ kind: 'press', leg, focus: focusOn });
    // A focus left (a leg's view, or a card's window by a leg picked) is a history entry: Back comes back to it.
    const began = nav.begin();
    // Leaving the leg's view draws the map itself.
    if (step.leave) leaveFocus(false);
    else render();
    if (began) nav.cancel();
    save();
    if (sel) els.legend.querySelector<HTMLElement>(sel)?.focus();
  });
  els.colour.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-colour], button[data-rank], button[data-top], button[data-sog-scale]');
    if (!btn) return;
    const colour = btn.getAttribute('data-colour');
    const top = btn.getAttribute('data-top');
    const scale = btn.getAttribute('data-sog-scale');
    let attr = 'data-rank';
    // A coloring chosen by hand stands: leaving a leg's view no longer puts back the one before it.
    if (scale == null) colourBefore = null;
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
      track('full_screen', { detail: f });
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
      // A card's window from the URL (`win=`, a deep link or a reload of its race): reopened as linked, at the URL's own
      // `t=` / `trail=` (focusResume: an older link's, at the window's start, parks at its end as a card's link does).
      const { open: f, at, state } = focusArrive(focusPend, replayRaceOf(a), location.search, a.meta.gunMs, a.drawings.map((d) => d.id));
      focusPend = state;
      if (f) openFocus(f, at);
      else if (!focusPend) {
        setUrl(NO_FOCUS);
        // A window's trail (`trail=win`) with no window to draw from: a usual one.
        leaveFocus(false);
      }
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
    const view = viewForRace(current, { eventId: id, division, raceNumber }, { leg: userLeg(), boat: highlight, sort, startSort }, restore);
    // Another race: the live one's refreshes (or tries) stop (a reload of the same race keeps them).
    const key = liveKeyOf({ eventId: id, division, raceNumber });
    if ((live && live.key !== key) || (waiting && waiting.key !== key)) stopLive();
    try {
      await paywall.ready;
      if (baseRegatta && paywall.locked(freeOf(baseRegatta), id, division, raceNumber)) {
        showLocked(division, raceNumber);
        return 'ok';
      }
      paywall.hideLock();
      const classLabel = events.find((e) => e.eventId === id)?.classLabel;
      // Official results still being linked (the event just opened): waited for a little, so the race is analysed
      // with them the first time (its start places and finishes don't change on screen once they come in).
      const off = await officialForLoad(official.status === 'pending' ? officialLinking : null, () => officialFor(outcomeOf(), listedOf(division, raceNumber)));
      if (id !== eventId) return 'superseded';
      const reg = regatta;
      const logs = vkx.buffersFor(id, division, raceNumber);
      const req = { type: 'live' as const, eventId: id, regatta: reg, division, raceNumber, allCompetitors, classLabel, ...(off ? { official: off } : {}), ...(logs.length ? { vkx: logs } : {}) };
      if (!(await show(run(req), view))) return 'superseded';
      current = { eventId: id, division, raceNumber };
      racePage(false);
      if (analysis) vkx.raceShown({ eventId: id, division, raceNumber, regatta: reg, analysis });
      setUrl({ event: id, div: division, race: String(raceNumber), nc: allCompetitors ? NC_ALL : null });
      save();
      setNotice('');
      stopWaiting();
      syncLive(true);
      reapplyOfficial();
      return 'ok';
    } catch (e) {
      if (isSuperseded(e)) return 'superseded';
      setStatus('');
      if (paywall.me().paywall && id === eventId && isPaywallError((e as Error).message)) {
        // The server says no (a pass ended, signed out elsewhere): lock it, and re-read who this is.
        showLocked(division, raceNumber);
        void paywall.refresh();
        return 'ok';
      }
      // Opened before its boats are out (its start sequence, say): tried again each minute, and on live from there.
      if (id === eventId && (e as Error).message === NO_TRACKS && waitForTracks(division, raceNumber)) return e as Error;
      if (waiting?.key === key) stopWaiting();
      // Keep the event/race picker so another race can be tried.
      setNotice(`Couldn't load that race (${(e as Error).message}).`);
      return e as Error;
    }
  }

  /** The race on screen, for the usage events (track.ts): race_open once each time another race is shown. */
  let trackedRace = '';
  function racePage(locked: boolean): void {
    if (!current) return;
    const race = raceId(current.division, current.raceNumber);
    setTrackPage({ event: current.eventId, race });
    if (`${current.eventId}|${race}` === trackedRace) return;
    trackedRace = `${current.eventId}|${race}`;
    track('race_open', locked ? { detail: 'locked' } : {});
  }

  /** The lock card for a race of the loaded event (the URL names it, so a reload or a shared link comes back to it). */
  function showLocked(division: string, raceNumber: number): void {
    if (!regatta || !baseRegatta) return;
    stopLive();
    current = { eventId, division, raceNumber };
    setUrl({ event: eventId, div: division, race: String(raceNumber), nc: allCompetitors ? NC_ALL : null });
    racePage(true);
    setStatus('');
    els.digest.hidden = true;
    paywall.showLock(els.digest, {
      doc: currentDoc(regatta),
      eventId,
      division,
      raceNumber,
      listed: listedOf(division, raceNumber),
      range: lockedRange(raceList?.races ?? [], freeOf(baseRegatta), division),
    });
  }

  /** Signed in or out, or a pass arrived: reload the race on screen if its lock changed. */
  function paywallChanged(): void {
    setTrackAuth(authOf(paywall.me()));
    void alerts.load(paywall.me());
    // The "Free" badges follow the paywall (on or off).
    if (events.length || upcoming.length) renderEventOptions();
    if (cardEventId) return renderEventCard();
    renderSummary();
    if (!current || current.eventId !== eventId || !baseRegatta) return;
    if (paywall.locked(freeOf(baseRegatta), eventId, current.division, current.raceNumber) !== paywall.lockShown()) void loadRace(current.division, current.raceNumber);
  }

  /** Rebuild the Event select from the search query, keeping the loaded event selected. */
  function renderEventOptions(): void {
    const q = els.search.value;
    const shown = pickerShown ? '' : cardEventId || eventId;
    const { options, upcoming: soon, matches } = pickerOptions(events, q, shown, paywall.free, { events: upcoming, now: Date.now() });
    matchCount = matches.length;
    // Nothing loaded yet: a placeholder, so picking the first event still fires `change`.
    const placeholder = shown ? '' : '<option value="" disabled selected>Choose an event…</option>';
    const html = (list: typeof options): string => list.map((o) => `<option value="${esc(o.eventId)}">${esc(o.label)}</option>`).join('');
    // Upcoming first (the list runs latest first), in its own group; the rest under Events then.
    els.event.innerHTML = placeholder + (soon.length ? `<optgroup label="Upcoming">${html(soon)}</optgroup>${options.length ? `<optgroup label="Events">${html(options)}</optgroup>` : ''}` : html(options));
    if (shown) els.event.value = shown;
    els.count.textContent = matchCountLabel(matchCount, events.length + upcoming.length, q);
    els.count.classList.toggle('none', q.trim() !== '' && matchCount === 0);
  }

  /** The Race select's options as last written. */
  let raceOptionsHtml = '';
  /** The Race select from the race list (official numbers, practice, rebuilt races), keeping the selection. */
  function renderRaceOptions(): void {
    if (!raceList) return;
    const keep = els.race.value;
    const multi = new Set(raceList.races.map((r) => r.division)).size > 1;
    const html = raceList.races.map((r) => `<option value="${esc(r.division)}|${r.raceNumber}">${esc(raceOptionText(r, multi))}</option>`).join('');
    // Unchanged (a live race's refresh, mostly): left alone, so a menu open stays open.
    if (html !== raceOptionsHtml) {
      raceOptionsHtml = html;
      els.race.innerHTML = html;
    }
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
    if (paywall.lockShown() && current) showLocked(current.division, current.raceNumber);
    // The header names the race as the picker does: relabel it too (title, RS tag and chips), and the Coach strip.
    renderSummary();
    renderCoach();
    renderReport();
    reapplyOfficial();
    syncLive();
  }

  /** The race on screen was analysed without (or with) official results it should (not) have: load it again, keeping the view. */
  function reapplyOfficial(): void {
    const a = analysis;
    if (!a || !current || a.meta.division !== current.division || a.meta.raceNumber !== current.raceNumber || current.eventId !== eventId) return;
    const want = officialFor(outcomeOf(), listedOf(current.division, current.raceNumber)) != null;
    if (want !== (a.meta.results?.places === 'official')) void loadRace(current.division, current.raceNumber);
  }

  // ---- The live race's refreshes (`live` above).

  /** Whether the race on screen is in progress, its start sequence included (a rebuilt race or a locked one never is). */
  function isLiveNow(): boolean {
    const a = analysis;
    const c = current;
    if (!a || !c || !regatta || c.eventId !== eventId || paywall.lockShown() || isOrphanKey(c.raceNumber)) return false;
    if (a.meta.division !== c.division || a.meta.raceNumber !== c.raceNumber) return false;
    const listed = listedOf(c.division, c.raceNumber);
    if (!listed) return false;
    const outcome = outcomeOf();
    return raceLive(
      {
        gunMs: listed.gunMs,
        feedFinished: listed.finished,
        eventOver: eventFinished(currentDoc(regatta)),
        unaccounted: unaccountedBoats(a.boats),
        officialWanted: official.status === 'pending' || linksOf(outcome).has(c.division),
        officialIn: officialFor(outcome, listed) != null,
      },
      Date.now(),
    );
  }

  /**
   * The race shown reads as still being sailed (meta.inProgress: no DNF for a boat with no finish yet, no "no
   * finishes" warning) while it is live by the app's rule; true when that changed.
   */
  function syncRacing(): boolean {
    const a = analysis;
    if (!a) return false;
    const on = isLiveNow();
    if (!!a.meta.inProgress === on) return false;
    a.meta.inProgress = on;
    return true;
  }

  function stopWaiting(): void {
    if (!waiting) return;
    waiting.poller?.stop();
    clearTimeout(waiting.arm);
    waiting = null;
  }

  /**
   * A race of the loaded event with no boat's track yet (loadRace: NO_TRACKS), its gun to come or in its live window
   * (data/live.ts gunLive): the notice says when its gun is, and from PRE_GUN_MS before it (ui/live.ts liveArmDelay) it's
   * tried again each minute (the event's document afresh, for a gun moved) until it loads, then refreshed live
   * (syncLive); false when it isn't such a race.
   */
  function waitForTracks(division: string, raceNumber: number): boolean {
    const listed = regatta ? listedOf(division, raceNumber) : undefined;
    const now = Date.now();
    if (!regatta || !listed || isOrphanKey(raceNumber) || eventFinished(currentDoc(regatta)) || !(listed.gunMs > now || gunLive(listed.gunMs, now))) return false;
    const tz = tzOffsetMs(findRace(currentDoc(regatta), { division, raceNumber }).race.timezoneOffset);
    setNotice(waitingNotice(raceName(listed), listed.gunMs, tz, now));
    const key = liveKeyOf({ eventId, division, raceNumber });
    if (waiting?.key === key) return true;
    stopWaiting();
    const w: NonNullable<typeof waiting> = { key, poller: null, arm: undefined };
    waiting = w;
    const begin = (): void => {
      if (waiting !== w) return;
      const wait = liveArmDelay(listed.gunMs, Date.now());
      if (wait != null) {
        w.arm = setTimeout(begin, wait);
        return;
      }
      w.poller = startLivePoller({
        tick: () => retryWaiting(key, division, raceNumber),
        hidden: () => document.visibilityState === 'hidden',
        onVisibility: (cb) => {
          document.addEventListener('visibilitychange', cb);
          return () => document.removeEventListener('visibilitychange', cb);
        },
      });
    };
    begin();
    return true;
  }

  /** One try of the race waited for (waitForTracks): the event's document afresh, then the race loaded. */
  async function retryWaiting(key: string, division: string, raceNumber: number): Promise<LiveTick> {
    if (waiting?.key !== key || liveKeyOf({ eventId, division, raceNumber }) !== key) return 'done';
    // A load or the event's linking under way goes first.
    if (pending.size || official.status === 'pending' || feed.status === 'running') return 'more';
    const id = eventId;
    const req = eventReq;
    const next = await fetchRegatta(id, undefined, { fresh: true });
    if (id !== eventId || req !== eventReq || waiting?.key !== key) return 'done';
    baseRegatta = next;
    regatta = mergeOrphans(next, orphansFound ?? new Map<string, OrphanFound[]>());
    raceList = buildRaceList(currentDoc(regatta), { links: linksOf(outcomeOf()), ...(orphansFound ? { orphans: orphansFound } : {}) });
    renderRaceOptions();
    return (await loadRace(division, raceNumber)) === 'ok' ? 'done' : 'more';
  }

  /** Everything live stops: the race on screen's refreshes and a race waited for (another race or event opened). */
  function stopLive(): void {
    stopWaiting();
    stopPolling();
  }

  /** The race on screen's refreshes stop. */
  function stopPolling(): void {
    if (!live) return;
    live.poller.stop();
    live = null;
    renderLiveMark();
  }

  /** Start (or keep, or stop) the poller for the race on screen; `loaded`: it was just loaded in full (up to date now). */
  function syncLive(loaded = false): void {
    const key = current && isLiveNow() ? liveKeyOf(current) : null;
    if (live && live.key !== key) stopPolling();
    if (key && !live) {
      live = {
        key,
        updatedMs: Date.now(),
        refreshes: 0,
        poller: startLivePoller({
          tick: () => refreshLive(key),
          hidden: () => document.visibilityState === 'hidden',
          onVisibility: (cb) => {
            document.addEventListener('visibilitychange', cb);
            return () => document.removeEventListener('visibilitychange', cb);
          },
        }),
      };
    } else if (live && loaded) live.updatedMs = Date.now();
    // Became (or stopped being) a race in progress: its labels follow.
    if (syncRacing()) render();
    else renderLiveMark();
  }

  /** The title's "Live" tag (data/live.ts liveTag) for the race shown, from the loaded event's list and official results. */
  function titleLive(m: RaceAnalysis['meta'], listed: ListedRace | undefined): boolean {
    if (!listed || !regatta || (m.eventId != null && m.eventId !== eventId)) return false;
    const outcome = outcomeOf();
    return liveTag(
      {
        gunMs: listed.gunMs,
        eventOver: eventFinished(currentDoc(regatta)),
        officialIn: officialFor(outcome, listed) != null,
        officialWanted: linksOf(outcome).has(listed.division),
      },
      Date.now(),
    );
  }

  /** "updated 11:32" after the title (and its Live tag) while the race on screen is refreshed; nothing otherwise. */
  function liveMarkHtml(): string {
    const a = analysis;
    if (!live || !a || !current || liveKeyOf(current) !== live.key) return '';
    return ` <span class="race-live" data-live-updated="${new Date(live.updatedMs).toISOString()}">${esc(liveLabel(live.updatedMs, a.meta.tzOffsetMs))}</span>`;
  }
  /** The live mark, and on the digest the last update (ISO) and refresh count, for checking a page by hand. */
  function renderLiveMark(): void {
    const html = liveMarkHtml();
    if (live && html) {
      els.digest.dataset.liveUpdated = new Date(live.updatedMs).toISOString();
      els.digest.dataset.liveRefreshes = String(live.refreshes);
    } else {
      delete els.digest.dataset.liveUpdated;
      delete els.digest.dataset.liveRefreshes;
    }
    if (html !== liveMarkShown) renderSummary();
  }

  /**
   * One refresh of the live race `key`: the regatta document afresh, the official results linked again (the race's
   * own asked for afresh), then the race analysed again in the worker (only its telemetry's new end fetched) and
   * shown keeping the view (swapLive). Waits its turn while a load or the event's linking is under way; a load of
   * anything else since drops it. Errors go to the poller (it backs off); nothing is said on screen.
   */
  async function refreshLive(key: string): Promise<LiveTick> {
    const c = current;
    const was = analysis;
    if (!c || !was || liveKeyOf(c) !== key || c.eventId !== eventId || live?.key !== key) return 'done';
    // Past the live span (refreshes failing all along, say): stop.
    if (!isLiveNow()) {
      syncLive();
      return 'done';
    }
    if (pending.size || official.status === 'pending' || feed.status === 'running') return 'more';
    const id = eventId;
    const req = eventReq;
    const gen = showGen;
    const stale = (): boolean => id !== eventId || req !== eventReq || gen !== showGen || analysis !== was || live?.key !== key;
    const next = await fetchRegatta(id, undefined, { fresh: true });
    if (stale()) return 'more';
    const doc = currentDoc(next);
    let outcome = outcomeOf();
    if (official.status === 'done') {
      const ys = outcome?.status === 'linked' ? { eventId: outcome.eventId, raceNumber: listedOf(c.division, c.raceNumber)?.officialNumber ?? null } : null;
      const override = ysParam ? { eventId: ysParam, cls: yscParam ?? null } : null;
      const got = await linkOfficial(httpYsSource(undefined, ys), linkRequest(doc, events.find((e) => e.eventId === id), override));
      if (stale()) return 'more';
      // A failed link keeps the results linked before.
      if (got.status === 'linked' || outcome?.status !== 'linked') outcome = got;
    }
    const reg = mergeOrphans(next, orphansFound ?? new Map<string, OrphanFound[]>());
    const list = buildRaceList(currentDoc(reg), { links: linksOf(outcome), ...(orphansFound ? { orphans: orphansFound } : {}) });
    const listed = findListed(list, c.division, c.raceNumber);
    if (!listed) return 'done';
    const off = officialFor(outcome, listed);
    const logs = vkx.buffersFor(id, c.division, c.raceNumber);
    const classLabel = events.find((e) => e.eventId === id)?.classLabel;
    // A load asked for meanwhile goes first (this one would supersede it in the worker).
    if (pending.size) return 'more';
    let a: RaceAnalysis;
    try {
      a = await run(
        { type: 'live', eventId: id, regatta: reg, division: c.division, raceNumber: c.raceNumber, allCompetitors, classLabel, refresh: true, ...(off ? { official: off } : {}), ...(logs.length ? { vkx: logs } : {}) },
        true,
      );
    } catch (e) {
      if (isSuperseded(e)) return 'more';
      throw e;
    }
    if (stale()) return 'more';
    // The Coach's model and the map's full-rate tracks, when shown for the race before, are made for the new one before
    // it goes on screen (the worker holds it now), so neither blanks out meanwhile.
    const coachWas = coach?.a === was ? coach : null;
    const fullWas = fullRate?.a === was && fullRate.set ? fullRate : null;
    const [raw, tracks] = await Promise.all([coachWas ? coachRawOf(raceKeyOf(a)) : null, fullWas ? fullRateOf(a) : null]);
    if (stale()) return 'more';
    baseRegatta = next;
    regatta = reg;
    if (official.status === 'done' && outcome) official = { status: 'done', outcome };
    raceList = list;
    renderRaceOptions();
    if (live?.key === key) {
      live.updatedMs = Date.now();
      live.refreshes++;
    }
    swapLive(was, a, coachWas ? coachModelOf(a, raw) : undefined, fullWas ? new Map((tracks ?? []).map((tk) => [tk.id, tk])) : undefined);
    syncLive();
    return live?.key === key ? 'more' : 'done';
  }

  /**
   * Put a live race's refreshed analysis `a` on screen in place of `was` (the same race), keeping the view: the boat,
   * tab, leg selection and any leg's view or card window, sorts, both charts' zoom (the map's Fit grows with the new
   * fixes), the scrubber (following the new end when it was at the end), playback and every scrolled list or table; no
   * loading state, no URL change.
   */
  function swapLive(was: RaceAnalysis, a: RaceAnalysis, model: CoachModel | null | undefined, full: FullRateSet | undefined): void {
    const oldEnd = scrubWindow(was).t1;
    analysis = a;
    if (model !== undefined) {
      const before = coach?.model ?? null;
      coach = { a, model };
      coachBuilding = null;
      // The card picked stays picked (renderCoach keeps coachSel while the debrief it indexes is this one).
      if (model && coachDeb && coachDeb.model === before) coachDeb = { model, boat: coachDeb.boat, d: coachDebrief(a, model, coachDeb.boat) };
    }
    if (full) fullRate = { a, set: full };
    // The over-early starts don't change with the race's later fixes: kept (a replay open stays open).
    if (replays?.a === was) replays = { a, list: replays.list };
    if (mapFit && mapFitFor?.a === was) {
      const prev = mapFit;
      mapFitFor = { a, leg: mapFitFor.leg };
      mapFit = mapBox(a, mapFitFor.leg);
      syncMapView(liveView(prev, mapView, mapFit));
    }
    scrubT = liveScrubT(scrubT, oldEnd, scrubWindow(a));
    // The boat list, tables and other boxes rebuilt stay scrolled where they were.
    keepScroll(els.digest, render);
  }

  let orphansFound: Map<string, OrphanFound[]> | null = null;
  let enrichGen = 0;
  /**
   * After the race list first renders: link official results (or follow `ys=`), relabel, then look
   * for unlisted races in the feed (bounded: data/orphans.ts) and list them. The first race waits for the
   * official link at most OFFICIAL_WAIT_MS (loadRace), never for the feed probe; every failure ends as a chip with
   * RaceSense numbering kept.
   */
  async function enrich(id: string, req: number): Promise<void> {
    const gen = ++enrichGen;
    const stale = (): boolean => gen !== enrichGen || req !== eventReq || id !== eventId;
    const base = baseRegatta;
    if (!base) return;
    const doc = currentDoc(base);
    // A race load waits a little for the official results (loadRace): settled once they are linked and listed.
    let linked = (): void => undefined;
    officialLinking = new Promise<void>((r) => (linked = r));
    try {
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
    } finally {
      linked();
    }
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
  /** 'empty': no races yet (emptyDoc holds its document); 'missing': a strict (restore) `want` isn't listed; an Error: the race failed to load. */
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
      if (!list.races.length) {
        emptyDoc = doc;
        return 'empty';
      }
      hideEventCard();
      if (id !== eventId) {
        track('regatta_open', { event: id });
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
      // The default race depends on the viewer's passes (race 1 for a regatta they can't open): /api/auth/me
      // first (already asked at load; loadRace waits for it anyway), so the free race opens without a lock card's flash.
      await paywall.ready;
      if (req !== eventReq) return 'superseded';
      const pick = startRace(races, want, defaultRace(doc), { me: paywall.me(), free: () => freeOf(next), eventId: id, now: Date.now() }, opts.strict);
      if (!pick) return 'missing';
      els.race.value = `${pick.division}|${pick.raceNumber}`;
      const wanted = want && pick.division === want.division && pick.raceNumber === want.raceNumber;
      return await loadRace(pick.division, pick.raceNumber, wanted ? opts.view : undefined);
    } catch (e) {
      if (req !== eventReq) return 'superseded';
      throw e;
    }
  }

  const landingOf = (id: string): LandingEvent | undefined => events.find((e) => e.eventId === id) ?? listed.find((e) => e.eventId === id);
  const titleOf = (id: string): string => landingOf(id)?.title ?? id;

  /**
   * An event with no races yet (not started, or nothing posted): its card in place of the digest, the
   * picker showing it, and the URL naming it (so a reload, or a sign-in from Notify me, comes back here).
   */
  function showEventCard(id: string, doc: RegattaDoc | null): void {
    if (cardEventId !== id) track('regatta_open', { event: id, detail: 'card' });
    pickerShown = false;
    setTrackPage({ event: id });
    cardEventId = id;
    cardDoc = doc;
    stopLive();
    els.digest.hidden = true;
    paywall.hideLock();
    els.race.innerHTML = '<option>—</option>';
    raceOptionsHtml = '';
    els.race.disabled = true;
    setStatus('');
    setNotice('');
    setUrl({ event: id, div: null, race: null, nc: null });
    renderEventCard();
    renderEventOptions();
  }

  function renderEventCard(): void {
    if (!cardEventId) return;
    const v = eventCardView(cardEventId, cardDoc, landingOf(cardEventId), Date.now());
    cardEl.innerHTML = eventCardHtml(v, { me: paywall.me(), free: paywall.free(cardEventId), notify: alerts.state(cardEventId) });
    cardEl.hidden = false;
  }

  /** A race is loading: the card goes (the digest or the lock card takes its place). */
  function hideEventCard(): void {
    if (!cardEventId) return;
    cardEventId = '';
    cardDoc = null;
    cardEl.hidden = true;
    cardEl.innerHTML = '';
  }

  cardEl.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-notify]');
    if (b?.dataset.notify) notify(b.dataset.notify);
  });
  els.summary.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-notify]');
    if (b?.dataset.notify) notify(b.dataset.notify);
  });

  /** A user pick (select, or Enter in the search). On failure the select goes back to the loaded event. */
  function pickEvent(id: string): void {
    if (!id || (id === eventId && !cardEventId && !pickerShown) || id === cardEventId) return;
    // A hand-set official link belongs to the event it was set on.
    if (ysParam !== undefined) {
      ysParam = undefined;
      yscParam = undefined;
      setUrl({ [YS_PARAM]: null, [YSC_PARAM]: null });
    }
    nav.begin();
    openEvent(id);
  }

  /** Load an event (and its wanted race, else its default), or show its card when it has no races yet. */
  function openEvent(id: string, want?: { division: string; raceNumber: number }): void {
    pickerShown = false;
    loadEvent(id, want).then(
      (r) => {
        if (r === 'empty') showEventCard(id, emptyDoc);
        else if (r instanceof Error) nav.cancel();
      },
      (e: Error) => {
        nav.cancel();
        setStatus(`Couldn't load ${titleOf(id)}: ${e.message}`);
        renderEventOptions();
      },
    );
  }

  els.event.addEventListener('change', () => pickEvent(els.event.value));
  /** Open a race of the list, as the Race menu does (the menu shows it; `restore` sets the view, else it carries over or resets). */
  function chooseRace(division: string, raceNumber: number, restore?: ViewState): void {
    pickerShown = false;
    els.race.value = `${division}|${raceNumber}`;
    void loadRace(division, raceNumber, restore).then((r) => r instanceof Error && nav.cancel());
  }
  els.race.addEventListener('change', () => {
    const [div, n] = els.race.value.split('|');
    nav.begin();
    chooseRace(div, Number(n));
  });

  /**
   * Back at the bare /regattas: nothing on screen and the picker empty, as a boot with nothing to open leaves
   * it. Any load in flight is dropped; the last event stays loaded (its cache too) for a forward.
   */
  function showPicker(): void {
    ++eventReq;
    ++showGen;
    if (playing) stopPlay(false);
    pickerShown = true;
    current = null;
    stopLive();
    hideEventCard();
    paywall.hideLock();
    els.digest.hidden = true;
    els.race.innerHTML = '<option>—</option>';
    raceOptionsHtml = '';
    els.race.disabled = true;
    setStatus('');
    setNotice('');
    setTrackPage({});
    renderEventOptions();
  }

  /**
   * Back / forward within the race on screen: the entry's map focus (a leg's view, a card's window) opened, or the
   * one open left (the coloring and leg selection it replaced put back), then the entry's own leg selection
   * (stampLegs). Full screen's back (its close's, or one that closed it) changes nothing: the focus stays, its URL
   * written again.
   */
  function popFocus(): void {
    const a = analysis;
    if (!a) return;
    if (fullscreen.ownPop) {
      if (focusOn) setUrl({ ...scrubParams(scrubT, a.meta.gunMs, scrubTrail), ...focusParams(a, focusOn) });
      return;
    }
    // Read before a focus opened saves (and stamps) the selection it replaced.
    const leg = stampedLeg(history.state, a.legs.length);
    const act = focusOnPop(location.search, a, a.drawings.map((d) => d.id), focusOn);
    if (act.kind === 'open') openFocus(act.focus, act.at);
    else if (act.kind === 'leave') leaveFocus(true);
    if (leg === undefined) return;
    if (focusOn) {
      // Kept to come back when the focus is left.
      if (legBefore) legBefore = { leg };
    } else if (leg !== legSel) {
      legSel = leg;
      render();
    }
    save();
  }

  /** What is on screen, for popAction (nav.ts). */
  const screenNow = (): Screen =>
    pickerShown
      ? { card: '', eventId: '', race: null }
      : { card: cardEventId, eventId, race: current && current.eventId === eventId ? { division: current.division, raceNumber: current.raceNumber } : null };

  // Back / forward between the app's pages (nav.ts), and a hash typed or linked in the page: show what the
  // entry's URL names (each write then replaces it). Full screen's own entry has the page's URL, so its back
  // changes nothing here. An old `#coach` link is read at load (startTab), not here.
  addEventListener('popstate', () => {
    nav.cancel();
    const t = tabFromHash(location.hash, tabs);
    const on = reportFromUrl(location.search, location.hash);
    if (on !== reportOn) setReport(on);
    if (t && t !== tab) setTab(t, { scroll: false });
    const a = popAction(location.search, screenNow());
    if (a.kind === 'none') popFocus();
    else if (focusOn) leaveFocus(true);
    if (a.kind === 'picker') showPicker();
    else if (a.kind === 'event') {
      els.event.value = a.eventId;
      openEvent(a.eventId, a.want);
    } else if (a.kind === 'race') chooseRace(a.division, a.raceNumber);
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
      const only = pickerOptions(events, els.search.value, '', undefined, { events: upcoming, now: Date.now() }).matches[0];
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
    track('app_open');
    setNotice('');
    try {
      setStatus('Loading events…');
      // /api/landing returns every listed event in one response (no pagination), so
      // filtering this list client-side searches the whole feed, as RaceSense's own page does.
      const landing = await fetchLanding();
      const now = Date.now();
      const recency = (e: LandingEvent): number => (e.capturedRaceTime ? Date.parse(e.capturedRaceTime) : Math.min(e.endMs, now));
      listed = landing.events;
      events = landing.events.filter((e) => eventStarted(e.startMs, now)).sort((a, b) => recency(b) - recency(a));
      upcoming = upcomingEvents(landing.events, now);
    } catch (e) {
      setStatus('');
      els.event.innerHTML = '<option>—</option>';
      setNotice(`Couldn't load the live race list (${(e as Error).message}).`, { label: 'Retry', run: () => void boot() });
      return;
    }
    const explicit = params.eventId;
    if (explicit && !events.some((e) => e.eventId === explicit) && !upcoming.some((e) => e.eventId === explicit)) {
      events.unshift(listed.find((e) => e.eventId === explicit) ?? { eventId: explicit, title: explicit, startMs: 0, endMs: 0 });
    }
    // Notify me from the landing page or back from its sign-in (notify.ts): drop the marker, then sign in or ask (never turn the emails on without a click).
    if (explicit && new URLSearchParams(location.search).has(NOTIFY_PARAM)) {
      setUrl({ [NOTIFY_PARAM]: null });
      // An event the list doesn't name yet: "this regatta" rather than its id.
      const title = titleOf(explicit) === explicit ? '' : titleOf(explicit);
      void paywall.ready.then((me) => handleNotifyParam(explicit, me, { signIn: notifySignIn, alerts, title }));
    }
    renderEventOptions();
    void paywall.ready.then(renderEventOptions);
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
        showEventCard(explicit, emptyDoc);
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
    if (r === 'empty') {
      // Its races are gone from the feed: the event's card, as a link to it would show.
      forget();
      showEventCard(id, emptyDoc);
      return;
    }
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
    const why = r === 'missing' ? `${want.division} race ${want.raceNumber} is no longer listed` : r.message;
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

  // What the Feedback sheet reports from here (src/feedback/state.ts): boats by sail number only.
  setPageState(() => {
    const sailOf = (id: string | null): string | undefined => (id ? analysis?.boats.find((b) => b.id === id)?.sail : undefined);
    const me = paywall.me();
    return {
      eventId: cardEventId || (current?.eventId ?? (eventId || undefined)),
      eventTitle: cardEventId ? titleOf(cardEventId) : current || eventId ? titleOf(current?.eventId ?? eventId) : undefined,
      division: current?.division,
      race: current?.raceNumber,
      tab,
      boats: [...new Set([sailOf(highlight), sailOf(coachBoat)].filter((s): s is string => !!s))],
      leg: shownLeg(legSel, focusOn),
      coachView,
      coachGroup: coachGroup.kind,
      trail: scrubTrail,
      trackColour,
      rankBy,
      playing,
      fullScreen: full,
      report: reportOn,
      loaded: !!analysis,
      boatCount: analysis?.boats.length,
      paywall: me.paywall,
      locked: paywall.lockShown(),
      free: current ? paywall.free(current.eventId) : undefined,
      signedIn: me.paywall ? !!me.user : undefined,
    };
  });
  void boot();
}
