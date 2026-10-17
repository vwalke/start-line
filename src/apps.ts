/**
 * The four Walke Forward racing apps, in the shared switcher order, and the
 * bottom-sheet switcher the header logo opens (ported from VannCast).
 * Native `<dialog>` supplies the focus trap, Esc, and returning focus to the logo.
 */
export const HERE = 'recall' as const;

const RECALL_URL = 'https://recall.walkeforward.com/';

export const APPS = [
  {
    id: 'railmath',
    name: 'Rail Math',
    description: 'Time-on-time deltas',
    href: 'https://railmath.walkeforward.com/',
    icon: '/apps/railmath.svg',
  },
  {
    id: 'legwork',
    name: 'Leg Work',
    description: 'Range & bearing to every mark',
    href: 'https://legwork.walkeforward.com/',
    icon: '/apps/legwork.svg',
  },
  {
    id: 'vanncast',
    name: 'VannCast',
    description: 'Annapolis racing weather',
    href: 'https://vanncast.walkeforward.com/',
    icon: '/apps/vanncast.svg',
  },
  {
    id: 'recall',
    name: 'Recall',
    description: 'Start & leg digest',
    href: RECALL_URL,
    icon: '/apps/recall.svg',
  },
] as const;

export type AppId = (typeof APPS)[number]['id'];

const SWIPE_CLOSE_PX = 72;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function put(parent: Element, ...kids: Node[]): void {
  for (const k of kids) parent.appendChild(k);
}

export function startSwitcher(): void {
  const openBtn = document.querySelector<HTMLButtonElement>('.switcher-open');
  if (!openBtn || document.getElementById('app-switcher')) return;

  const dialog = build();
  document.body.appendChild(dialog);

  openBtn.addEventListener('click', () => {
    openBtn.setAttribute('aria-expanded', 'true');
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('.switcher-close')?.focus();
  });

  dialog.addEventListener('close', () => {
    openBtn.setAttribute('aria-expanded', 'false');
    openBtn.focus();
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

function build(): HTMLDialogElement {
  const dialog = el('dialog', 'switcher');
  dialog.id = 'app-switcher';
  dialog.setAttribute('aria-labelledby', 'switcher-title');

  const sheet = el('div', 'switcher-sheet');
  const head = el('div', 'switcher-head');
  const title = el('h2', 'switcher-title', 'Walke Forward racing');
  title.id = 'switcher-title';
  const closeBtn = el('button', 'switcher-close', 'Close');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => dialog.close());
  put(head, title, closeBtn);

  const list = el('ul', 'switcher-apps');
  for (const app of APPS) {
    const item = el('li', 'switcher-app');
    const icon = el('img', 'switcher-icon');
    icon.src = app.icon;
    icon.alt = '';
    icon.width = 48;
    icon.height = 48;

    const copy = el('span', 'switcher-copy');
    put(copy, el('span', 'switcher-name', app.name), el('span', 'switcher-desc', app.description));

    if (app.id === HERE) {
      const row = el('div', 'switcher-row switcher-here');
      put(row, icon, copy, el('span', 'switcher-here-tag', "You're here"));
      item.appendChild(row);
    } else {
      const row = el('a', 'switcher-row');
      row.href = app.href;
      put(row, icon, copy);
      item.appendChild(row);
    }
    list.appendChild(item);
  }

  const foot = el('p', 'switcher-foot');
  const home = el('a', undefined, 'walkeforward.com');
  home.href = 'https://walkeforward.com/';
  home.rel = 'noopener';
  foot.appendChild(home);

  put(sheet, head, list, foot);
  dialog.appendChild(sheet);
  bindSwipe(sheet, () => {
    if (dialog.open) dialog.close();
  });
  return dialog;
}

function bindSwipe(sheet: HTMLElement, close: () => void): void {
  let startY = 0;
  sheet.addEventListener(
    'touchstart',
    (event) => {
      startY = event.touches[0]?.clientY ?? 0;
    },
    { passive: true },
  );
  sheet.addEventListener(
    'touchend',
    (event) => {
      const endY = event.changedTouches[0]?.clientY ?? startY;
      if (endY - startY > SWIPE_CLOSE_PX) close();
    },
    { passive: true },
  );
}
