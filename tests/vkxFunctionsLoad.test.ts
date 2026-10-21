/**
 * Cloudflare Workers forbid crypto.getRandomValues (and friends) at module
 * scope. Each functions/ file is a Pages entry: importing it must be inert.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const MODULES = [
  '../functions/_vkx.ts',
  '../functions/_lib.ts',
  '../functions/api/[[path]].ts',
  '../functions/api/vkx/upload.ts',
  '../functions/api/vkx/list.ts',
  '../functions/api/vkx/data.ts',
  '../functions/api/vkx/delete.ts',
] as const;

describe('Pages Functions import', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call crypto.getRandomValues when each functions module is imported', async () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    for (const spec of MODULES) {
      vi.resetModules();
      spy.mockClear();
      await import(spec);
      expect(spy, spec).not.toHaveBeenCalled();
    }
  });

  it('creates the rate-limit salt on first allow(), not on new RateLimiter()', async () => {
    vi.resetModules();
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const { RateLimiter } = await import('../functions/_vkx.ts');
    expect(spy).not.toHaveBeenCalled();
    const lim = new RateLimiter(2, 60_000);
    expect(spy).not.toHaveBeenCalled();
    expect(await lim.allow('1.2.3.4', 0)).toBe(true);
    expect(spy).toHaveBeenCalled();
  });
});
