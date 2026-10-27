/**
 * Cloudflare Turnstile on the account sheet's email forms (sign in, Restore access). Only when
 * /api/auth/me hands the page a site key: the script loads once, lazily, the first time a form shows,
 * and never with the paywall off. The widget renders `interaction-only` (invisible unless Cloudflare
 * wants a click); the server checks its token (functions/_auth.ts verifyTurnstile).
 * createTurnstile takes the loader as a parameter, so the tests drive it with a fake.
 */

export const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** How long a submit waits for a token that isn't ready yet. */
export const TOKEN_WAIT_MS = 4_000;

export type TurnstileAction = 'signin' | 'restore' | 'feedback';

export interface TurnstileRenderOptions {
  sitekey: string;
  action: TurnstileAction;
  appearance: 'interaction-only';
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => boolean;
}

/** The part of window.turnstile we use. */
export interface TurnstileApi {
  render(el: HTMLElement, o: TurnstileRenderOptions): string | undefined;
  reset(id?: string): void;
  remove(id?: string): void;
}

export type TurnstileLoader = () => Promise<TurnstileApi>;

let loading: Promise<TurnstileApi> | null = null;

/** Add Cloudflare's script once (a failed load may be tried again later). Browser only. */
export const loadTurnstileScript: TurnstileLoader = () =>
  (loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const w = window as unknown as { turnstile?: TurnstileApi };
    if (w.turnstile) return resolve(w.turnstile);
    const s = document.createElement('script');
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('Turnstile missing')));
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error('Turnstile failed to load'));
    };
    document.head.appendChild(s);
  }));

export interface Turnstile {
  /** Render the widget into `el` (the form's slot), unless it is there already; any earlier widget goes. */
  mount(el: HTMLElement, action: TurnstileAction): Promise<void>;
  /** Take the widget away (the form is gone). */
  unmount(): void;
  /** The element the widget lives in, if any. */
  mounted(): HTMLElement | null;
  /** The current token; if none yet, wait up to `waitMs` for one (null: none came). */
  token(waitMs?: number): Promise<string | null>;
  /** After a submit: a token is good once, so ask for a fresh one. */
  reset(): void;
}

export function createTurnstile(o: { siteKey: string; load?: TurnstileLoader; setTimer?: (f: () => void, ms: number) => unknown }): Turnstile {
  const load = o.load ?? loadTurnstileScript;
  const setTimer = o.setTimer ?? ((f: () => void, ms: number) => setTimeout(f, ms));
  let api: TurnstileApi | null = null;
  let id: string | undefined;
  let el: HTMLElement | null = null;
  let current: string | null = null;
  let waiters: ((t: string | null) => void)[] = [];

  const settle = (t: string | null): void => {
    const w = waiters;
    waiters = [];
    for (const f of w) f(t);
  };

  function unmount(): void {
    if (api && id !== undefined) {
      try {
        api.remove(id);
      } catch {
        /* already gone */
      }
    }
    id = undefined;
    el = null;
    current = null;
  }

  async function mount(target: HTMLElement, action: TurnstileAction): Promise<void> {
    if (el === target) return;
    unmount();
    el = target;
    try {
      api = await load();
    } catch {
      return; // no widget: a submit then asks to complete the check
    }
    if (el !== target) return; // the sheet moved on while the script loaded
    try {
      id = api.render(target, {
        sitekey: o.siteKey,
        action,
        appearance: 'interaction-only',
        callback: (t) => {
          current = t;
          settle(t);
        },
        'expired-callback': () => {
          current = null;
        },
        'error-callback': () => {
          current = null;
          return true;
        },
      });
    } catch {
      id = undefined;
    }
  }

  function token(waitMs = TOKEN_WAIT_MS): Promise<string | null> {
    if (current) return Promise.resolve(current);
    return new Promise((resolve) => {
      let done = false;
      const finish = (t: string | null): void => {
        if (done) return;
        done = true;
        waiters = waiters.filter((w) => w !== finish);
        resolve(t);
      };
      waiters.push(finish);
      setTimer(() => finish(null), waitMs);
    });
  }

  function reset(): void {
    current = null;
    if (api && id !== undefined) {
      try {
        api.reset(id);
      } catch {
        /* the widget went with the form */
      }
    }
  }

  return { mount, unmount, mounted: () => el, token, reset };
}
