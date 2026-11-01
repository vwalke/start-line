/**
 * The page's "the app has started" mark, data-booted on <html>. index.html's inline boot-retry script loads the
 * entry once more when it's missing (the script failed, or hasn't run 8 s in), so two copies of main.ts can run
 * on a slow network: only the first to get here starts the page.
 */
export function firstBoot(root: HTMLElement): boolean {
  if (root.dataset.booted) return false;
  root.dataset.booted = '1';
  return true;
}
