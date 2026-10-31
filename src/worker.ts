/**
 * Heavy lifting off the main thread: fetch the race's telemetry window,
 * normalize it to RaceData, run the analysis, post back the result. The
 * Coach tab's Regatta view runs a second instance of this worker, asking
 * for one race at a time and getting back only a small digest for one boat.
 */
import { analyzeRace } from './analysis/analyze';
import { coachRaceKey, coachRaw, type CoachRaw } from './analysis/coach';
import { digestRace, type RaceDigest } from './analysis/coach/regatta';
import { fullRateBuffers, fullRateTracks, type FullRateWant } from './analysis/fullRate';
import { startReplays, type StartReplay } from './analysis/startReplay';
import { drawingBuffers } from './analysis/transfer';
import type { FullRateTrack, RaceAnalysis } from './analysis/types';
import type { RaceData } from './data/types';
import { buildRaceData, currentDoc, findRace, listRaces, nextGunMs, telemetryWindow, type OfficialRaceInput } from './data/racesense/adapter';
import { eventFinished } from './data/recovery';
import { fetchTelemetry, fetchWind } from './data/racesense/api';
import type { RegattaResponse } from './data/racesense/types';
import { mergeUploadBytes } from './data/vkx/merge';
import { isPaywallError } from './data/paywall';
import { attemptRegatta, attemptWindow, earlierAttempts } from './data/attempts';

export interface RaceRequest {
  id: number;
  eventId: string;
  regatta: RegattaResponse;
  division: string;
  raceNumber: number;
  /** `nc=all`: keep coach/spare boats as competitors. */
  allCompetitors?: boolean;
  /** The event's class label from the landing list, for the class dimensions. */
  classLabel?: string;
  /** This race's official results (linked by gun); places and codes win, times if plausible. */
  official?: OfficialRaceInput | null;
  /** Uploaded boat logs for this race (gzipped payloads, data/vkx): merged into their boats' tracks. */
  vkx?: { bytes: ArrayBuffer; uploadedAt: number }[];
}

export type WorkerRequest =
  | (RaceRequest & { type: 'live' })
  /** Coach's Regatta view: one race analysed for one boat (by sail), down to its digest; nothing kept. */
  | (RaceRequest & { type: 'regatta-race'; sail: string })
  /** Coach (lazy, on the tab's first open): the fleet wind series and start crossings of the race last analysed, from its raw fixes. */
  | { id: number; type: 'coach-raw'; key: string }
  /** Track map, zoomed in tight: the race last analysed at full rate (analysis/fullRate.ts). */
  | { id: number; type: 'full-rate'; key: string; wants: FullRateWant[] }
  /** Track map, "Replay start": the over-early boats' start facts of the race last analysed, from its raw fixes (analysis/startReplay.ts). */
  | { id: number; type: 'start-replay'; key: string }
  /** The Start tab: an earlier start attempt of the race (data/attempts.ts), analysed on its own for its picture; nothing kept. */
  | (RaceRequest & { type: 'attempt'; index: number })
  /** Stop attempt request `id` (another was asked for, or it was closed): its fetches are aborted and no answer comes. */
  | { id: number; type: 'cancel' };

export type WorkerResponse =
  | { id: number; type: 'progress'; message: string }
  | { id: number; type: 'done'; analysis: RaceAnalysis }
  /** `raw` null: that race isn't the one last analysed here; the caller works the wind out from the drawn tracks, with no start crossings. */
  | { id: number; type: 'coach-raw'; raw: CoachRaw | null }
  | { id: number; type: 'regatta-race'; digest: RaceDigest }
  /** `tracks` null: that race isn't the one last analysed here; the map keeps its ~1 Hz segments. */
  | { id: number; type: 'full-rate'; tracks: FullRateTrack[] | null }
  /** `replays` null: that race isn't the one last analysed here; no replay (the Coach has no start crossings either). */
  | { id: number; type: 'start-replay'; replays: StartReplay[] | null }
  | { id: number; type: 'attempt'; analysis: RaceAnalysis }
  | { id: number; type: 'error'; message: string };

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
};

/** The race last analysed, kept for the Coach tab's wind (its raw fixes are not posted back). */
let last: { key: string; analysis: RaceAnalysis; data: RaceData } | null = null;
/** The newest race request: an older one finishing late doesn't take `last`. */
let latest = 0;
/** The attempt requests in flight, by id, so a `cancel` can abort their fetches. */
const attemptAborts = new Map<number, AbortController>();

/**
 * Fetch, normalise and analyse one race; `attempt` (a start index): that earlier start of it alone, its short window,
 * no official results or uploaded logs (data/attempts.ts).
 */
async function analyse(req: RaceRequest, attempt: number | null = null, signal?: AbortSignal): Promise<{ analysis: RaceAnalysis; data: RaceData }> {
  const progress = (message: string): void => ctx.postMessage({ id: req.id, type: 'progress', message });
  const ref = { division: req.division, raceNumber: req.raceNumber };
  const at = attempt != null ? earlierAttempts(findRace(currentDoc(req.regatta), ref).race).find((x) => x.index === attempt) : null;
  if (attempt != null && !at) throw new Error('No such start attempt');
  const regatta = at ? attemptRegatta(req.regatta, ref, at.index) : req.regatta;
  const official = at ? null : (req.official ?? null);
  const doc = currentDoc(regatta);
  const win = at ? attemptWindow(at) : telemetryWindow(doc, ref);
  // A race of an event over for a day is finished too, finishes or not (its windows can be cached long).
  const finished =
    !!at ||
    (listRaces(doc, { practice: true }).find((r) => r.division === ref.division && r.raceNumber === ref.raceNumber)?.finished ?? false) || eventFinished(doc);
  const nextGun = at ? at.nextGunMs : nextGunMs(doc, ref);
  const resolve = { official, nextGunMs: nextGun };
  progress('Fetching tracks for this race…');
  const pages = await fetchTelemetry(req.eventId, req.division, win.after, win.before, {
    finished,
    signal,
    onPage: (n, rows) => progress(`Fetched page ${n} (${rows.toLocaleString()} points)…`),
  });
  const { race } = findRace(doc, ref);
  const line = race.starts.at(-1)?.startLine;
  const gun = race.starts.at(-1)?.startTime ?? win.after;
  const wind = line ? await fetchWind((line.leftEnd[0] + line.rightEnd[0]) / 2, (line.leftEnd[1] + line.rightEnd[1]) / 2, gun, signal) : undefined;
  // The wind is best-effort (an abort there reads as no wind): a cancelled attempt stops here, before the crunching.
  signal?.throwIfAborted();
  progress('Crunching…');
  let data = buildRaceData(regatta, ref, pages, { eventId: req.eventId, wind, classLabel: req.classLabel, ...resolve });
  // Marks shared across divisions may not carry this division's tag: top up from a 1-minute unfiltered window.
  if (data.course.length === 0 && (findRace(doc, ref).div.courses?.[0]?.achievements?.length ?? 0) > 2) {
    progress('Fetching mark positions…');
    // Paywall: an unfiltered window can carry another division's later race, so it may be refused (401 / 402): race on without marks.
    const extra = await fetchTelemetry(req.eventId, null, gun, gun + 60_000, { finished, signal }).catch((e: unknown) => {
      if (e instanceof Error && isPaywallError(e.message)) return [];
      throw e;
    });
    const markOnly = extra.map((p) => {
      if (!p.Fields || !p.Rows) return p;
      const role = p.Fields.indexOf('role');
      return { Fields: p.Fields, Rows: role < 0 ? p.Rows : p.Rows.filter((r) => r[role] === 'mark') };
    });
    data = buildRaceData(regatta, ref, [...pages, ...markOnly], { eventId: req.eventId, wind, classLabel: req.classLabel, ...resolve });
    extra.length = 0;
  }
  pages.length = 0;
  if (req.vkx?.length && !at) data = await mergeUploadBytes(data, req.vkx);
  return { analysis: analyzeRace(data, { allCompetitors: req.allCompetitors }), data };
}

async function handle(req: Extract<WorkerRequest, { type: 'live' }>): Promise<RaceAnalysis> {
  // Let the previous race's raw fixes go before this one's are fetched.
  last = null;
  latest = req.id;
  const { analysis, data } = await analyse(req);
  // One race's raw fixes are kept (replaced by the next race's); the Coach wind is worked out from them only when asked for.
  if (req.id === latest) last = { key: coachRaceKey(req.eventId, req.division, req.raceNumber, !!req.allCompetitors), analysis, data };
  return analysis;
}

ctx.onmessage = (ev) => {
  const req = ev.data;
  if (req.type === 'coach-raw') {
    try {
      const raw = last && last.key === req.key ? coachRaw(last.analysis, last.data) : null;
      ctx.postMessage({ id: req.id, type: 'coach-raw', raw });
    } catch (err) {
      ctx.postMessage({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (req.type === 'full-rate') {
    try {
      const tracks = last && last.key === req.key ? fullRateTracks(last.data, req.wants) : null;
      ctx.postMessage({ id: req.id, type: 'full-rate', tracks }, tracks ? fullRateBuffers(tracks) : []);
    } catch (err) {
      ctx.postMessage({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (req.type === 'start-replay') {
    try {
      const replays = last && last.key === req.key ? startReplays(last.analysis, last.data) : null;
      ctx.postMessage({ id: req.id, type: 'start-replay', replays });
    } catch (err) {
      ctx.postMessage({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  const fail = (err: unknown): void => ctx.postMessage({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  if (req.type === 'cancel') {
    attemptAborts.get(req.id)?.abort();
    attemptAborts.delete(req.id);
    return;
  }
  if (req.type === 'attempt') {
    const ac = new AbortController();
    attemptAborts.set(req.id, ac);
    analyse(req, req.index, ac.signal)
      .then(({ analysis }) => {
        if (!ac.signal.aborted) ctx.postMessage({ id: req.id, type: 'attempt', analysis }, drawingBuffers(analysis));
      }, (err: unknown) => {
        if (!ac.signal.aborted) fail(err);
      })
      .finally(() => attemptAborts.delete(req.id));
    return;
  }
  if (req.type === 'regatta-race') {
    analyse(req).then(({ analysis, data }) => ctx.postMessage({ id: req.id, type: 'regatta-race', digest: digestRace(analysis, data, req.sail, req.official?.rows ?? null) }), fail);
    return;
  }
  handle(req).then(
    // The drawn tracks (x, y, t, SOG per fix) are most of the payload: move their buffers rather than copy them.
    (analysis) => ctx.postMessage({ id: req.id, type: 'done', analysis }, drawingBuffers(analysis)),
    fail,
  );
};
