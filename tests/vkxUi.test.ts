import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { buildRaceData } from '../src/data/racesense/adapter';
import { forgetToken, heldTokens, listUploads, postUpload, rememberToken } from '../src/data/vkx/api';
import { decodePayload } from '../src/data/vkx/compact';
import { coveredRaces, type RaceWindow } from '../src/data/vkx/match';
import { mergeUploads } from '../src/data/vkx/merge';
import { parseVkx } from '../src/data/vkx/parse';
import { payloadFor } from '../src/data/vkx/plan';
import { boatList } from '../src/ui/boats';
import { mapKey } from '../src/ui/captions';
import { barHtml, confirmHtml, eastern, gainText } from '../src/ui/vkxUpload';
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
});

describe('boat-log upload UI', () => {
  it('shows coverage gains as chips, ≈ when estimated', () => {
    expect(gainText(planned())).toBe('R7 23% → 100%');
    expect(gainText(planned({ beforeExact: false, before: 0.124, race: { id: 'o8', label: 'R8', gunMs: 0, endMs: 1, endKnown: true } }))).toBe('R8 ≈12% → 100%');
    expect(eastern(R7_GUN)).toBe('08:05 EDT');
  });

  it('confirm: boat, races, rate, and the public-sharing line', () => {
    const html = confirmHtml([planned(), planned({ race: { id: 'o8', label: 'R8', gunMs: 0, endMs: 1, endKnown: true }, before: 0.124, beforeExact: false })], { sail: RO.sail, name: RO.name }, 10);
    expect(html).toContain('<li class="chip">USA 833 RELATIVE OBSCURITY</li>');
    expect(html).toContain('<li class="chip">R7 23% → 100%</li>');
    expect(html).toContain('<li class="chip">R8 ≈12% → 100%</li>');
    expect(html).toContain('<li class="chip">10 Hz</li>');
    expect(html).toContain('Shared publicly with everyone viewing this race');
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

  it('bar: the button, unavailable state, the log chip, remove, warnings', () => {
    const idle = barHtml({ avail: { kind: 'ok' }, flow: { kind: 'idle' }, logs: [] });
    expect(idle).toContain('data-vkx="add"');
    expect(idle).toContain('Add boat log (.vkx)');
    expect(idle).toContain('Shared publicly');
    const off = barHtml({ avail: { kind: 'off', why: 'Boat-log uploads are not set up on this site (no storage bound)' }, flow: { kind: 'idle' }, logs: [] });
    expect(off).toMatch(/<button type="button" class="vkx-add" disabled[^>]*>.*uploads unavailable<\/button>/);
    expect(off).not.toContain('data-vkx="add"');
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
    expect(busy).toMatch(/class="vkx-add" data-vkx="add" disabled/);
    expect(busy).toContain('role="status">Uploading R7…');
  });

  it('marks the uploaded boat in the boat list and the map key', async () => {
    const log = parseVkx(trimVkx());
    const w: RaceWindow = { id: '7', label: 'R7', gunMs: R7_GUN, endMs: Z('12:07:50'), endKnown: false };
    const [c] = coveredRaces(log.pos.t, [w]);
    const p = await payloadFor(log, c, { event: EVENT, div: DIV }, RO, { sha256: 'b'.repeat(64), bytes: 1 });
    const data = buildRaceData(vkxRegatta(), { division: DIV, raceNumber: 7 }, [vkxFeed()], { eventId: EVENT, kind: 'fixture' });
    const a = analyzeRace(mergeUploads(data, [{ track: await decodePayload(p.bytes) }]), { allCompetitors: true });
    const list = boatList(a, null);
    expect(list).toContain('<span class="log-tag" aria-hidden="true">10 Hz</span>');
    expect(list).toContain('from boat log · 10 Hz');
    expect((list.match(/log-tag/g) ?? []).length).toBe(1);
    const key = mapKey(a, { colour: 'leg' });
    expect(key.chips.map((c) => c.text)).toContain('USA 833 from boat log · 10 Hz');
  });
});

describe('upload API client', () => {
  it('reads the list, and turns any failure into "unavailable" with a reason', async () => {
    const ok = { ok: true, uploads: [{ race: '7', sn: 1, sail: 'X', sha: 'a' }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 })));
    expect(await listUploads(EVENT, DIV, '7')).toMatchObject({ ok: true, uploads: [{ sail: 'X' }] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Boat-log uploads are not set up on this site (no storage bound)' }), { status: 503 })));
    expect(await listUploads(EVENT, DIV, '7')).toEqual({ ok: false, why: 'Boat-log uploads are not set up on this site (no storage bound)' });
    // Dev without functions: the proxy hands back an HTML 404.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Not found</html>', { status: 404 })));
    expect(await listUploads(EVENT, DIV, '7')).toMatchObject({ ok: false, why: expect.stringMatching(/no upload service/) });
    // A 200 that isn't our JSON (an SPA fallback page).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200 })));
    expect((await listUploads(EVENT, DIV, '7')).ok).toBe(false);
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
