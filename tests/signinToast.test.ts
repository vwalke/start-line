import { describe, expect, it } from 'vitest';
import { SIGNED_IN_PARAM, SIGNED_IN_VALUE } from '../functions/_auth';
import { EXPIRED_NOTE, TOAST_MS, createToast, hereWithout, returnParam, welcomeText, type Timers } from '../src/ui/paywall';

/** Timers run by hand: `tick(ms)` fires whatever is due. */
function fakeTimers(): Timers & { tick(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    set(run, ms) {
      const id = next++;
      due.set(id, { at: now + ms, run });
      return id;
    },
    clear(id) {
      due.delete(id as number);
    },
    tick(ms) {
      now += ms;
      for (const [id, t] of [...due]) {
        if (t.at <= now) {
          due.delete(id);
          t.run();
        }
      }
    },
    pending: () => due.size,
  };
}

describe('the welcome toast after a sign-in', () => {
  it('the marker: the server adds signin=ok, the page reads it and drops it from the URL', () => {
    expect(`${SIGNED_IN_PARAM}=${SIGNED_IN_VALUE}`).toBe('signin=ok');
    expect(returnParam('?race=3&signin=ok')).toEqual({ kind: 'signin', value: 'ok' });
    expect(returnParam('?signin=expired')).toEqual({ kind: 'signin', value: 'expired' });
    expect(returnParam('?signin=yes')).toBeNull();
    expect(hereWithout('https://recall.walkeforward.com/?event=x&race=3&signin=ok#coach')).toBe('/?event=x&race=3#coach');
    expect(hereWithout('https://recall.walkeforward.com/regattas?signin=ok')).toBe('/regattas');
    // Bare `/` would be the landing page: the app stays on /regattas.
    expect(hereWithout('https://recall.walkeforward.com/?signin=ok')).toBe('/regattas');
    expect(hereWithout('https://recall.walkeforward.com/?event=x&buy=a.b&signin=ok')).toBe('/?event=x');
  });

  it('says who, when /api/auth/me knows; no dashes or exclamation marks', () => {
    expect(welcomeText('name@example.com')).toBe("You're signed in as name@example.com.");
    expect(welcomeText(null)).toBe("You're signed in.");
    expect(welcomeText()).toBe("You're signed in.");
    for (const t of [welcomeText('a@b.co'), welcomeText(), EXPIRED_NOTE]) expect(t).not.toMatch(/[–—!]/);
  });

  it('shows, then hides itself after about 5 seconds', () => {
    const timers = fakeTimers();
    const shown: string[] = [];
    const toast = createToast({ render: (t) => shown.push(t), timers });
    expect(TOAST_MS).toBe(5_000);
    toast.show("You're signed in.");
    expect(shown).toEqual(["You're signed in."]);
    expect(toast.text()).toBe("You're signed in.");
    timers.tick(TOAST_MS - 1);
    expect(shown).toEqual(["You're signed in."]);
    timers.tick(1);
    expect(shown).toEqual(["You're signed in.", '']);
    expect(toast.text()).toBe('');
    expect(timers.pending()).toBe(0);
  });

  it('the close button hides it at once and cancels the timer; hiding twice draws nothing more', () => {
    const timers = fakeTimers();
    const shown: string[] = [];
    const toast = createToast({ render: (t) => shown.push(t), timers });
    toast.show("You're signed in as a@example.com.");
    toast.dismiss();
    expect(shown).toEqual(["You're signed in as a@example.com.", '']);
    expect(timers.pending()).toBe(0);
    toast.dismiss();
    timers.tick(TOAST_MS * 2);
    expect(shown).toHaveLength(2);
  });

  it('a second show restarts the clock (one timer at a time)', () => {
    const timers = fakeTimers();
    const shown: string[] = [];
    const toast = createToast({ render: (t) => shown.push(t), timers, ms: 1000 });
    toast.show('one');
    timers.tick(800);
    toast.show('two');
    expect(timers.pending()).toBe(1);
    timers.tick(800);
    expect(shown).toEqual(['one', 'two']);
    timers.tick(200);
    expect(shown).toEqual(['one', 'two', '']);
  });
});

describe('the toast in the page', () => {
  it('its own element (#signin-toast), a polite live region, an accessible close, never focused', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/ui/paywall.ts', import.meta.url), 'utf8'));
    expect(src).toContain("toastEl.id = 'signin-toast'");
    expect(src).toContain('<p class="toast-text" role="status" aria-live="polite"></p><button type="button" class="toast-close" aria-label="Dismiss">×</button>');
    // Appended to <body>, not the app's #notice (which loading a race clears).
    expect(src).toContain('document.body.appendChild(toastEl)');
    const block = src.slice(src.indexOf('const toast = createToast('), src.indexOf('const bump = createBumpNote('));
    expect(block).not.toMatch(/\.focus\(/);
    const css = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/style.css', import.meta.url), 'utf8'));
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.toast \{ animation: none; \} \}/);
    expect(css).toMatch(/\.toast \{[^}]*max-width: calc\(100vw - 32px\)/);
  });
});
