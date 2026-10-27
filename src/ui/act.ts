/**
 * Data actions: the one look (style.css "data actions") for everything that opens or shows real data:
 * a boat in the list or a table row (selects it everywhere), a Coach card's window chip, "Show on map",
 * "Replay start", a section that opens onto data. Accent text, underlined or tinted at rest, never only on
 * hover. Controls that only change how data is shown (tabs, zoom, colour, speed, sort, ⓘ) stay quiet and
 * never take these classes.
 */

/** Inline text action ("Show on map →", "Replay start → USA 017"). */
export const ACT = 'act';
/** Pill action among the chips (a Coach card's window, the map's "Replay start"). */
export const ACT_CHIP = 'act act-chip';
/** A row that selects its boat (the boat list, the tables); its `.act-key` (the sail number) carries the look. */
export const ACT_ROW = 'act-row';
/** The part of an act row that carries the look. */
export const ACT_KEY = 'act-key';
/** A `<summary>` that opens onto data (Start Playback, a leg story, "Not racing"). */
export const ACT_MORE = 'act-more';
