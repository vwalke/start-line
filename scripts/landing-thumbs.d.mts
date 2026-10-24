/** Types for scripts/landing-thumbs.mjs (the tests import its sizes, shot list and name scrub). */
export const THUMB_W: number;
export const THUMB_H: number;
export const BUDGET: { thumb: number; full: number };
/** One shot per landing card, in the cards' order (the rest of each entry is the script's own). */
export const SHOTS: readonly { slug: string; card: string }[];
export function filesOf(slug: string): { thumb: string; thumb2x: string; full: string };
/** `x` without boat names and personal fields; each removed string goes into `names` with the path it came from. */
export function scrub(x: unknown, names: Map<string, string>, path?: string): unknown;
export const NOT_NAMES: ReadonlySet<string>;
export function nameIn(text: string, name: string): boolean;
