/**
 * Placeholder for a future .vkx upload source (Vakaros Atlas log files,
 * spec: https://github.com/vakaros/vkx). NOT IMPLEMENTED in v1.
 *
 * The plan: parse the binary log in the worker (position/velocity/orientation
 * rows → one `Track`; "line position" rows → `startLine`; race-timer events
 * → `gunMs`), let the user add or confirm marks/finish, and hand the result
 * to `analyzeRace` exactly like the RaceSense adapter does. A single-boat
 * upload gives start metrics and legs but no fleet comparison or tack-based
 * wind from other boats, so it would combine with a RaceSense race when one
 * exists, or fall back to model wind.
 */
import type { RaceData } from './types';

export interface VkxUploadOptions {
  /** Optional sail number to label the uploaded boat. */
  sail?: string;
  /** Marks/finish the user supplied, when the log has none. */
  overrides?: Partial<Pick<RaceData, 'course' | 'finishLine' | 'gunMs' | 'startLine'>>;
}

/** Contract for the future adapter: bytes in, normalized RaceData out. */
export type VkxAdapter = (bytes: ArrayBuffer, opts?: VkxUploadOptions) => Promise<RaceData>;

export const parseVkx: VkxAdapter = async () => {
  throw new Error('.vkx upload is not supported yet');
};
