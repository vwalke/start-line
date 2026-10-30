/**
 * The Feedback button and sheet, on every page: in the masthead on wider screens, a small round button at
 * the bottom right on phones (lifted clear of the map's playback bar and zoom buttons when they're
 * under it). The sheet looks like the Account sheet: what it's about, a message, an email for a
 * signed-out sender, an optional picture and the course map, Turnstile when the site has a key.
 * It sends to POST /api/feedback (functions/_feedback.ts) with the context from context.ts.
 */
import './feedback.css';
import { track } from '../ui/track';
import { createTurnstile, type Turnstile } from '../ui/turnstile';
import { APP_BUILT_AT, APP_COMMIT } from './build';
import { buildContext, deviceInfo, readTheme, timeOnPage } from './context';
import { ACCEPTED, captureMap, shrinkImage, type Encoded } from './image';
import { problems } from './problems';
import { pageState } from './state';

export const MESSAGE_MAX = 4_000;

export const TYPES = [
  ['bug', 'Bug'],
  ['idea', 'Idea'],
  ['data', 'Data looks wrong'],
  ['other', 'Other'],
] as const;

export interface FeedbackInfo {
  ready: boolean;
  signedIn: boolean;
  turnstileSiteKey: string | null;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The sheet's form. The email field only for a signed-out sender; "Include the map" only when a map is on the page. */
export function feedbackSheetHtml(info: FeedbackInfo, o: { mapAvailable: boolean }): string {
  const head = (title: string): string =>
    `<div class="switcher-head"><h2 class="switcher-title" id="feedback-title">${esc(title)}</h2><button type="button" class="switcher-close" data-fb="close">Close</button></div>`;
  if (!info.ready) return `${head('Send feedback')}<p class="muted">Feedback isn't set up on this site yet.</p>`;
  const types = TYPES.map(
    ([v, label], i) => `<label class="fb-type"><input type="radio" name="type" value="${v}"${i === 0 ? ' checked' : ''}> ${esc(label)}</label>`,
  ).join('');
  const email = info.signedIn
    ? ''
    : `<label>Your email (optional, so we can reply) <input type="email" name="email" autocomplete="email" maxlength="254"></label>`;
  const map = o.mapAvailable ? '<label class="fb-check"><input type="checkbox" name="map"> Include the map</label>' : '';
  const slot = info.turnstileSiteKey ? '<div class="account-turnstile" data-fb-turnstile></div>' : '';
  return `${head('Send feedback')}
    <p class="account-note" role="status" data-fb-note hidden></p>
    <form class="account-form fb-form" novalidate>
      <fieldset class="fb-types"><legend>What's it about?</legend>${types}</fieldset>
      <label>Message <textarea name="message" rows="6" maxlength="${MESSAGE_MAX}" required aria-describedby="fb-count"></textarea></label>
      <p class="fb-count" id="fb-count" aria-live="off">0 / ${MESSAGE_MAX.toLocaleString('en-US')}</p>
      ${email}
      <label>A screenshot or photo (optional) <input type="file" name="image" accept="${ACCEPTED.join(',')}"></label>
      ${map}
      <p class="lock-small">Along with your message we send the page you're on, your browser and screen size, the app version, and any recent errors, to help us look into it.</p>
      ${slot}<p class="account-actions"><button type="submit" class="lock-primary">Send</button></p>
    </form>`;
}

export const thanksHtml = (): string =>
  `<div class="switcher-head"><h2 class="switcher-title" id="feedback-title">Thanks</h2><button type="button" class="switcher-close" data-fb="close">Close</button></div>
  <p role="status">Got it. Thanks for taking the time to tell us.</p>`;

/** Plain-words message for a failed send. */
export function sendError(status: number, body: unknown): string {
  const m = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
  if (typeof m === 'string' && m && m.length < 200) return m;
  if (status === 429) return "That's a lot of feedback in one hour. Try again later.";
  if (status === 413) return 'That was too big to send. Try a smaller image, or leave it out.';
  if (status === 0) return "Couldn't send it. Check your connection and try again.";
  return "Couldn't send it just now. Try again in a minute.";
}

/** How far to lift the floating button (px) so it clears `obstacles`, given its own box. */
export function liftFor(btn: { top: number; bottom: number; left: number; right: number }, obstacles: readonly { top: number; bottom: number; left: number; right: number }[], gap = 8): number {
  let lift = 0;
  for (const o of obstacles) {
    const overlapsX = o.left < btn.right && o.right > btn.left;
    const overlapsY = o.top < btn.bottom - lift && o.bottom > btn.top - lift;
    if (overlapsX && overlapsY) lift = Math.max(lift, btn.bottom - o.top + gap);
  }
  return Math.round(lift);
}

async function fetchInfo(): Promise<FeedbackInfo> {
  try {
    const r = await fetch('/api/feedback', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    const b = (await r.json()) as Partial<FeedbackInfo> & { ok?: unknown };
    if (!r.ok || b.ok !== true) throw new Error('no');
    return { ready: b.ready === true, signedIn: b.signedIn === true, turnstileSiteKey: typeof b.turnstileSiteKey === 'string' && b.turnstileSiteKey ? b.turnstileSiteKey : null };
  } catch {
    // Unknown (offline, or a dev server without the function): let the send say what went wrong.
    return { ready: true, signedIn: false, turnstileSiteKey: null };
  }
}

const ICON =
  '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v8a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 3v-3h0A1.5 1.5 0 0 1 3 12.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

/** The course map on the page, if any (the Race tab's, or the full-screen copy). */
const mapSvg = (): SVGSVGElement | null => document.querySelector<SVGSVGElement>('#fs-body #map-chart svg, #map-chart svg');

export function startFeedback(): void {
  if (document.getElementById('feedback')) return;
  let info: FeedbackInfo | null = null;
  let turnstile: Turnstile | null = null;
  let opener: HTMLElement | null = null;
  let busy = false;

  const dialog = document.createElement('dialog');
  dialog.id = 'feedback';
  dialog.className = 'switcher account feedback';
  dialog.setAttribute('aria-labelledby', 'feedback-title');
  dialog.innerHTML = '<div class="switcher-sheet"></div>';
  document.body.appendChild(dialog);
  const box = dialog.querySelector<HTMLElement>('.switcher-sheet')!;

  const buttons: HTMLButtonElement[] = [];
  const makeButton = (cls: string, inner: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.innerHTML = inner;
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-controls', 'feedback');
    b.addEventListener('click', () => void open(b));
    buttons.push(b);
    return b;
  };
  // Wider screens: in the masthead, before the Account button (which paywall.ts appends later).
  const inner = document.querySelector('.masthead-inner');
  if (inner) inner.appendChild(makeButton('feedback-open', 'Feedback'));
  // Phones: floating, bottom right.
  const fab = makeButton('feedback-fab', ICON);
  fab.setAttribute('aria-label', 'Send feedback');
  fab.title = 'Send feedback';
  document.body.appendChild(fab);

  // Keep the floating button clear of the map's controls when they scroll under it.
  let raf = 0;
  const place = (): void => {
    raf = 0;
    if (getComputedStyle(fab).display === 'none') return;
    fab.style.removeProperty('--fb-lift');
    const r = fab.getBoundingClientRect();
    const obstacles = [...document.querySelectorAll<HTMLElement>('.scrub, .zoom, .replay, .fs-tools')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => el.getBoundingClientRect());
    const lift = liftFor(r, obstacles);
    if (lift) fab.style.setProperty('--fb-lift', `${Math.min(lift, innerHeight / 2)}px`);
  };
  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(place);
  };
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  schedule();

  const note = (text: string): void => {
    const el = box.querySelector<HTMLElement>('[data-fb-note]');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  };

  function render(): void {
    if (!info) {
      box.innerHTML = `<div class="switcher-head"><h2 class="switcher-title" id="feedback-title">Send feedback</h2><button type="button" class="switcher-close" data-fb="close">Close</button></div><p class="muted">Loading…</p>`;
      return;
    }
    box.innerHTML = feedbackSheetHtml(info, { mapAvailable: !!mapSvg() });
    const slot = box.querySelector<HTMLElement>('[data-fb-turnstile]');
    if (slot && info.turnstileSiteKey) {
      turnstile ??= createTurnstile({ siteKey: info.turnstileSiteKey });
      void turnstile.mount(slot, 'feedback');
    }
    const ta = box.querySelector<HTMLTextAreaElement>('textarea');
    const count = box.querySelector<HTMLElement>('.fb-count');
    ta?.addEventListener('input', () => {
      if (count) count.textContent = `${ta.value.length.toLocaleString('en-US')} / ${MESSAGE_MAX.toLocaleString('en-US')}`;
    });
    ta?.focus();
  }

  async function open(from: HTMLElement): Promise<void> {
    opener = from;
    if (!dialog.open) {
      track('feedback_open');
      info = null;
      render();
      dialog.showModal();
      buttons.forEach((b) => b.setAttribute('aria-expanded', 'true'));
    }
    const got = await fetchInfo();
    if (!dialog.open) return;
    info = got;
    render();
  }

  dialog.addEventListener('close', () => {
    turnstile?.unmount();
    buttons.forEach((b) => b.setAttribute('aria-expanded', 'false'));
    busy = false;
    (opener && opener.offsetParent !== null ? opener : null)?.focus();
  });
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog || (ev.target as HTMLElement).closest('[data-fb="close"]')) dialog.close();
  });
  dialog.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = (ev.target as HTMLElement).closest<HTMLFormElement>('form');
    if (form && !busy) void send(form);
  });

  async function send(form: HTMLFormElement): Promise<void> {
    const fd = new FormData(form);
    const message = String(fd.get('message') ?? '').trim();
    if (!message) {
      note('Write a few words first.');
      form.querySelector<HTMLTextAreaElement>('textarea')?.focus();
      return;
    }
    if (message.length > MESSAGE_MAX) return note(`That's over ${MESSAGE_MAX.toLocaleString('en-US')} characters. Shorten it a little.`);
    const email = String(fd.get('email') ?? '').trim();
    const emailInput = form.querySelector<HTMLInputElement>('input[name="email"]');
    if (email && emailInput && !emailInput.checkValidity()) return note('That email address doesn’t look right.');
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const setBusy = (on: boolean, label = 'Send'): void => {
      busy = on;
      if (submit) {
        submit.disabled = on;
        submit.textContent = label;
      }
    };
    setBusy(true, 'Sending…');
    note('');
    try {
      let image: Encoded | null = null;
      const file = fd.get('image');
      if (file instanceof File && file.size > 0) {
        image = await shrinkImage(file);
        if (!image) {
          setBusy(false);
          return note("Couldn't read that picture. Try a PNG or JPEG, or leave it out.");
        }
      }
      let map: Encoded | null = null;
      let mapNote: string | undefined;
      const svg = fd.get('map') ? mapSvg() : null;
      if (svg) {
        const m = await captureMap(svg);
        if (typeof m === 'string') mapNote = m;
        else map = m;
      }
      let turnstileToken: string | null = null;
      if (info?.turnstileSiteKey) {
        turnstileToken = turnstile ? await turnstile.token() : null;
        if (!turnstileToken) {
          setBusy(false);
          return note('Please complete the check and try again.');
        }
      }
      const context = buildContext({
        href: location.href,
        title: document.title,
        state: pageState(),
        device: deviceInfo(),
        theme: readTheme(),
        app: { commit: APP_COMMIT, builtAt: APP_BUILT_AT },
        problems: problems.list(),
        timeOnPageMs: timeOnPage(),
        now: new Date(),
      });
      const body = {
        type: String(fd.get('type') ?? 'other'),
        message,
        ...(email ? { email } : {}),
        context: mapNote ? { ...context, mapNote } : context,
        ...(image ? { image: { type: image.type, data: image.data } } : {}),
        ...(map ? { map: { type: map.type, data: map.data } } : {}),
        ...(turnstileToken ? { turnstileToken } : {}),
      };
      let res: Response;
      try {
        res = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
      } catch {
        turnstile?.reset();
        setBusy(false);
        return note(sendError(0, null));
      }
      const out = (await res.json().catch(() => null)) as unknown;
      turnstile?.reset();
      if (!res.ok) {
        setBusy(false);
        return note(sendError(res.status, out));
      }
      track('feedback_sent', { detail: body.type });
      turnstile?.unmount();
      box.innerHTML = thanksHtml();
      box.querySelector<HTMLElement>('.switcher-close')?.focus();
      busy = false;
    } catch {
      setBusy(false);
      note("Couldn't send it just now. Try again in a minute.");
    }
  }
}
