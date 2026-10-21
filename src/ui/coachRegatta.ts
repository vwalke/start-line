/**
 * The Coach tab's Regatta view: the selected boat over every race the race menu offers (practice
 * left out; rebuilt and tracker-only races in), summed up by analysis/coach/regatta.ts.
 *
 * Races are analysed on demand, one at a time, in a second worker (the race on screen keeps its
 * own), when the view is first shown; each race's digest is cached for the visit by event,
 * division, race, `nc=all`, boat, official results and uploaded logs, so switching back and forth
 * costs nothing and a change of any of those re-runs only what it touches. Nothing here needs a
 * race to have been opened before (the cold-load case).
 */
import { legWord, summarizeRegatta, type LegTypeSummary, type RaceFinish, type RegattaRace, type RegattaSummary, type WentWell, type WorkOn } from '../analysis/coach/regatta';
import type { ListedRace } from '../data/raceList';
import type { OfficialRaceInput } from '../data/racesense/adapter';
import type { RegattaResponse } from '../data/racesense/types';
import type { FinishSource } from '../data/types';
import type { RaceRequest, WorkerRequest, WorkerResponse } from '../worker';
import { wentWellHtml } from './coachCards';
import { esc, ordinal } from './format';
import { raceName, shortRaceName } from './races';

/** What the runner needs of a worker (a Worker, or a test double). */
export interface WorkerPort {
  postMessage(msg: WorkerRequest): void;
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null;
  /** Real workers implement this; the runner uses it to drop in-flight work when the queue is cleared. */
  terminate?(): void;
}

/** One race the view wants: the menu's race and the request that analyses it for the boat. */
export interface RegattaJob {
  key: string;
  raceNumber: number;
  label: string;
  name: string;
  request: Omit<RaceRequest, 'id'> & { sail: string };
}

/** The cache key: what changes a race's digest (the boat, `nc=all`, official results, uploaded logs). */
export function regattaJobKey(r: Omit<RaceRequest, 'id' | 'regatta'> & { sail: string }): string {
  const logs = (r.vkx ?? []).map((v) => v.uploadedAt).join(',');
  const row = r.official?.rows.find((x) => x.rsSail === r.sail);
  // Official race number plus this boat's place/code and the fleet size, so
  // relinking the same number to another event does not reuse the old digest.
  const official = r.official ? `${r.official.number}:${r.official.rows.length}:${row?.place ?? ''}:${row?.code ?? ''}` : '-';
  return [r.eventId, r.division, r.raceNumber, r.allCompetitors ? 'all' : '', r.sail, official, logs].join('|');
}

/**
 * The jobs for one boat: every race of the division the race menu lists (its numbering, rebuilt and
 * tracker-only races included), practice left out, in gun order; each with its official results
 * and uploaded logs, as the race view would load it.
 */
export function regattaJobs(
  races: readonly ListedRace[],
  o: {
    eventId: string;
    regatta: RegattaResponse;
    division: string;
    sail: string;
    allCompetitors?: boolean;
    classLabel?: string;
    officialOf?: (r: ListedRace) => OfficialRaceInput | null;
    logsOf?: (r: ListedRace) => { bytes: ArrayBuffer; uploadedAt: number }[];
  },
): RegattaJob[] {
  return races
    .filter((r) => r.division === o.division && !r.practice)
    .sort((p, q) => p.gunMs - q.gunMs)
    .map((r) => {
      const off = o.officialOf?.(r) ?? null;
      const logs = o.logsOf?.(r) ?? [];
      const request = {
        eventId: o.eventId,
        regatta: o.regatta,
        division: o.division,
        raceNumber: r.raceNumber,
        allCompetitors: !!o.allCompetitors,
        ...(o.classLabel ? { classLabel: o.classLabel } : {}),
        sail: o.sail,
        ...(off ? { official: off } : {}),
        ...(logs.length ? { vkx: logs } : {}),
      };
      const name = raceName(r);
      return { key: regattaJobKey(request), raceNumber: r.raceNumber, label: shortRaceName(name), name, request };
    });
}

export interface RegattaProgress {
  /** The race being analysed (its menu name) and the worker's last word on it. */
  running: string | null;
  message: string;
  done: number;
  total: number;
}

export interface RegattaRunner {
  /** The races to show, in order; starts (or carries on) analysing the ones not cached. */
  want(jobs: readonly RegattaJob[]): void;
  /** The wanted races with what is known of each. */
  races(): RegattaRace[];
  progress(): RegattaProgress;
}

type Cached = { status: 'done'; digest: NonNullable<RegattaRace['digest']> } | { status: 'error'; error: string };

/**
 * Analyse the wanted races one at a time on a worker made on first use. `onChange` runs after
 * each race (and each progress message) that is still wanted: the caller re-renders. A race still
 * running when the wanted list changes to other races finishes into the cache; nothing is ever
 * asked twice in a visit. Clearing the list (left the event, or no boat) drops the in-flight
 * race and terminates the worker so it cannot leak or paint stale results.
 */
export function createRegattaRunner(makeWorker: () => WorkerPort, onChange: () => void): RegattaRunner {
  let port: WorkerPort | null = null;
  const cache = new Map<string, Cached>();
  let jobs: readonly RegattaJob[] = [];
  let running: { id: number; job: RegattaJob; message: string } | null = null;
  let nextId = 0;

  const wanted = (key: string): boolean => jobs.some((j) => j.key === key);

  const dropWorker = (): void => {
    port?.terminate?.();
    port = null;
  };

  const workerOf = (): WorkerPort => {
    if (port) return port;
    port = makeWorker();
    port.onmessage = (ev) => {
      const msg = ev.data;
      if (!running || msg.id !== running.id) return;
      if (msg.type === 'progress') {
        running.message = msg.message;
        if (wanted(running.job.key)) onChange();
        return;
      }
      const key = running.job.key;
      const d = msg.type === 'regatta-race' ? msg.digest : null;
      if (d && d.sail === running.job.request.sail && d.raceNumber === running.job.raceNumber) {
        cache.set(key, { status: 'done', digest: d });
      } else {
        cache.set(key, { status: 'error', error: msg.type === 'error' ? msg.message : 'unexpected reply' });
      }
      running = null;
      pump();
      if (wanted(key) || jobs.length) onChange();
    };
    return port;
  };

  function pump(): void {
    if (running) return;
    const job = jobs.find((j) => !cache.has(j.key));
    if (!job) return;
    running = { id: ++nextId, job, message: '' };
    workerOf().postMessage({ ...job.request, id: running.id, type: 'regatta-race' });
  }

  return {
    want(next) {
      jobs = next;
      // Nothing wanted: stop the queue and kill the in-flight fetch (event change, or no boat).
      if (running && !wanted(running.job.key) && !jobs.length) {
        running = null;
        dropWorker();
      }
      pump();
    },
    races() {
      return jobs.map((j) => {
        const c = cache.get(j.key);
        const base = { raceNumber: j.raceNumber, label: j.label, name: j.name };
        if (c?.status === 'done') return { ...base, status: 'done', digest: c.digest };
        if (c?.status === 'error') return { ...base, status: 'error', digest: null, error: c.error };
        return { ...base, status: running?.job.key === j.key ? 'running' : 'pending', digest: null };
      });
    },
    progress() {
      const done = jobs.filter((j) => cache.has(j.key)).length;
      const r = running && jobs.some((j) => j.key === running!.job.key) ? running : null;
      return { running: r?.job.name ?? null, message: r?.message ?? '', done, total: jobs.length };
    },
  };
}

// ---- the view

const SOURCE_WORDS: Record<FinishSource, string> = { official: 'official', racesense: "RaceSense's finish", tracker: 'tracker finish' };

/** `12th`, `~12th` (a tracker finish), the official code, or a dash. */
export const finishShort = (f: RaceFinish | null): string => (f?.place != null ? `${f.source === 'tracker' ? '~' : ''}${ordinal(f.place)}` : (f?.code ?? '—'));

export const secs = (s: number): string => `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(Math.round(s))} s`;

export const LEG_TYPE: Record<LegTypeSummary['kind'], string> = { upwind: 'Beats', downwind: 'Runs', reach: 'Reaches' };

/** A leg-type row's best or worst leg: "R2 Beat 1: −12 s, 3rd of 20" (⚠ low data). */
export const legExtremeText = (e: LegTypeSummary['best']): string => `${e.label} ${e.leg}: ${secs(e.deltaS)}, ${ordinal(e.rank)} of ${e.of}${e.low ? ' ⚠' : ''}`;

/** What a race's place chip says on hover: "3rd of 20, official", "not analysed yet", "couldn't load: …". */
export function placeWhat(r: RegattaSummary['rows'][number]): string {
  const f = r.digest?.finish ?? null;
  if (r.status === 'pending' || r.status === 'running') return 'not analysed yet';
  if (r.status === 'error') return `couldn't load: ${r.error ?? ''}`;
  if (f) return `${f.place != null ? `${ordinal(f.place)} of ${f.of}` : `${f.code ?? 'no place'}`}, ${SOURCE_WORDS[f.source]}${r.digest?.tracked ? '' : ', no track'}`;
  return r.digest?.tracked ? 'no finish' : 'not in this race';
}

/** The status line: progress while races are analysed, then what was found. */
export function regattaStatusHtml(s: RegattaSummary, p: RegattaProgress): string {
  if (!s.total) return '<p class="muted coach-none">No races in this event yet.</p>';
  const low = s.rows.filter((r) => r.low).length;
  const errs = s.rows.filter((r) => r.status === 'error').length;
  const parts: string[] = [];
  if (p.running) parts.push(`Analysing ${esc(p.running)} (${p.done + 1} of ${p.total})${p.message ? ` · ${esc(p.message)}` : '…'}`);
  else parts.push(`${s.done} of ${s.total} races analysed`);
  if (low) parts.push(`⚠ ${low} with low tracker data (marked, counted less)`);
  if (errs) parts.push(`${errs} couldn't be loaded`);
  return `<p class="regatta-status${p.running ? ' busy' : ''}" role="status">${parts.join(' · ')}</p>`;
}

/** The place row: each race (the menu's name), the boat's place and the fleet. */
export function regattaPlacesHtml(s: RegattaSummary): string {
  const li = s.rows.map((r) => {
    const f = r.digest?.finish ?? null;
    const place = r.status === 'done' ? finishShort(f) : r.status === 'error' ? '!' : '…';
    const of = r.status === 'done' && f ? `<small>of ${f.of}</small>` : '';
    const what = placeWhat(r);
    const warn = r.low ? ' <span class="warn" title="Low tracker coverage: counted less">⚠</span>' : '';
    return `<li class="rp ${r.status}${r.low ? ' low' : ''}" data-race="${r.raceNumber}" title="${esc(`${r.name}: ${what}`)}"><b>${esc(r.label)}</b> <span class="rp-place">${esc(place)}</span>${of}${warn}</li>`;
  });
  return `<ol class="regatta-places" aria-label="Place in each race">${li.join('')}</ol>`;
}

/**
 * One thing to work on as a card: a pattern (found in 2+ races: "Leeward roundings cost you time in 3 of 4
 * races with good data", a chip per race with its seconds) or a one-race finding or leg type; then the tip.
 */
export function patternCardHtml(t: WorkOn): string {
  const secs = t.score >= 1 ? `<li class="chip sec" title="Seconds at stake, weighted by each race's tracker coverage">~${Math.round(t.score)} s</li>` : '';
  const chips = t.chips.map((c) => `<li class="chip">${esc(c)}</li>`).join('');
  return `<article class="card coach-pattern${t.pattern ? ' pattern' : ''}" data-theme="${esc(t.theme)}">
    <h5>${esc(t.title)}</h5>
    ${secs || chips ? `<ul class="chips">${secs}${chips}</ul>` : ''}
    <p class="opp-what">${esc(t.why)}.</p>
    ${t.tip ? `<p class="opp-tip"><b>Tip</b> ${esc(t.tip)}</p>` : ''}
  </article>`;
}

/** A Went well line over the regatta: "Beats: gained on the top 3 in 3 of 5 races (best R2 Beat 1, 45 s)". */
export function regattaWentText(w: WentWell): string {
  const best = `best ${w.best.label} ${w.best.what}, ${Math.round(w.best.seconds)} s`;
  return `${w.title}: gained on the top 3 in ${w.races} of ${w.of} ${w.of === 1 ? 'race' : 'races'} (${best})`;
}

export function regattaHtml(s: RegattaSummary, p: RegattaProgress): string {
  const status = regattaStatusHtml(s, p);
  if (!s.total) return status;
  const places = regattaPlacesHtml(s);
  const top = s.top.length
    ? `<div class="regatta-patterns">${s.top.map(patternCardHtml).join('')}</div>`
    : `<p class="muted">${s.withData ? 'Nothing that recurs yet.' : 'Waiting for the races to be analysed.'}</p>`;
  const went = s.withData ? wentWellHtml(s.went.map((w) => ({ text: regattaWentText(w), seconds: w.totalS })), 'No clear gains on the top 3 yet.') : '';
  const rows = s.findings
    .map(
      (f) =>
        `<tr><th scope="row">${esc(f.label)}</th><td${f.gated ? ' title="Of the races with the data to measure it"' : ''}>${f.races} of ${f.of}${f.gated ? '*' : ''}</td><td>~${Math.round(f.totalS)} s</td><td>~${Math.round(f.weightedS)} s${f.lowRaces ? ' <span class="warn" title="Includes races with low tracker coverage, counted less">⚠</span>' : ''}</td><td class="muted">${esc(f.raceLabels.join(', '))}</td></tr>`,
    )
    .join('');
  const findings = rows
    ? `<div class="regatta-scroll"><table class="regatta-table regatta-findings"><thead><tr><th scope="col">Finding</th><th scope="col">Races</th><th scope="col">At stake</th><th scope="col" title="Seconds weighted by each race's tracker coverage">Weighted</th><th scope="col">Where</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="muted">No findings yet.</p>';
  const legRows = s.legs
    .map((l) => {
      const ex = (e: LegTypeSummary['best']): string => esc(legExtremeText(e));
      return `<tr><th scope="row">${LEG_TYPE[l.kind]}</th><td>${l.legs} ${legWord(l.kind, l.legs)}</td><td>${secs(l.meanS)} per leg</td><td>${ex(l.best)}</td><td>${ex(l.worst)}</td></tr>`;
    })
    .join('');
  const legs = legRows
    ? `<div class="regatta-scroll"><table class="regatta-table regatta-legs"><thead><tr><th scope="col">Legs</th><th scope="col">Sailed</th><th scope="col" title="Leg time vs the fleet's median for the leg (+ = slower)">vs fleet median</th><th scope="col">Best</th><th scope="col">Worst</th></tr></thead><tbody>${legRows}</tbody></table></div>`
    : '';
  const gatedNote = s.findings.some((f) => f.gated) ? '<p class="muted regatta-note">* of the races with the tracker data to measure it (dirty air needs the boats around you; roundings the zone time or the sparse-data place read; heel the roll column).</p>' : '';
  return `${status}${places}
    <h4>Top 3 to work on</h4>${top}
    ${went}
    <h4>Recurring findings</h4>${findings}${gatedNote}
    ${legs ? `<h4>Legs by type</h4>${legs}` : ''}`;
}

/** Sum up and render in one go (the app's call). */
export const regattaViewHtml = (runner: RegattaRunner): string => regattaHtml(summarizeRegatta(runner.races()), runner.progress());
