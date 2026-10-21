/**
 * Boat-log uploads off the main thread: parse the .vkx (a 10 MB day log in
 * ~50 ms, but with hashing, matching and encoding it would jank), match it
 * to a fleet boat per race against the public feed, and build each race's
 * compact payload. Keeps the parsed log between steps.
 */
import { fetchTelemetry } from './data/racesense/api';
import { sha256Hex } from './data/vkx/compact';
import { coveredRaces, type RaceWindow } from './data/vkx/match';
import { VkxError, logSummary, parseVkx, type VkxLog } from './data/vkx/parse';
import { coverageGain, matchRace, payloadFor } from './data/vkx/plan';

export interface PlannedRace {
  race: RaceWindow;
  frac: number;
  fromMs: number;
  toMs: number;
  verdict: 'match' | 'sparse' | 'none';
  /** The matched (or best agreeing) boat. */
  boat: { sn: number; sail: string; n: number; medianM: number } | null;
  /** Sparse: every boat that agrees (the user confirms one). */
  candidates: { sn: number; sail: string; n: number }[];
  reason: string | null;
  before: number | null;
  beforeExact: boolean;
  after: number;
}

export type VkxWorkerRequest =
  | { id: number; type: 'parse'; file: ArrayBuffer }
  | {
      id: number;
      type: 'plan';
      eventId: string;
      division: string;
      races: RaceWindow[];
      /** Coverage per sail from the analysis on screen (race id → sail → 0–1), exact "before" figures. */
      known: Record<string, Record<string, number | null>>;
      finished: Record<string, boolean>;
    }
  | { id: number; type: 'encode'; eventId: string; division: string; picks: { raceId: string; sn: number; sail: string; name?: string }[] };

export type VkxWorkerResponse =
  | { id: number; type: 'progress'; message: string }
  | { id: number; type: 'parsed'; summary: ReturnType<typeof logSummary>; sha256: string; bytes: number }
  | { id: number; type: 'planned'; races: PlannedRace[] }
  | { id: number; type: 'encoded'; payloads: { raceId: string; bytes: ArrayBuffer; n: number }[] }
  | { id: number; type: 'error'; message: string; code?: string };

const ctx = self as unknown as {
  postMessage(msg: VkxWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<VkxWorkerRequest>) => void) | null;
};

let log: VkxLog | null = null;
let src: { sha256: string; bytes: number } | null = null;
let planned: PlannedRace[] = [];

async function handle(req: VkxWorkerRequest): Promise<void> {
  const progress = (message: string): void => ctx.postMessage({ id: req.id, type: 'progress', message });
  if (req.type === 'parse') {
    log = null;
    src = null;
    log = parseVkx(req.file);
    src = { sha256: await sha256Hex(req.file), bytes: req.file.byteLength };
    ctx.postMessage({ id: req.id, type: 'parsed', summary: logSummary(log), ...src });
    return;
  }
  if (!log || !src) throw new Error('No log loaded');
  if (req.type === 'plan') {
    const covered = coveredRaces(log.pos.t, req.races);
    const out: PlannedRace[] = [];
    for (const c of covered) {
      progress(`Checking ${c.race.label} against the public tracks…`);
      const m = await matchRace(log, c, async (after, before) =>
        fetchTelemetry(req.eventId, req.division, after, before, { finished: req.finished[c.race.id] ?? true }),
      );
      const v = m.verdict;
      const boat = v.kind === 'none' ? null : v.boat;
      const gain = coverageGain(log, m, boat ? req.known[c.race.id]?.[boat.sail] : null);
      out.push({
        race: c.race,
        frac: c.frac,
        fromMs: c.fromMs,
        toMs: c.toMs,
        verdict: v.kind,
        boat: boat ? { sn: boat.sn, sail: boat.sail, n: boat.n, medianM: boat.medianM } : null,
        candidates: v.kind === 'sparse' ? v.candidates.map((x) => ({ sn: x.sn, sail: x.sail, n: x.n })) : [],
        reason: v.kind === 'none' ? v.reason : null,
        ...gain,
      });
    }
    planned = out;
    ctx.postMessage({ id: req.id, type: 'planned', races: out });
    return;
  }
  const payloads: { raceId: string; bytes: ArrayBuffer; n: number }[] = [];
  for (const p of req.picks) {
    const r = planned.find((x) => x.race.id === p.raceId);
    if (!r) continue;
    progress(`Packing ${r.race.label}…`);
    const c = { race: r.race, frac: r.frac, fromMs: r.fromMs, toMs: r.toMs };
    const out = await payloadFor(log, c, { event: req.eventId, div: req.division }, { sn: p.sn, sail: p.sail, name: p.name }, src);
    const ab = out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer;
    payloads.push({ raceId: p.raceId, bytes: ab, n: out.n });
  }
  ctx.postMessage(
    { id: req.id, type: 'encoded', payloads },
    payloads.map((p) => p.bytes),
  );
}

ctx.onmessage = (ev) => {
  const req = ev.data;
  handle(req).catch((e: unknown) =>
    ctx.postMessage({ id: req.id, type: 'error', message: e instanceof Error ? e.message : String(e), ...(e instanceof VkxError ? { code: e.code } : {}) }),
  );
};
