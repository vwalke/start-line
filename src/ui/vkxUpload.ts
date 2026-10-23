/**
 * "Add boat log (.vkx)": a boat's own Vakaros log replaces its gappy public
 * track in a race. Under the race header (every tab), while no boat in the race has a log, a card
 * with VKX_CTA_HEAD, VKX_CTA_LINE and the button; once one has, one short line of chips:
 *
 *   [Add boat log (.vkx)]  USA 833 · from boat log · 10 Hz  remove my upload  ⚠ boat timer Δ +5s  ⓘ
 *
 * Flow: pick a file → parse, match and pack in a worker (src/vkxWorker.ts) →
 * confirm (boat, races, coverage gain, rate, "Shared publicly…") → upload
 * per race → the race re-runs with the log merged in. Uploads are PUBLIC.
 *
 * On each race load the race's upload list is fetched (never blocking the
 * first render); new uploads are fetched and the race re-analysed with them
 * (app.ts passes `buffersFor()` with every race request). With no upload
 * service (no R2 binding, dev without functions, offline) the button reads
 * "⚠ uploads unavailable", disabled, and the ⓘ says why.
 */
import type { RaceAnalysis } from '../analysis/types';
import { currentDoc, listRaces } from '../data/racesense/adapter';
import type { RegattaResponse } from '../data/racesense/types';
import {
  UploadError,
  deleteUpload,
  fetchUpload,
  forgetToken,
  heldTokens,
  listUploads,
  postUpload,
  rememberToken,
  type UploadItem,
  type UploadKey,
} from '../data/vkx/api';
import { raceWindowsFromDoc, type RaceWindow } from '../data/vkx/match';
import { logWarnings } from '../data/vkx/merge';
import type { PlannedRace, VkxWorkerRequest, VkxWorkerResponse } from '../vkxWorker';
import { esc } from './format';
import { infoHtml, type Chip } from './info';

export interface VkxRace {
  eventId: string;
  division: string;
  raceNumber: number;
  regatta: RegattaResponse;
  analysis: RaceAnalysis;
}

export interface VkxHost {
  /** Re-run the race on screen (app.ts loadRace with the current view): new uploads to merge. */
  reload(): void;
  /** Current race windows (including recovery orphans), so one file can cover official R7 and R8. */
  windows?(division: string): RaceWindow[];
}

type Avail = { kind: 'checking' } | { kind: 'ok' } | { kind: 'off'; why: string };
/** Chips + ⓘ bullets for the flow's latest state. */
type Flow = { kind: 'idle' } | { kind: 'busy'; text: string } | { kind: 'shown'; chips: Chip[]; bullets: string[] };

const raceKey = (event: string, div: string, race: string): string => `${event}|${div}|${race}`;

/** Eastern clock time, as Vann reads the app ("08:05:00 EDT"). */
export function eastern(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(ms);
}

const pctText = (x: number | null): string => (x == null ? '?' : `${Math.round(x * 100)}%`);

/** "R7 · tracker 23% → 100%" (≈ when the before is estimated from the check windows). */
export function gainText(r: Pick<PlannedRace, 'race' | 'before' | 'beforeExact' | 'after'>): string {
  return `${r.race.label} · tracker ${r.beforeExact || r.before == null ? '' : '≈'}${pctText(r.before)} → ${pctText(r.after)}`;
}

/** Title-case an ALL-CAPS boat name ("RELATIVE OBSCURITY" → "Relative Obscurity"). */
export function prettyBoatName(name: string): string {
  const n = name.trim();
  if (!n) return '';
  if (n !== n.toUpperCase()) return n;
  return n.toLowerCase().replace(/(^|[\s\-_/'])\p{L}/gu, (s) => s.toUpperCase());
}

function chipLi(c: Chip): string {
  const warn = c.warn ? '<span aria-hidden="true">⚠ </span><span class="vh">Warning: </span>' : '';
  return `<li class="chip${c.warn ? ' warn' : ''}"${c.title ? ` title="${esc(c.title)}"` : ''}>${warn}${esc(c.text)}</li>`;
}

function labelledChip(label: string, text: string): string {
  return `<li class="chip"><span class="vkx-k">${esc(label)}</span> ${esc(text)}</li>`;
}

/** The confirm dialog's body (pure: tested). */
export function confirmHtml(
  races: PlannedRace[],
  boat: { sail: string; name: string },
  rateHz: number,
  extra: Chip[] = [],
  pick: { sn: number; sail: string }[] = [],
  fileName = '',
): string {
  const boatText = `${boat.sail}${boat.name ? ` ${prettyBoatName(boat.name)}` : ''}`;
  const chips = [
    ...(fileName ? [labelledChip('File', fileName)] : []),
    labelledChip('Boat', boatText),
    ...races.map((r) => labelledChip('Race', gainText(r))),
    labelledChip('Rate', `${rateHz} Hz`),
    ...extra.map(chipLi),
  ];
  const select = pick.length > 1
    ? `<label class="vkx-pick">Which boat? <select data-vkx="boat">${pick.map((b) => `<option value="${b.sn}">${esc(b.sail)}</option>`).join('')}</select></label>`
    : '';
  return `<form method="dialog" class="vkx-form">
    <h3 class="vkx-title" id="vkx-title">Add boat log</h3>
    <ul class="chips">${chips.join('')}</ul>
    ${select}
    <p class="vkx-public">Shared publicly with everyone viewing this race.</p>
    <div class="vkx-actions"><button type="submit" value="cancel" class="vkx-cancel">Cancel</button><button type="submit" value="ok" class="vkx-ok">Upload</button></div>
  </form>`;
}

/**
 * The call to action while no boat in the race has a log (merge.ts: the log's 10 Hz fixes replace the
 * feed's ~0.2–1 Hz ones; the Coach reads roundings and penalty turns from them at full rate, the start at 5 Hz).
 */
export const VKX_CTA_HEAD = 'Sailed with a Vakaros? Add its log (.vkx)';
export const VKX_CTA_LINE = "10 fixes a second instead of the tracker's 1 or fewer: it fills your boat's gaps and sharpens the Coach's read of your start, mark roundings and penalty turns.";

/** The bar's markup (pure: tested). With no log in the race, a card that says why; with one, the chip line only. */
export function barHtml(o: {
  avail: Avail;
  flow: Flow;
  logs: { sail: string; rateHz: number; warnings: { text: string; why: string }[]; removable: boolean; sn: number }[];
  open?: boolean;
}): string {
  const items: string[] = [];
  let cta = '';
  if (o.avail.kind === 'off') {
    items.push(`<li class="chip muted" title="${esc(o.avail.why)}">uploads unavailable</li>`);
  } else {
    const busy = o.flow.kind === 'busy' || o.avail.kind === 'checking';
    const add = (cls: string): string => `<button type="button" class="${cls}" data-vkx="add"${busy ? ' disabled' : ''}>Add boat log (.vkx)</button>`;
    if (o.logs.length) items.push(`<li>${add('vkx-add')}</li>`);
    else {
      cta = `<div class="vkx-cta" role="group" aria-labelledby="vkx-cta-h"><div class="vkx-cta-text"><p class="vkx-cta-h" id="vkx-cta-h">${esc(VKX_CTA_HEAD)}</p><p class="vkx-cta-line">${esc(VKX_CTA_LINE)}</p></div>${add('vkx-add vkx-cta-btn')}</div>`;
    }
  }
  const bullets = [
    "Add your boat's own Vakaros log (.vkx, from Vakaros Connect) to replace its gappy public track with the full-rate one.",
    'Shared publicly: everyone viewing this race sees the uploaded track.',
    "The log is matched to its boat by following that boat's public track (median within 5 m), checked here and again on the server; a log that follows no boat is refused.",
    'Analyzed at 5 Hz around the start and 1 Hz elsewhere, so one dense log never outweighs the fleet; kept at the full rate.',
  ];
  for (const l of o.logs) {
    items.push(chipLi({ text: `${l.sail} · from boat log · ${l.rateHz} Hz` }));
    if (l.removable) items.push(`<li><button type="button" class="linkish vkx-remove" data-vkx="remove" data-sn="${l.sn}">remove my upload</button></li>`);
    for (const w of l.warnings) {
      items.push(chipLi({ text: w.text, warn: true }));
      bullets.push(w.why);
    }
  }
  if (o.flow.kind === 'busy') items.push(`<li class="chip vkx-busy" role="status">${esc(o.flow.text)}</li>`);
  if (o.flow.kind === 'shown') {
    items.push(...o.flow.chips.map(chipLi));
    bullets.push(...o.flow.bullets);
  }
  if (o.avail.kind === 'off') bullets.push(`Uploads are unavailable: ${o.avail.why}. Everything else works as usual.`);
  items.push(`<li class="chip-info">${infoHtml(bullets, { open: o.open })}</li>`);
  return `${cta}<ul class="chips vkx-chips" aria-label="Boat logs">${items.join('')}</ul>`;
}

export function createVkxUpload(host: VkxHost) {
  const el = document.createElement('div');
  el.className = 'vkx-bar';
  const input = document.createElement('input');
  input.type = 'file';
  // No `accept`: iOS greys out files of a type it doesn't know (.vkx); the parser checks the content.
  input.hidden = true;
  input.className = 'vkx-file';
  const dialog = document.createElement('dialog');
  dialog.className = 'vkx-dialog';
  dialog.setAttribute('aria-labelledby', 'vkx-title');
  document.body.append(input, dialog);

  let race: VkxRace | null = null;
  let avail: Avail = { kind: 'checking' };
  let flow: Flow = { kind: 'idle' };
  let uploads: UploadItem[] = [];
  /** Payloads fetched per race key (by sha), handed to every analysis of that race. */
  const loaded = new Map<string, Map<string, { bytes: ArrayBuffer; uploadedAt: number }>>();
  let listGen = 0;

  // ---- worker
  let worker: Worker | null = null;
  let wid = 0;
  const waiting = new Map<number, { resolve: (m: VkxWorkerResponse) => void; reject: (e: Error & { code?: string }) => void }>();
  const call = (req: VkxWorkerRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never, transfer: Transferable[] = []): Promise<VkxWorkerResponse> => {
    worker ??= (() => {
      const w = new Worker(new URL('../vkxWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<VkxWorkerResponse>) => {
        const m = ev.data;
        if (m.type === 'progress') return setFlow({ kind: 'busy', text: m.message });
        const p = waiting.get(m.id);
        waiting.delete(m.id);
        if (!p) return;
        if (m.type === 'error') p.reject(Object.assign(new Error(m.message), { code: m.code }));
        else p.resolve(m);
      };
      // A crashed worker (e.g. out of memory on a huge file): fail what's pending and start afresh next time.
      w.onerror = (ev) => {
        ev.preventDefault();
        for (const p of waiting.values()) p.reject(new Error('The log reader stopped (file too large for this device?)'));
        waiting.clear();
        w.terminate();
        worker = null;
      };
      return w;
    })();
    const id = ++wid;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker!.postMessage({ ...req, id } as VkxWorkerRequest, transfer);
    });
  };

  const keyOf = (r: VkxRace): string => raceKey(r.eventId, r.division, String(r.raceNumber));
  const uploadKey = (r: VkxRace, sn: number, raceId = String(r.raceNumber)): UploadKey => ({ event: r.eventId, div: r.division, race: raceId, sn });
  /** Still showing race `r` (the same race, whatever analysis object it carries now)? */
  const stillOn = (r: VkxRace): boolean => !!race && keyOf(race) === keyOf(r);
  /** This browser's token for exactly the upload listed (not an older one since replaced, now `.prev`). */
  const tokenFor = (r: VkxRace, item: UploadItem): string | undefined => heldTokens(uploadKey(r, item.sn)).find((t) => t.sha === item.sha)?.token;

  function setFlow(f: Flow): void {
    flow = f;
    paint();
  }

  function paint(): void {
    const a = race?.analysis;
    const logs = (a?.boats ?? [])
      .filter((b) => b.log)
      .map((b) => {
        const item = uploads.find((u) => u.sail === b.sail);
        const removable = !!race && !!item && !!tokenFor(race, item);
        return { sail: b.sail, rateHz: b.log!.rateHz, warnings: logWarnings(b.log!), removable, sn: item?.sn ?? 0 };
      });
    el.innerHTML = barHtml({ avail, flow, logs, open: !!el.querySelector('details.info[open]') });
  }

  /** The payloads already fetched for a race (app.ts passes them with every analysis request). */
  function buffersFor(eventId: string, division: string, raceNumber: number): { bytes: ArrayBuffer; uploadedAt: number }[] {
    return [...(loaded.get(raceKey(eventId, division, String(raceNumber)))?.values() ?? [])];
  }

  /** Fetch the race's list; fetch new payloads; re-run the race when its set of uploads changed. */
  async function refresh(fresh = false): Promise<void> {
    const r = race;
    if (!r) return;
    const gen = ++listGen;
    const res = await listUploads(r.eventId, r.division, String(r.raceNumber), { fresh });
    if (gen !== listGen || !stillOn(r)) return;
    if (!res.ok) {
      avail = { kind: 'off', why: res.why };
      uploads = [];
      return paint();
    }
    avail = { kind: 'ok' };
    uploads = res.uploads;
    const key = keyOf(r);
    const have = loaded.get(key) ?? new Map<string, { bytes: ArrayBuffer; uploadedAt: number }>();
    const next = new Map<string, { bytes: ArrayBuffer; uploadedAt: number }>();
    for (const u of uploads) {
      const got = have.get(u.sha);
      if (got) {
        next.set(u.sha, got);
        continue;
      }
      try {
        next.set(u.sha, { bytes: await fetchUpload(u), uploadedAt: u.uploadedAt });
      } catch {
        /* the boat shows its feed track; the list says it's there */
      }
      if (gen !== listGen || !stillOn(r)) return;
    }
    const changed = next.size !== have.size || [...next.keys()].some((k) => !have.has(k));
    loaded.set(key, next);
    paint();
    if (changed) host.reload();
  }

  /** After each race load (and re-run): note the race, and check its uploads once per load of a new race. */
  function raceShown(r: VkxRace): void {
    const same = race && keyOf(race) === keyOf(r);
    race = r;
    if (!same) {
      uploads = [];
      if (flow.kind !== 'busy') flow = { kind: 'idle' };
      // Already know uploads aren't set up: don't 503 the console on every race.
      if (avail.kind === 'off') {
        paint();
        return;
      }
      avail = { kind: 'checking' };
      void refresh();
    }
    paint();
  }

  /** Sit the bar just after `after` (the recovery chips in `#race-head`). */
  function mount(after: HTMLElement, a: RaceAnalysis): void {
    const m = a.meta;
    if (race && race.analysis !== a && m.eventId === race.eventId && m.raceNumber === race.raceNumber && m.division === race.division) race = { ...race, analysis: a };
    if (el.previousElementSibling !== after || el.parentElement !== after.parentElement) after.after(el);
    paint();
  }

  // ---- the upload flow

  const fail = (text: string, why: string): void => setFlow({ kind: 'shown', chips: [{ text, warn: true }], bullets: [why] });

  async function onFile(file: File): Promise<void> {
    const r = race;
    if (!r) return;
    if (file.size > 200_000_000) return fail('File too large', `"${file.name}" is ${(file.size / 1e6).toFixed(0)} MB; a day's .vkx log is ~10 MB.`);
    setFlow({ kind: 'busy', text: 'Reading log…' });
    let parsed: Extract<VkxWorkerResponse, { type: 'parsed' }>;
    try {
      const buf = await file.arrayBuffer();
      parsed = (await call({ type: 'parse', file: buf }, [buf])) as typeof parsed;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'not-vkx') return fail('Not a .vkx boat log', `"${file.name}" doesn't look like a Vakaros .vkx log (${(e as Error).message}).`);
      if (code === 'empty') return fail('No positions in this log', `"${file.name}" has no position rows: ${(e as Error).message}.`);
      return fail("Couldn't read the log", (e as Error).message);
    }
    const s = parsed.summary;
    const doc = currentDoc(r.regatta);
    const fromList = host.windows?.(r.division) ?? [];
    const windows: RaceWindow[] = fromList.length ? fromList : raceWindowsFromDoc(doc, r.division);
    const listed = new Set(listRaces(doc).filter((x) => x.division === r.division && x.finishers > 0).map((x) => String(x.raceNumber)));
    const finished = Object.fromEntries(listRaces(doc).filter((x) => x.division === r.division).map((x) => [String(x.raceNumber), x.finished]));
    const known: Record<string, Record<string, number | null>> = {
      [String(r.raceNumber)]: Object.fromEntries(r.analysis.boats.map((b) => [b.sail, b.coverage])),
    };
    let plan: PlannedRace[];
    try {
      setFlow({ kind: 'busy', text: 'Checking against the public tracks…' });
      plan = ((await call({ type: 'plan', eventId: r.eventId, division: r.division, races: windows, known, finished })) as Extract<VkxWorkerResponse, { type: 'planned' }>).races;
    } catch (e) {
      return fail("Couldn't check the log", `The public feed couldn't be read to match the log to a boat (${(e as Error).message}). Try again.`);
    }
    const span = `${eastern(s.t0)}–${eastern(s.t1)}`;
    if (!plan.length) {
      return fail('Covers none of these races', `The log runs ${span}; none of the ${r.division} races with a gun has at least half its gun-to-finish inside it.`);
    }
    const ok = plan.filter((p) => p.verdict !== 'none');
    if (!ok.length) return fail('No boat matches this log', `${plan[0].reason ?? 'No boat agrees'}. A log must follow its boat's public track.`);
    // One boat for the file: the one most races agree on.
    const votes = new Map<number, number>();
    for (const p of ok) votes.set(p.boat!.sn, (votes.get(p.boat!.sn) ?? 0) + 1);
    const sn = [...votes].sort((a, b) => b[1] - a[1])[0][0];
    const races = ok.filter((p) => p.boat!.sn === sn);
    const boatSail = races[0].boat!.sail;
    const name = doc.divisions.find((d) => d.name === r.division)?.participants?.find((p) => p.sailNumber === boatSail)?.boatName?.trim() ?? '';
    const extra: Chip[] = [];
    const bullets: string[] = [`The log runs ${span}, ${s.rateHz} Hz.`];
    for (const p of plan.filter((x) => !races.includes(x))) extra.push({ text: `${p.race.label}: no matching boat`, warn: true, title: p.reason ?? undefined });
    const sparse = races.filter((p) => p.verdict === 'sparse');
    if (sparse.length) extra.push({ text: `matched on ${Math.min(...sparse.map((p) => p.boat!.n))} feed fixes`, warn: true, title: 'The public feed has few fixes of this boat here; confirm it is yours.' });
    if (s.stop) extra.push({ text: 'log cut short', warn: true, title: s.stop });
    for (const p of races.filter((x) => !listed.has(x.race.id))) bullets.push(`${p.race.label} isn't in Recall's race list yet (no finishes in the feed); the log is kept for it.`);
    const candidates = sparse.length ? sparse[0].candidates : [];
    dialog.innerHTML = confirmHtml(races, { sail: boatSail, name }, s.rateHz, extra, candidates, file.name);
    setFlow({ kind: 'busy', text: 'Waiting for your OK…' });
    const answer = await new Promise<string>((resolve) => {
      // Esc / cancel leave returnValue as it was: clear it so only this dialog's Upload counts as consent.
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>('.vkx-ok')?.focus();
    });
    if (answer !== 'ok') return setFlow({ kind: 'idle' });
    const pickedSn = Number(dialog.querySelector<HTMLSelectElement>('select[data-vkx="boat"]')?.value ?? sn);
    const pickedSail = candidates.find((c) => c.sn === pickedSn)?.sail ?? boatSail;
    await upload(r, races, { sn: pickedSn, sail: pickedSail, name }, bullets);
  }

  async function upload(r: VkxRace, races: PlannedRace[], boat: { sn: number; sail: string; name: string }, bullets: string[]): Promise<void> {
    let packed: Extract<VkxWorkerResponse, { type: 'encoded' }>;
    try {
      packed = (await call({ type: 'encode', eventId: r.eventId, division: r.division, picks: races.map((p) => ({ raceId: p.race.id, sn: boat.sn, sail: boat.sail, name: boat.name })) })) as typeof packed;
    } catch (e) {
      return fail("Couldn't pack the log", (e as Error).message);
    }
    const chips: Chip[] = [];
    let mine = false;
    for (const p of packed.payloads) {
      const label = races.find((x) => x.race.id === p.raceId)!.race.label;
      setFlow({ kind: 'busy', text: `Uploading ${label}…` });
      const k = uploadKey(r, boat.sn, p.raceId);
      try {
        // Replace our own upload only if it's still the one stored (its token matches the listed sha).
        const listed = p.raceId === String(r.raceNumber) ? uploads.find((u) => u.sn === boat.sn) : undefined;
        const own = listed ? tokenFor(r, listed) : heldTokens(k)[0]?.token;
        const res = await postUpload(new Uint8Array(p.bytes), own);
        rememberToken(k, { token: res.token, sha: res.sha, at: res.uploadedAt });
        chips.push({ text: `${label} uploaded ✓` });
        if (p.raceId === String(r.raceNumber)) mine = true;
      } catch (e) {
        const err = e as UploadError;
        const short = err.status === 503 ? 'try again later' : err.status === 422 ? 'refused' : err.status === 429 ? 'too many uploads' : 'failed';
        chips.push({ text: `${label} ${short}`, warn: true });
        bullets.push(`${label}: ${err.message}.`);
        if (err.status === 503 && err.code === 'no-storage') avail = { kind: 'off', why: err.message };
      }
    }
    setFlow({ kind: 'shown', chips, bullets });
    if (mine && stillOn(r)) await refresh(true);
  }

  async function remove(sn: number): Promise<void> {
    const r = race;
    if (!r) return;
    const k = uploadKey(r, sn);
    const item = uploads.find((u) => u.sn === sn);
    const token = item && tokenFor(r, item);
    if (!token) return fail("Couldn't remove it", 'This browser holds no token for the upload shown (someone may have replaced it).');
    setFlow({ kind: 'busy', text: 'Removing…' });
    let done: { restored: boolean };
    try {
      done = await deleteUpload(k, token);
      forgetToken(k, token);
    } catch (e) {
      if ((e as UploadError).status === 404) forgetToken(k, token);
      return fail("Couldn't remove it", (e as Error).message);
    }
    setFlow({ kind: 'shown', chips: [{ text: done.restored ? 'removed; the earlier upload is back' : 'removed' }], bullets: [] });
    await refresh(true);
  }

  el.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-vkx]');
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    if (btn.dataset.vkx === 'add') {
      input.value = '';
      input.click();
    } else if (btn.dataset.vkx === 'remove') void remove(Number(btn.dataset.sn));
  });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void onFile(f).catch((e: unknown) => fail('Something went wrong', e instanceof Error ? e.message : String(e)));
  });

  return { el, mount, raceShown, buffersFor };
}
