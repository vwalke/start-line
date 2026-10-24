import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAYWALL_OFF, parseMe, revokeDevice, revokeOtherDevices, sendRestoreLink, sendSignInLink, type DeviceView, type Me } from '../src/data/paywall';
import { bumpedNote, createBumpNote, devicesHtml, sheetHtml, shortDate, signedOutNote, type NoteStore } from '../src/ui/paywall';
import { TURNSTILE_SRC, createTurnstile, type TurnstileApi, type TurnstileRenderOptions } from '../src/ui/turnstile';
import { NOW } from './paywallHelpers';

const DAY = 86_400_000;
const title = (id: string): string => id;
const OCT20 = Date.parse('2026-10-20T12:00:00Z');
const OCT18 = Date.parse('2026-10-18T12:00:00Z');

const device = (over: Partial<DeviceView> = {}): DeviceView => ({ id: 'a'.repeat(24), label: 'Safari on iPhone', method: 'email', createdAt: NOW - DAY, lastSeenAt: NOW, current: true, ...over });
const signedIn = (over: Partial<Extract<Me, { paywall: true }>> = {}): Me => ({
  paywall: true,
  user: { email: 'a@example.com' },
  entitlements: [],
  signIn: { email: true, google: true, turnstileSiteKey: null },
  devices: { max: 3, list: [device(), device({ id: 'b'.repeat(24), label: 'Chrome on Mac', method: 'google', lastSeenAt: OCT20, current: false })] },
  ...over,
});
/** No dashes or exclamation marks in what the sailor reads. */
const plain = (html: string): string => html.replace(/<[^>]*>/g, ' ');

describe('/api/auth/me on the page: the new fields', () => {
  it('reads devices, bumped, the sign-out reason and the Turnstile site key; drops anything malformed', () => {
    const body = {
      paywall: true,
      user: { email: 'a@example.com' },
      entitlements: [],
      signIn: { email: true, google: false, turnstileSiteKey: '0x4AAAAtest' },
      devices: { max: 3, list: [device(), { id: 5 }, 'junk', device({ id: 'c'.repeat(24), current: false, method: 'weird' as never })] },
      bumped: [{ label: 'Safari on iPhone', lastSeenAt: OCT20 }, { label: 3 }],
    };
    expect(parseMe(body)).toEqual({
      paywall: true,
      user: { email: 'a@example.com' },
      entitlements: [],
      signIn: { email: true, google: false, turnstileSiteKey: '0x4AAAAtest' },
      devices: { max: 3, list: [device(), device({ id: 'c'.repeat(24), current: false, method: null })] },
      bumped: [{ label: 'Safari on iPhone', lastSeenAt: OCT20 }],
    });
    expect(parseMe({ paywall: true, user: null, signIn: { email: true, turnstileSiteKey: '' }, signedOutReason: 'device_limit' })).toEqual({
      paywall: true,
      user: null,
      entitlements: [],
      signIn: { email: true, google: false, turnstileSiteKey: null },
      signedOutReason: 'device_limit',
    });
    expect(parseMe({ paywall: true, user: null, signedOutReason: 'hacked' })).not.toHaveProperty('signedOutReason');
    // A reason means nothing to a signed-in viewer; devices mean nothing to a signed-out one.
    expect(parseMe({ paywall: true, user: { email: 'a@example.com' }, signedOutReason: 'remote' })).not.toHaveProperty('signedOutReason');
    expect(parseMe({ paywall: true, user: null, devices: { max: 3, list: [device()] } })).not.toHaveProperty('devices');
  });

  it('device calls are same-origin POSTs to the sessions routes; the email forms carry the Turnstile token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({ ok: true });
    }) as typeof fetch;
    await revokeDevice('b'.repeat(24), f);
    await revokeOtherDevices(f);
    await sendSignInLink('a@example.com', '/regattas', f, null, 'tok');
    await sendRestoreLink('a@example.com', '/regattas', f, 'tok2');
    await sendSignInLink('a@example.com', '/regattas', f);
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/sessions/revoke', '/api/auth/sessions/revoke-others', '/api/auth/email', '/api/auth/restore', '/api/auth/email']);
    for (const c of calls) expect(c.init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([
      { id: 'b'.repeat(24) },
      {},
      { email: 'a@example.com', returnTo: '/regattas', turnstileToken: 'tok' },
      { email: 'a@example.com', returnTo: '/regattas', turnstileToken: 'tok2' },
      { email: 'a@example.com', returnTo: '/regattas' },
    ]);
  });
});

describe('the account sheet: Devices', () => {
  it('"Signed in on 2 of 3 devices.", this device first, Sign out for the others, and Sign out all other devices', () => {
    const s = sheetHtml(signedIn(), { mode: 'account' }, title);
    expect(s).toContain('<h3 class="account-sub">Devices</h3>');
    expect(s).toContain('<p>Signed in on 2 of 3 devices.</p>');
    const rows = s.match(/<li class="account-device">[\s\S]*?<\/li>/g)!;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Safari on iPhone');
    expect(rows[0]).toContain('This device');
    expect(rows[0]).not.toContain('data-pw="revoke"');
    expect(rows[1]).toContain('Chrome on Mac');
    expect(rows[1]).toContain('Last used Oct 20');
    expect(rows[1]).toContain(`<button type="button" class="lock-secondary" data-pw="revoke" data-id="${'b'.repeat(24)}">Sign out</button>`);
    expect(s).toContain('<button type="button" class="lock-secondary" data-pw="revoke-others">Sign out all other devices</button>');
    // Sign out (this device) is still there, apart from the device list.
    expect(s).toContain('data-pw="signout"');
    expect(plain(s)).not.toMatch(/[–—!]/);
  });

  it('one device: no "all other devices" button; busy disables the buttons; labels are escaped', () => {
    const one = devicesHtml({ max: 3, list: [device()] });
    expect(one).toContain('Signed in on 1 of 3 devices.');
    expect(one).not.toContain('revoke-others');
    const busy = devicesHtml(signedIn().paywall ? (signedIn() as Extract<Me, { paywall: true }>).devices : undefined, true);
    expect(busy.match(/data-pw="revoke(?:-others)?"[^>]* disabled/g)).toHaveLength(2);
    const odd = devicesHtml({ max: 5, list: [device(), device({ id: 'c'.repeat(24), label: '<img src=x>', current: false })] });
    expect(odd).toContain('&lt;img src=x&gt;');
    expect(odd).not.toContain('<img');
    expect(odd).toContain('of 5 devices');
    expect(devicesHtml(undefined)).toBe('');
    expect(devicesHtml({ max: 3, list: [] })).toBe('');
    expect(sheetHtml(signedIn({ devices: undefined }), { mode: 'account' }, title)).not.toContain('Devices');
  });

  it('dates read US style: "Oct 20", with the year only when it isn’t this year', () => {
    expect(shortDate(OCT20, NOW)).toBe('Oct 20');
    expect(shortDate(Date.parse('2025-12-02T12:00:00Z'), NOW)).toBe('Dec 2, 2025');
  });
});

describe('signed out from elsewhere, and what a sign-in signed out', () => {
  it('says why, plainly, in the sign-in sheet', () => {
    expect(signedOutNote('device_limit')).toBe('You were signed out on this device because your account signed in somewhere else. Recall stays signed in on up to 3 devices at a time.');
    expect(signedOutNote('remote')).toBe('You were signed out on this device from another device.');
    expect(signedOutNote('admin')).toBe('You were signed out. Sign in again to keep going.');
    const me: Me = { paywall: true, user: null, entitlements: [], signIn: { email: true, google: true }, signedOutReason: 'device_limit' };
    const s = sheetHtml(me, { mode: 'signin', note: signedOutNote('device_limit') }, title);
    expect(s).toContain('<p class="account-note" role="status">You were signed out on this device because your account signed in somewhere else.');
    expect(s).toContain('type="email"');
    for (const r of ['device_limit', 'remote', 'admin'] as const) expect(signedOutNote(r)).not.toMatch(/[–—!]/);
  });

  it('"Signing in here signed out Safari on iPhone (last used Oct 20)."', () => {
    expect(bumpedNote([{ label: 'Safari on iPhone', lastSeenAt: OCT20 }], NOW)).toBe('Signing in here signed out Safari on iPhone (last used Oct 20).');
    expect(bumpedNote([{ label: 'Safari on iPhone', lastSeenAt: OCT20 }, { label: 'Chrome on Mac', lastSeenAt: OCT18 }], NOW)).toBe(
      'Signing in here signed out Safari on iPhone (last used Oct 20) and Chrome on Mac (last used Oct 18).',
    );
    expect(bumpedNote([], NOW)).toBe('');
  });

  /** The note's own element, as the controller renders it (the app's #notice never carries it). */
  function harness(storage: NoteStore | null) {
    const shown: string[] = [];
    const note = createBumpNote({ store: storage, render: (t) => shown.push(t), now: () => NOW });
    return { note, shown, visible: () => shown.at(-1) ?? '' };
  }
  const memStore = () => {
    const m = new Map<string, string>();
    return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } };
  };
  const bumpedMe = signedIn({ bumped: [{ label: 'Firefox on Windows', lastSeenAt: OCT20 }] });
  const TEXT = 'Signing in here signed out Firefox on Windows (last used Oct 20).';

  it('stays up, and unseen, until dismissed: showing it marks nothing, so a reload shows it again', () => {
    const { m, s } = memStore();
    const a = harness(s);
    a.note.update(bumpedMe);
    expect(a.visible()).toBe(TEXT);
    // /me re-read (a race load, a refresh): still there, still not marked seen.
    a.note.update(bumpedMe);
    a.note.update(bumpedMe);
    expect(a.visible()).toBe(TEXT);
    expect(m.size).toBe(0);
    // A reload before it was dismissed: shown again.
    const b = harness(s);
    b.note.update(bumpedMe);
    expect(b.visible()).toBe(TEXT);
    // Dismiss: gone, and remembered for this session (by this device's id).
    b.note.dismiss();
    expect(b.visible()).toBe('');
    expect([...m.keys()]).toEqual([`recall.bumped.${'a'.repeat(24)}`]);
    b.note.update(bumpedMe);
    expect(b.visible()).toBe('');
    const c = harness(s);
    c.note.update(bumpedMe);
    expect(c.shown).toEqual([]);
  });

  it('opening the account sheet carries it as the sheet note (and that counts as seen)', () => {
    const { m, s } = memStore();
    const h = harness(s);
    h.note.update(bumpedMe);
    expect(h.note.takeForSheet()).toBe(TEXT);
    expect(h.visible()).toBe('');
    expect(m.size).toBe(1);
    expect(h.note.takeForSheet()).toBe('');
    expect(sheetHtml(bumpedMe, { mode: 'account', note: TEXT }, title)).toContain(`<p class="account-note" role="status">${TEXT}</p>`);
  });

  it('another session gets its own note; nothing bumped, signed out or paywall off shows nothing; broken storage still works per page', () => {
    const { s } = memStore();
    const h = harness(s);
    h.note.update(bumpedMe);
    h.note.dismiss();
    h.note.update(signedIn({ bumped: [{ label: 'Chrome on Mac', lastSeenAt: OCT20 }], devices: { max: 3, list: [device({ id: 'd'.repeat(24) })] } }));
    expect(h.visible()).toContain('Chrome on Mac');
    // Signed out meanwhile: the note goes.
    h.note.update({ paywall: true, user: null, entitlements: [], signIn: { email: true, google: true } });
    expect(h.visible()).toBe('');
    const quiet = harness(s);
    for (const me of [signedIn(), PAYWALL_OFF]) quiet.note.update(me);
    expect(quiet.shown).toEqual([]);
    const broken = harness({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    broken.note.update(bumpedMe);
    expect(broken.visible()).toBe(TEXT);
    broken.note.dismiss();
    broken.note.update(bumpedMe);
    expect(broken.visible()).toBe('');
  });

  it('lives outside #notice: the race-load path (setNotice in app.ts) never reaches it', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/ui/paywall.ts', import.meta.url)), 'utf8');
    const app = readFileSync(fileURLToPath(new URL('../src/ui/app.ts', import.meta.url)), 'utf8');
    // The bump note renders into its own #account-notice, not through the app's notice callback.
    expect(src).toContain("noteEl.id = 'account-notice'");
    expect(src).not.toMatch(/o\.notice\([^)]*bump/i);
    expect(app).not.toContain('account-notice');
  });
});

describe('Turnstile on the email forms', () => {
  it('a slot in the sign-in and restore forms only when the site has a key; none with the paywall off', () => {
    const withKey: Me = { paywall: true, user: null, entitlements: [], signIn: { email: true, google: false, turnstileSiteKey: '0x4AAAAtest' } };
    expect(sheetHtml(withKey, { mode: 'signin' }, title)).toContain('<div class="account-turnstile" data-pw-turnstile="signin"></div>');
    expect(sheetHtml(withKey, { mode: 'restore' }, title)).toContain('data-pw-turnstile="restore"');
    expect(sheetHtml(withKey, { mode: 'sent', email: 'a@example.com' }, title)).not.toContain('data-pw-turnstile');
    const noKey: Me = { ...withKey, signIn: { email: true, google: false, turnstileSiteKey: null } };
    expect(sheetHtml(noKey, { mode: 'signin' }, title)).not.toContain('data-pw-turnstile');
    expect(sheetHtml(PAYWALL_OFF, { mode: 'signin' }, title)).toBe('');
    expect(TURNSTILE_SRC).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  });

  /** A fake window.turnstile: records render, reset and remove; `solve` plays Cloudflare handing over a token. */
  function fakeApi(): TurnstileApi & { renders: { el: unknown; o: TurnstileRenderOptions }[]; resets: unknown[]; removes: unknown[]; solve: (t: string) => void } {
    const api = {
      renders: [] as { el: unknown; o: TurnstileRenderOptions }[],
      resets: [] as unknown[],
      removes: [] as unknown[],
      render(el: HTMLElement, o: TurnstileRenderOptions) {
        api.renders.push({ el, o });
        return `w${api.renders.length}`;
      },
      reset(id?: string) {
        api.resets.push(id);
      },
      remove(id?: string) {
        api.removes.push(id);
      },
      solve(t: string) {
        api.renders.at(-1)!.o.callback(t);
      },
    };
    return api;
  }
  /** Timers the test fires by hand. */
  const manualTimers = () => {
    const pending: (() => void)[] = [];
    return { setTimer: (f: () => void) => void pending.push(f), fire: () => pending.splice(0).forEach((f) => f()) };
  };

  it('loads once, renders interaction-only with the action, and hands over the token', async () => {
    const api = fakeApi();
    let loads = 0;
    const t = createTurnstile({ siteKey: '0x4AAAAtest', load: async () => (loads++, api) });
    const el = {} as HTMLElement;
    await t.mount(el, 'restore');
    await t.mount(el, 'restore');
    expect(api.renders).toHaveLength(1);
    expect(api.renders[0].el).toBe(el);
    expect(api.renders[0].o).toMatchObject({ sitekey: '0x4AAAAtest', action: 'restore', appearance: 'interaction-only' });
    api.solve('tok-1');
    expect(await t.token()).toBe('tok-1');
    // A new form: the old widget goes, a new one comes (the loader is the page's single script).
    const el2 = {} as HTMLElement;
    await t.mount(el2, 'signin');
    expect(api.removes).toEqual(['w1']);
    expect(api.renders[1].o.action).toBe('signin');
    expect(t.mounted()).toBe(el2);
    expect(loads).toBe(2);
  });

  it('a submit waits briefly for a token that isn’t ready, then gives up (null)', async () => {
    const api = fakeApi();
    const timers = manualTimers();
    const t = createTurnstile({ siteKey: 'k', load: async () => api, setTimer: timers.setTimer });
    await t.mount({} as HTMLElement, 'signin');
    const waiting = t.token(4000);
    api.solve('late-token');
    expect(await waiting).toBe('late-token');
    t.reset();
    expect(api.resets).toEqual(['w1']);
    const none = t.token(4000);
    timers.fire();
    expect(await none).toBeNull();
    // An expired token is not handed over.
    api.solve('t2');
    api.renders[0].o['expired-callback']();
    const after = t.token(10);
    timers.fire();
    expect(await after).toBeNull();
    expect(api.renders[0].o['error-callback']()).toBe(true);
  });

  it('a script that fails to load leaves no widget: the submit gets null', async () => {
    const timers = manualTimers();
    const t = createTurnstile({
      siteKey: 'k',
      load: async () => {
        throw new Error('blocked');
      },
      setTimer: timers.setTimer,
    });
    await t.mount({} as HTMLElement, 'signin');
    const tok = t.token();
    timers.fire();
    expect(await tok).toBeNull();
    t.reset();
    t.unmount();
    expect(t.mounted()).toBeNull();
  });

  it('a form gone before the script arrived gets no widget', async () => {
    const api = fakeApi();
    let release!: () => void;
    const t = createTurnstile({ siteKey: 'k', load: () => new Promise<TurnstileApi>((r) => (release = () => r(api))) });
    const pending = t.mount({} as HTMLElement, 'signin');
    t.unmount();
    release();
    await pending;
    expect(api.renders).toEqual([]);
  });
});
