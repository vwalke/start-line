/**
 * The landing page's lightbox: a feature card's thumbnail (`.land-thumb` in index.html) opens its full-size image
 * (the button's `data-full`, loaded only then) in one native <dialog> (`#land-lightbox`), captioned with the card's
 * heading and the button's `data-caption`. showModal() keeps focus inside; the close button takes it on open and
 * the thumbnail gets it back on close. Esc, a click on the backdrop and the close button close it. The page behind
 * doesn't scroll while it is open (`overflow: hidden` on <html>, put back as it was).
 */
export const LIGHTBOX_ID = 'land-lightbox';

export function startLightbox(doc: Document = document): void {
  const dialog = doc.getElementById(LIGHTBOX_ID) as HTMLDialogElement | null;
  const img = dialog?.querySelector<HTMLImageElement>('.land-lb-img');
  const title = dialog?.querySelector<HTMLElement>('.land-lb-title');
  const line = dialog?.querySelector<HTMLElement>('.land-lb-line');
  const close = dialog?.querySelector<HTMLButtonElement>('.land-lb-close');
  if (!dialog || !img || !title || !line || !close) return;
  const root = doc.documentElement;
  let opener: HTMLElement | null = null;
  let overflow: string | null = null;

  const open = (btn: HTMLButtonElement): void => {
    const full = btn.getAttribute('data-full');
    if (!full || dialog.open) return;
    opener = btn;
    // No old image while the new one loads.
    img.removeAttribute('src');
    img.alt = btn.querySelector('img')?.alt ?? '';
    img.src = full;
    title.textContent = btn.closest('.land-card')?.querySelector('h3')?.textContent?.trim() ?? '';
    line.textContent = btn.getAttribute('data-caption') ?? '';
    overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    dialog.showModal();
    close.focus();
  };
  const shut = (): void => {
    if (dialog.open) dialog.close();
  };

  for (const btn of doc.querySelectorAll<HTMLButtonElement>('.land-thumb')) btn.addEventListener('click', () => open(btn));
  close.addEventListener('click', shut);
  // Esc: closed here rather than left to the browser, so it always goes through `close` below.
  dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    shut();
  });
  // The backdrop: a click on the dialog itself, not on the figure inside it.
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) shut();
  });
  dialog.addEventListener('close', () => {
    if (overflow != null) root.style.overflow = overflow;
    overflow = null;
    opener?.focus();
    opener = null;
  });
}
