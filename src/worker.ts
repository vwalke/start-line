/**
 * Heavy lifting off the main thread: fetch the race's telemetry window,
 * normalize it to RaceData, run the analysis, post back the result.
 */
import { analyzeRace } from './analysis/analyze';
import type { RaceAnalysis } from './analysis/types';
import { buildRaceData, currentDoc, defaultRace, findRace, listRaces, telemetryWindow } from './data/racesense/adapter';
import { fetchTelemetry, fetchWind } from './data/racesense/api';
import type { RegattaResponse, TelemetryPage, WindResponse } from './data/racesense/types';

export type WorkerRequest =
  | { id: number; type: 'live'; eventId: string; regatta: RegattaResponse; division: string; raceNumber: number }
  | { id: number; type: 'fixture'; url: string };

export type WorkerResponse =
  | { id: number; type: 'progress'; message: string }
  | { id: number; type: 'done'; analysis: RaceAnalysis }
  | { id: number; type: 'error'; message: string };

interface FixtureFile {
  eventId: string;
  regatta: RegattaResponse;
  wind?: WindResponse;
  telemetry: TelemetryPage;
}

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
};

async function handle(req: WorkerRequest): Promise<RaceAnalysis> {
  const progress = (message: string): void => ctx.postMessage({ id: req.id, type: 'progress', message });
  if (req.type === 'fixture') {
    progress('Loading the bundled demo race…');
    const res = await fetch(req.url);
    if (!res.ok) throw new Error(`Demo data unavailable (${res.status})`);
    const f = (await res.json()) as FixtureFile;
    const ref = defaultRace(currentDoc(f.regatta));
    if (!ref) throw new Error('Demo data has no finished race');
    progress('Crunching…');
    return analyzeRace(buildRaceData(f.regatta, ref, [f.telemetry], { eventId: f.eventId, kind: 'fixture', wind: f.wind }));
  }

  const doc = currentDoc(req.regatta);
  const ref = { division: req.division, raceNumber: req.raceNumber };
  const win = telemetryWindow(doc, ref);
  const finished = listRaces(doc).find((r) => r.division === ref.division && r.raceNumber === ref.raceNumber)?.finished ?? false;
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
  let data = buildRaceData(req.regatta, ref, pages, { eventId: req.eventId, wind });
  // Marks shared across divisions may not carry this division's tag: top up from a 1-minute unfiltered window.
  if (data.course.length === 0 && (findRace(doc, ref).div.courses?.[0]?.achievements?.length ?? 0) > 2) {
    progress('Fetching mark positions…');
    const extra = await fetchTelemetry(req.eventId, null, gun, gun + 60_000, { finished });
    const markOnly = extra.map((p) => ({ Fields: p.Fields, Rows: p.Rows?.filter((r) => r[p.Fields!.indexOf('role')] === 'mark') ?? null }));
    data = buildRaceData(req.regatta, ref, [...pages, ...markOnly], { eventId: req.eventId, wind });
    extra.length = 0;
  }
  pages.length = 0;
  return analyzeRace(data);
}

ctx.onmessage = (ev) => {
  const req = ev.data;
  handle(req).then(
    (analysis) => ctx.postMessage({ id: req.id, type: 'done', analysis }),
    (err: unknown) => ctx.postMessage({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) }),
  );
};
