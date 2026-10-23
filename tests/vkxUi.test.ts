import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildRaceData } from '../src/data/racesense/adapter';
import { decodePayload } from '../src/data/vkx/compact';
import { coveredRaces, type RaceWindow } from '../src/data/vkx/match';
import { mergeUploads } from '../src/data/vkx/merge';
import { parseVkx } from '../src/data/vkx/parse';
import { payloadFor } from '../src/data/vkx/plan';
import { boatList } from '../src/ui/boats';
import { mapKey } from '../src/ui/captions';
import { forgetToken, heldTokens, listUploads, postUpload, rememberToken, resetVkxSession } from '../src/data/vkx/api';
import { VKX_CTA_HEAD, VKX_CTA_LINE, barHtml, confirmHtml, eastern, gainText, prettyBoatName } from '../src/ui/vkxUpload';
import { esc } from '../src/ui/format';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PlannedRace } from '../src/vkxWorker';
import { DIV, EVENT, R7_GUN, RO, Z, trimVkx, vkxFeed, vkxRegatta } from './vkxHelpers';

const planned = (over: Partial<PlannedRace> = {}): PlannedRace => ({
  race: { id: '7', label: 'R7', gunMs: R7_GUN, endMs: Z('13:32:30'), endKnown: false },
  frac: 1,
  fromMs: 0,
  toMs: 1,
  verdict: 'match',
  boat: { sn: RO.sn, sail: RO.sail, n: 35, medianM: 0.1 },
  candidates: [],
  reason: null,
  before: 0.231,
  beforeExact: true,
  after: 1,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetVkxSession();
});

describe('boat-log upload UI', () => {
  it('shows coverage gains as chips, ≈ when estimated', () => {
    expect(gainText(planned())).toBe('R7 · tracker 23% → 100%');
    expect(gainText(planned({ beforeExact: false, before: 0.124, race: { id: 'o8', label: 'R8', gunMs: 0, endMs: 1, endKnown: true } }))).toBe('R8 · tracker ≈12% → 100%');
    expect(eastern(R7_GUN)).toBe('08:05 EDT');
    expect(prettyBoatName('RELATIVE OBSCURITY')).toBe('Relative Obscurity');
    expect(prettyBoatName('Relative Obscurity')).toBe('Relative Obscurity');
  });

  it('confirm: labelled file, boat, races, rate, and the public-sharing line', () => {
    const html = confirmHtml(
      [planned(), planned({ race: { id: 'o8', label: 'R8', gunMs: 0, endMs: 1, endKnown: true }, before: 0.124, beforeExact: false })],
      { sail: RO.sail, name: RO.name },
      10,
      [],
      [],
      'ro-usa833.vkx',
    );
    expect(html).toContain('<span class="vkx-k">File</span> ro-usa833.vkx');
    expect(html).toContain('<span class="vkx-k">Boat</span> USA 833 Relative Obscurity');
    expect(html).toContain('<span class="vkx-k">Race</span> R7 · tracker 23% → 100%');
    expect(html).toContain('<span class="vkx-k">Race</span> R8 · tracker ≈12% → 100%');
    expect(html).toContain('<span class="vkx-k">Rate</span> 10 Hz');
    expect(html).toContain('Shared publicly with everyone viewing this race.');
    expect(html).not.toContain('<strong>Shared publicly');
    expect(html).toMatch(/value="cancel"[^>]*>Cancel/);
    expect(html).toMatch(/value="ok"[^>]*>Upload/);
    expect(html).not.toContain('<select');
    // Sparse with two agreeing boats: the user picks.
    const pick = confirmHtml([planned()], { sail: RO.sail, name: '' }, 10, [{ text: 'matched on 8 feed fixes', warn: true }], [
      { sn: 1, sail: 'USA 833' },
      { sn: 2, sail: 'USA 834' },
    ]);
    expect(pick).toContain('select data-vkx="boat"');
    expect(pick).toContain('class="chip warn"');
  });

  it('bar: the button, muted unavailable chip, the log chip, remove, warnings', () => {
    const idle = barHtml({ avail: { kind: 'ok' }, flow: { kind: 'idle' }, logs: [] });
    expect(idle).toContain('data-vkx="add"');
    expect(idle).toContain('Add boat log (.vkx)');
    expect(idle).toContain('Shared publicly');
    const off = barHtml({ avail: { kind: 'off', why: 'Boat-log uploads are not set up on this site (no storage bound)' }, flow: { kind: 'idle' }, logs: [] });
    expect(off).toContain('class="chip muted"');
    expect(off).toContain('uploads unavailable');
    expect(off).not.toContain('vkx-add');
    expect(off).not.toContain('data-vkx="add"');
    expect(off).not.toContain('⚠');
    expect(off).toContain('Uploads are unavailable: Boat-log uploads are not set up');
    const withLog = barHtml({
      avail: { kind: 'ok' },
      flow: { kind: 'idle' },
      logs: [{ sail: RO.sail, rateHz: 10, removable: true, sn: RO.sn, warnings: [{ text: 'boat timer Δ +5s', why: 'Because.' }] }],
    });
    expect(withLog).toContain('<li class="chip">USA 833 · from boat log · 10 Hz</li>');
    expect(withLog).toContain('data-vkx="remove"');
    expect(withLog).toContain('⚠ </span><span class="vh">Warning: </span>boat timer Δ +5s');
    expect(withLog).toContain('<li>Because.</li>');
    const busy = barHtml({ avail: { kind: 'ok' }, flow: { kind: 'busy', text: 'Uploading R7…' }, logs: [] });
    expect(busy).toMatch(/class="vkx-add vkx-cta-btn" data-vkx="add" disabled/);
    expect(busy).toContain('role="status">Uploading R7…');
  });

  it('bar: a call-to-action card with no log in the race; the chip line once one is attached; none when unavailable', () => {
    for (const avail of [{ kind: 'ok' }, { kind: 'checking' }] as const) {
      const none = barHtml({ avail, flow: { kind: 'idle' }, logs: [] });
      expect(none).toContain('<div class="vkx-cta" role="group" aria-labelledby="vkx-cta-h">');
      expect(none).toContain(`id="vkx-cta-h">${esc(VKX_CTA_HEAD)}</p>`);
      expect(none).toContain(`<p class="vkx-cta-line">${esc(VKX_CTA_LINE)}</p>`);
      expect(none.match(/data-vkx="add"/g)).toHaveLength(1);
      // Still checking the upload service: shown, but its button waits.
      expect(/vkx-cta-btn" data-vkx="add" disabled/.test(none)).toBe(avail.kind === 'checking');
    }
    expect(VKX_CTA_HEAD).toBe('Sailed with a Vakaros? Add its log (.vkx)');
    expect(VKX_CTA_LINE).toContain('10 fixes a second');
    const attached = barHtml({ avail: { kind: 'ok' }, flow: { kind: 'idle' }, logs: [{ sail: RO.sail, rateHz: 10, removable: false, sn: RO.sn, warnings: [] }] });
    expect(attached).not.toContain('vkx-cta');
    expect(attached).not.toContain(esc(VKX_CTA_LINE));
    expect(attached).toContain('<li><button type="button" class="vkx-add" data-vkx="add">Add boat log (.vkx)</button></li>');
    expect(attached).toContain('<li class="chip">USA 833 · from boat log · 10 Hz</li>');
    for (const logs of [[], [{ sail: RO.sail, rateHz: 10, removable: false, sn: RO.sn, warnings: [] }]]) {
      const off = barHtml({ avail: { kind: 'off', why: 'offline' }, flow: { kind: 'idle' }, logs });
      expect(off).not.toContain('vkx-cta');
      expect(off).not.toContain('data-vkx="add"');
      expect(off).toContain('uploads unavailable');
    }
    // It sits in #digest, so a locked race (the paywall hides #digest for its lock card) shows none of it.
    const app = readFileSync(fileURLToPath(new URL('../src/ui/app.ts', import.meta.url)), 'utf8');
    expect(app).toContain('vkx.mount(els.raceHead, a);');
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    const digest = html.slice(html.indexOf('<main id="digest"'), html.indexOf('</main>', html.indexOf('<main id="digest"')));
    expect(digest).toContain('<div id="race-head" class="race-head" hidden></div>');
  });

  it('marks the uploaded boat in the boat list and the map key', async () => {
    const log = parseVkx(trimVkx());
    const w: RaceWindow = { id: '7', label: 'R7', gunMs: R7_GUN, endMs: Z('12:07:50'), endKnown: false };
    const [c] = coveredRaces(log.pos.t, [w]);
    const p = await payloadFor(log, c, { event: EVENT, div: DIV }, RO, { sha256: 'b'.repeat(64), bytes: 1 });
    const data = buildRaceData(vkxRegatta(), { division: DIV, raceNumber: 7 }, [vkxFeed()], { eventId: EVENT, kind: 'fixture' });
    const a = analyzeRace(mergeUploads(data, [{ track: await decodePayload(p.bytes) }]), { allCompetitors: true });
    const list = boatList(a, null);
    expect(list).toContain('class="log-hz"');
    expect(list).toContain('from boat log · 10 Hz');
    expect(list).toMatch(/<span class="log-hz"[^>]*>10<\/span>/);
    expect(list).not.toContain('log-tag');
    expect(list.match(/class="log-hz"/g)).toHaveLength(1);
    const key = mapKey(a, { colour: 'leg' });
    expect(key.chips.map((c) => c.text)).toContain('USA 833 from boat log · 10 Hz');
  });
});

describe('upload API client', () => {
  it('reads the list, and turns any failure into "unavailable" with a reason', async () => {
    const ok = { ok: true, uploads: [{ race: '7', sn: 1, sail: 'X', sha: 'a' }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 })));
    expect(await listUploads(EVENT, DIV, '7')).toMatchObject({ ok: true, uploads: [{ sail: 'X' }] });
    const fetch503 = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Boat-log uploads are not set up on this site (no storage bound)', code: 'no-storage' }), { status: 503 }));
    vi.stubGlobal('fetch', fetch503);
    expect(await listUploads(EVENT, DIV, '7')).toEqual({ ok: false, why: 'Boat-log uploads are not set up on this site (no storage bound)' });
    expect(await listUploads(EVENT, DIV, '8')).toEqual({ ok: false, why: 'Boat-log uploads are not set up on this site (no storage bound)' });
    expect(fetch503).toHaveBeenCalledTimes(1);
    resetVkxSession();
    // Dev without functions: the proxy hands back an HTML 404.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Not found</html>', { status: 404 })));
    expect(await listUploads(EVENT, DIV, '7')).toMatchObject({ ok: false, why: expect.stringMatching(/no upload service/) });
    // A 200 that isn't our JSON (an SPA fallback page).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200 })));
    expect((await listUploads(EVENT, DIV, '7')).ok).toBe(false);
    resetVkxSession();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await listUploads(EVENT, DIV, '7')).toEqual({ ok: false, why: "Couldn't reach the upload service" });
    vi.stubGlobal('navigator', { onLine: false });
    expect(await listUploads(EVENT, DIV, '7')).toEqual({ ok: false, why: "You're offline" });
  });

  it("posts the payload and surfaces the server's reason", async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
      return new Response(JSON.stringify({ ok: false, error: "This log doesn't follow USA 833's public track", code: 'mismatch' }), { status: 422 });
    });
    vi.stubGlobal('fetch', f);
    await expect(postUpload(new Uint8Array([1]))).rejects.toMatchObject({ status: 422, code: 'mismatch', message: expect.stringMatching(/doesn't follow/) });
  });

  it('keeps delete tokens per upload slot in localStorage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const k = { event: EVENT, div: DIV, race: '7', sn: RO.sn };
    expect(heldTokens(k)).toEqual([]);
    rememberToken(k, { token: 't1', sha: 's1', at: 1 });
    rememberToken(k, { token: 't2', sha: 's2', at: 2 });
    expect(heldTokens(k).map((t) => t.token)).toEqual(['t2', 't1']);
    forgetToken(k, 't2');
    expect(heldTokens(k).map((t) => t.token)).toEqual(['t1']);
    expect(heldTokens({ ...k, race: '8' })).toEqual([]);
  });
});
