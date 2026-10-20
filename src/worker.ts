/**
 * Heavy lifting off the main thread: fetch the race's telemetry window,
 * normalize it to RaceData, run the analysis, post back the result.
 */
import { analyzeRace } from './analysis/analyze';
import { coachRaceKey, coachRaw, type CoachRaw } from './analysis/coach';
import type { RaceAnalysis } from './analysis/types';
import type { RaceData } from './data/types';
import { buildRaceData, currentDoc, findRace, listRaces, nextGunMs, telemetryWindow, type OfficialRaceInput } from './data/racesense/adapter';
import { eventFinished } from './data/recovery';
import { fetchTelemetry, fetchWind } from './data/racesense/api';
import type { RegattaResponse } from './data/racesense/types';

export type WorkerRequest =
  | {
      id: number;
      type: 'live';
      eventId: string;
      regatta: RegattaResponse;
      division: string;
      raceNumber: number;
      /** `nc=all`: keep coach/spare boats as competitors. */
      allCompetitors?: boolean;
      /** The event's class label from the landing list, for the class dimensions. */
      classLabel?: string;
      /** Keep raw RaceData so the Coach tab can build the wind series. Off unless `?coach=1`. */
      coach?: boolean;
      /** This race's official results (linked by gun); places and codes win, times if plausible. */
      official?: OfficialRaceInput | null;
    }
  /** Coach (lazy, on the tab's first open): the fleet wind series and start crossings of the race last analysed, from its raw fixes. */
  | { id: number; type: 'coach-raw'; key: string };

export type WorkerResponse =
  | { id: number; type: 'progress'; message: string }
  | { id: number; type: 'done'; analysis: RaceAnalysis }
  /** `raw` null: that race isn't the one last analysed here; the caller works the wind out from the drawn tracks, with no start crossings. */
  | { id: number; type: 'coach-raw'; raw: CoachRaw | null }
  | { id: number; type: 'error'; message: string };

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
};

/** The race last analysed, kept for the Coach tab's wind (its raw fixes are not posted back). */
let last: { key: string; analysis: RaceAnalysis; data: RaceData } | null = null;

async function handle(req: Extract<WorkerRequest, { type: 'live' }>): Promise<RaceAnalysis> {
  const progress = (message: string): void => ctx.postMessage({ id: req.id, type: 'progress', message });
  const doc = currentDoc(req.regatta);
  const ref = { division: req.division, raceNumber: req.raceNumber };
  const win = telemetryWindow(doc, ref);
  // A race of an event over for a day is finished too, finishes or not (its windows can be cached long).
  const finished =
    (listRaces(doc, { practice: true }).find((r) => r.division === ref.division && r.raceNumber === ref.raceNumber)?.finished ?? false) || eventFinished(doc);
  const nextGun = nextGunMs(doc, ref);
  const resolve = { official: req.official ?? null, nextGunMs: nextGun };
  progress('Fetching tracks for this race…');
  const pages = await fetchTelemetry(req.eventId, req.division, win.after, win.before, {
    finished,
    onPage: (n, rows) => progress(`Fetched page ${n} (${rows.toLocaleString()} points)…`),
  });
  const { race } = findRace(doc, ref);
  const line = race.starts.at(-1)?.startLine;
  const gun = race.starts.at(-1)?.startTime ?? win.after;
  const wind = line ? await fetchWind((line.leftEnd[0] + line.rightEnd[0]) / 2, (line.leftEnd[1] + line.rightEnd[1]) / 2, gun) : undefined;
  progress('Crunching…');
  let data = buildRaceData(req.regatta, ref, pages, { eventId: req.eventId, wind, classLabel: req.classLabel, ...resolve });
  // Marks shared across divisions may not carry this division's tag: top up from a 1-minute unfiltered window.
  if (data.course.length === 0 && (findRace(doc, ref).div.courses?.[0]?.achievements?.length ?? 0) > 2) {
    progress('Fetching mark positions…');
    const extra = await fetchTelemetry(req.eventId, null, gun, gun + 60_000, { finished });
    const markOnly = extra.map((p) => {
      if (!p.Fields || !p.Rows) return p;
      const role = p.Fields.indexOf('role');
      return { Fields: p.Fields, Rows: role < 0 ? p.Rows : p.Rows.filter((r) => r[role] === 'mark') };
    });
    data = buildRaceData(req.regatta, ref, [...pages, ...markOnly], { eventId: req.eventId, wind, classLabel: req.classLabel, ...resolve });
    extra.length = 0;
  }
  pages.length = 0;
  const analysis = analyzeRace(data, { allCompetitors: req.allCompetitors });
  // Without the flag the worker drops the raw tracks, as before this tab existed.
  last = req.coach ? { key: coachRaceKey(req.eventId, req.division, req.raceNumber, !!req.allCompetitors), analysis, data } : null;
  return analysis;
}

/** Each drawn track's typed-array buffers, once each (analyze.ts gives every array its own). */
function drawingBuffers(a: RaceAnalysis): Transferable[] {
  const out = new Set<ArrayBuffer>();
  for (const d of [...a.drawings, ...a.excluded.map((e) => e.drawing)]) {
    for (const tk of [d.trail, ...d.segments]) for (const arr of [tk.x, tk.y, tk.t, tk.sog]) out.add(arr.buffer as ArrayBuffer);
    out.add(d.startSog.t.buffer as ArrayBuffer);
    out.add(d.startSog.sog.buffer as ArrayBuffer);
  }
  return [...out];
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
  handle(req).then(
    // The drawn tracks (x, y, t, SOG per fix) are most of the payload: move their buffers rather than copy them.
    (analysis) => ctx.postMessage({ id: req.id, type: 'done', analysis }, drawingBuffers(analysis)),
    (err: unknown) => ctx.postMessage({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) }),
  );
};
