/**
 * Every test file: a turn of the event loop after each test. The analysis tests are synchronous, and the runner goes
 * from one test to the next on promises alone, so a file of them never lets the worker read the reporter's replies:
 * once a file runs past birpc's 60 s, the reply to the first test's update times out ('Timeout calling
 * "onTaskUpdate"', after every test passed). Two setImmediates: the first lands in the check phase of the turn the
 * test ran in, the second only after the next poll, where the replies are read.
 */
import { afterEach } from 'vitest';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

afterEach(async () => {
  await tick();
  await tick();
});
