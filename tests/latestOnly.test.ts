/**
 * The Start tab's earlier attempts load through ui/latestOnly.ts: two asked for in turn can come back out of order,
 * and only the latest asked for is drawn.
 */
import { describe, expect, it } from 'vitest';
import { latestLoader } from '../src/ui/latestOnly';

/** A load the test answers by hand. */
function manual() {
  const calls: { k: number; answer: (r: string) => void; aborted: boolean }[] = [];
  const load = (k: number) => {
    let answer!: (r: string) => void;
    const done = new Promise<string>((res) => (answer = res));
    const call = { k, answer, aborted: false };
    calls.push(call);
    return { done, abort: () => (call.aborted = true) };
  };
  return { calls, load };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('only the latest attempt asked for is drawn', () => {
  it('drops an older load that finishes after a newer one, and aborts it', async () => {
    const { calls, load } = manual();
    const drawn: [number, string][] = [];
    const l = latestLoader(load, (k, r) => drawn.push([k, r]));
    l.want('race5|1', 1);
    l.want('race5|2', 2);
    expect(calls[0].aborted).toBe(true);
    expect(calls[1].aborted).toBe(false);
    // The newer one answers first, then the older one late.
    calls[1].answer('gun of attempt 2');
    await settle();
    calls[0].answer('gun of attempt 1');
    await settle();
    expect(drawn).toEqual([[2, 'gun of attempt 2']]);
    expect(l.loading()).toBeNull();
  });

  it('drops an older load that finishes first, while the newer one is still loading', async () => {
    const { calls, load } = manual();
    const drawn: number[] = [];
    const l = latestLoader(load, (k) => drawn.push(k));
    l.want('a|1', 1);
    l.want('a|2', 2);
    calls[0].answer('late');
    await settle();
    expect(drawn).toEqual([]);
    expect(l.loading()).toBe('a|2');
    calls[1].answer('now');
    await settle();
    expect(drawn).toEqual([2]);
  });

  it('asks once for the one already loading; a cancel (closed, another race) drops it', async () => {
    const { calls, load } = manual();
    const drawn: number[] = [];
    const l = latestLoader(load, (k) => drawn.push(k));
    l.want('a|1', 1);
    l.want('a|1', 1);
    expect(calls).toHaveLength(1);
    l.cancel();
    expect(calls[0].aborted).toBe(true);
    calls[0].answer('late');
    await settle();
    expect(drawn).toEqual([]);
    // Asked for again: loaded again, and drawn.
    l.want('a|1', 1);
    calls[1].answer('again');
    await settle();
    expect(drawn).toEqual([1]);
  });
});
