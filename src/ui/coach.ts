/**
 * The Coach tab, for the race picked in the Race menu and the boat selected in the app (no
 * pickers of its own; the Regatta view is coachRegatta.ts). Phase 1: one
 * line of key-number chips with ⚠ caveats and the one ⓘ, and the rival ladder
 * — the boat's gap in seconds to a group of boats over the race at equal course
 * progress (analysis/coach/timeGap.ts; ahead up, behind down), the group's mean
 * (5 or fewer boats) or median bold and each group boat thin, roundings
 * marked, and the fleet's wind in a strip underneath on the same time axis.
 * Every line is drawn straight across any stretch without a value (ladderRuns: display only; the series the cards
 * read are untouched), as the maps bridge a tracker's holes.
 *
 * The group (Chris's "Ivan group") lives in the URL as `grp=top3|near|fleet|c:<id>,<id>`,
 * the boat as `boat=<id>`, the view as `cview=regatta`, next to the race (`event`, `div`, `race`).
 */
import { DEFAULT_GROUPS, NEAR_PLACES, type Group, type GroupKind } from '../analysis/coach/groups';
import type { CoachModel, RivalLadder } from '../analysis/coach';
import type { GapPoint } from '../analysis/coach/ladder';
import { GROUP_MEAN_MAX_BOATS, groupStatKind } from '../analysis/coach/timeGap';
import type { BoatResult, RaceAnalysis } from '../analysis/types';
import { finishRank } from '../analysis/result';
import { codeShort, codeWords } from './resultText';
import { LOW_COVERAGE, fleetOf } from '../analysis/coach/regatta';
import { boatLabel, degLabel, duration, esc, localTime, ordinal, tzLabel } from './format';
import { infoHtml, warnChip, type Chip } from './info';

export const GROUP_PARAM = 'grp';
export const BOAT_PARAM = 'boat';

/** `boat=` → a boat id; null for a missing or blank value. */
export function parseBoatParam(raw: string | null | undefined): string | null {
  const id = raw?.trim();
  return id ? id : null;
}

/**
 * The boat to highlight as a race opens. A `boat=` deep-link wins over a saved
 * lastView boat so a shared link opens that boat; an unknown id falls through.
 */
export function coachHighlight(urlBoat: string | null, savedBoat: string | null, known: Iterable<string>): string | null {
  const ids = known instanceof Set ? known : new Set(known);
  if (urlBoat && ids.has(urlBoat)) return urlBoat;
  if (savedBoat && ids.has(savedBoat)) return savedBoat;
  return null;
}

/** Below this race coverage the Regatta view marks the race low data, 0–1. */
export const COACH_LOW_COVERAGE = LOW_COVERAGE;

const GROUP_TOKEN: Record<Exclude<GroupKind, 'custom'>, string> = { leaders: 'top3', near: 'near', fleet: 'fleet' };

/** `grp=` → a group; null for a missing or unknown value. Custom ids are kept as given (unknown boats drop out per race). */
export function parseGroupParam(raw: string | null | undefined): Group | null {
  if (!raw) return null;
  for (const [kind, tok] of Object.entries(GROUP_TOKEN)) if (raw === tok) return { kind } as Group;
  if (!raw.startsWith('c:')) return null;
  const ids = [...new Set(raw.slice(2).split(',').map((s) => s.trim()).filter(Boolean))];
  return { kind: 'custom', ids };
}

/** A group → its `grp=` value (ids holding a comma can't be listed, and are left out). */
export function groupParam(g: Group): string {
  return g.kind === 'custom' ? `c:${g.ids.filter((id) => !id.includes(',')).join(',')}` : GROUP_TOKEN[g.kind];
}

export const GROUP_LABEL: Record<GroupKind, string> = { leaders: 'Top 3', near: `Boats near me (±${NEAR_PLACES})`, fleet: 'Whole fleet', custom: 'Custom' };
/** Short, for the chart's legend chip. */
const GROUP_SHORT: Record<GroupKind, string> = { leaders: 'top 3', near: 'boats near', fleet: 'fleet', custom: 'your group' };

/** The rival ladder's group when the URL names none. */
export const defaultLadderGroup = (): Group => ({ kind: DEFAULT_GROUPS.rivalLadder });

export type CoachView = 'race' | 'regatta';
/** The Coach view in the URL: `cview=regatta`; the race view needs none. */
export const VIEW_PARAM = 'cview';
export const parseCoachView = (raw: string | null | undefined): CoachView => (raw === 'regatta' ? 'regatta' : 'race');

/**
 * The boat Coach shows: the boat selected in the app (the boat list, a chart, `boat=`) when it
 * sailed this race; null otherwise (Coach then asks for one, no fallback to another boat).
 */
export const coachBoatFor = (a: Pick<RaceAnalysis, 'boats'>, selected: string | null): string | null =>
  selected && a.boats.some((b) => b.id === selected) ? selected : null;

/**
 * The Coach panel's top line, a full-width segmented control above the header card: Race (the race
 * picked in the Race menu) or Regatta (every race of the event). Race and boat are the app's own
 * selection: no picker of its own here.
 */
export function coachViewHtml(view: CoachView): string {
  const btn = (v: CoachView, label: string, sub: string, title: string): string =>
    `<button type="button" data-coach-view="${v}" aria-pressed="${view === v}" title="${esc(title)}"><span class="cv-lbl">${label}</span><span class="cv-sub">${sub}</span></button>`;
  return `<div class="seg coach-view" role="group" aria-label="Coach view">${btn('race', 'Race', 'this race', 'This race (the Race menu)')}${btn('regatta', 'Regatta', 'every race', 'Every race of the event')}</div>`;
}

/** No boat selected: where to pick one. */
export const COACH_NO_BOAT = 'Pick a boat in the boat list to coach it.';
export const coachNoBoatHtml = (): string => `<p class="muted coach-none coach-noboat">${esc(COACH_NO_BOAT)}</p>`;

/** "11:05" in the venue's clock. */
const hm = (ms: number, tz: number): string => localTime(ms, tz).slice(0, 5);

/** The header: place, gun time (venue clock), ⚠ heading from GPS course. */
export function coachChips(
  a: RaceAnalysis,
  b: BoatResult,
  atStakeS: number | null = null,
): Chip[] {
  const tz = a.meta.tzOffsetMs;
  const chips: Chip[] = [];
  const official = a.meta.results?.places === 'official';
  const placeBy = official ? 'Official place' : b.finishSource === 'tracker' ? 'Place by the tracker finish (~)' : 'Place by the tracked finish';
  if (b.finishPos != null) chips.push({ text: `${ordinal(b.finishPos)} of ${fleetOf(a)}`, title: placeBy });
  else if (b.finishCode) chips.push({ text: codeShort(b)!, title: `Official result: ${codeWords(b)}` });
  else chips.push(warnChip(official ? 'no official place' : 'no tracked finish'));
  const win = a.boats.find((x) => x.finishPos === 1);
  // Behind the winner on the water (a boat that finished with a code too).
  const rank = finishRank(b);
  if (rank != null && rank > 1 && b.finishMs != null && win?.finishMs != null && win.id !== b.id) {
    chips.push({ text: `${Math.round((b.finishMs - win.finishMs) / 1000)} s behind ${win.name && win.name !== `#${win.sail}` ? win.name : win.sail}`, title: `Finish times; ${boatLabel(win, win.id)} won` });
  }
  chips.push({ text: `gun ${hm(a.meta.gunMs, tz)}`, title: `Venue time (${tzLabel(tz)})` });
  if (atStakeS != null && atStakeS > 0) chips.push({ text: `≈ ${Math.round(atStakeS)} s at stake`, title: 'Seconds at stake over the cards below' });
  if (b.headingSource === 'cog') chips.push(warnChip('heading from GPS course', "The compass disagrees with the boat's track; angles use its course over ground"));
  return chips;
}

export const COACH_BULLETS: readonly string[] = [
  'Gap = how many seconds earlier (behind, down) or later (ahead, up) the group got as far along the course as you are now.',
  "How far along: on beats and runs, how far up (or down) the leg's wind ladder, one wind direction for the whole leg, so both tacks and gybes count alike; on reaches, distance made good along the line between the marks. A rounding counts from 30 m before the mark to 30 m down the next leg, so the lines run on through it.",
  `Bold: the group's average, always over the same boats: the mean of the boats with data when there are ${GROUP_MEAN_MAX_BOATS} or fewer, the median when there are more. Thin: each group boat. The scale fits every line for ${GROUP_MEAN_MAX_BOATS} or fewer boats; with more, a line that runs off it gets a small marker at the edge.`,
  "Wind (strip below) comes from the fleet's tacks, minute by minute, not a sensor; lighter where estimated between minutes.",
];

/** The header's chip line with the ⓘ. */
export const coachHeadHtml = (chips: Chip[], open = false): string =>
  `<ul class="chips">${chips.map(chipLi).join('')}<li class="chip-info">${infoHtml(COACH_BULLETS, { open })}</li></ul>`;

function chipLi(c: Chip): string {
  const warn = c.warn ? '<span aria-hidden="true">⚠ </span><span class="vh">Warning: </span>' : '';
  return `<li class="chip${c.warn ? ' warn' : ''}"${c.title ? ` title="${esc(c.title)}"` : ''}>${warn}${esc(c.text)}</li>`;
}

/** The group control: the presets, Custom (a list of boats to tick), and the per-boat lines toggle. */
export function coachGroupHtml(a: RaceAnalysis, boat: string | null, g: Group, each: boolean, customOpen = false): string {
  const kinds: GroupKind[] = ['leaders', 'near', 'fleet'];
  const btns = kinds.map((k) => `<button type="button" data-coach-group="${k}" aria-pressed="${g.kind === k}">${esc(GROUP_LABEL[k])}</button>`).join('');
  const ticked = new Set(g.kind === 'custom' ? g.ids : []);
  const boxes = [...a.boats]
    .filter((b) => b.id !== boat)
    .sort((p, q) => (finishRank(p) ?? 1e9) - (finishRank(q) ?? 1e9))
    .map(
      (b) =>
        `<li><label><input type="checkbox" data-coach-custom="${esc(b.id)}"${ticked.has(b.id) ? ' checked' : ''}> ${b.finishPos != null ? `${ordinal(b.finishPos)} ` : b.finishCode ? `${esc(codeShort(b)!)} ` : ''}${esc(boatLabel(b, b.id))}</label></li>`,
    )
    .join('');
  const custom = `<details class="coach-custom"${customOpen ? ' open' : ''}><summary${g.kind === 'custom' ? ' class="on"' : ''}>${esc(GROUP_LABEL.custom)}${g.kind === 'custom' ? ` (${ticked.size})` : ''}</summary><ul>${boxes}</ul></details>`;
  return `<div class="seg" role="group" aria-label="Compare with"><span class="seg-lbl" aria-hidden="true">vs</span>${btns}</div>${custom}
    <div class="seg" role="group" aria-label="Lines"><button type="button" data-coach-each aria-pressed="${each}">Each boat</button></div>`;
}

// ---- the rival ladder chart

export interface LadderLayout {
  W: number;
  /** Bottom of the wind strip (the whole SVG's height). */
  H: number;
  padL: number;
  padR: number;
  padT: number;
  /** Bottom of the gap panel. */
  gapB: number;
  /** The wind strip's top and bottom. */
  windT: number;
  windB: number;
  t0: number;
  t1: number;
  /** Seconds ahead at the top / bottom of the gap panel. */
  hi: number;
  lo: number;
  sStep: number;
  wLo: number;
  wHi: number;
  x: (tMs: number) => number;
  /** Seconds ahead (+) → y. */
  y: (aheadS: number) => number;
  yw: (deg: number) => number;
  tAt: (px: number) => number;
}

/**
 * With more than GROUP_MEAN_MAX_BOATS group boats, how far past the group line's range their own lines may stretch
 * the scale, × that range (the rest is clipped and marked at the edge). With fewer, the scale fits every line.
 */
export const EACH_HEADROOM = 0.5;
/** Palette slots for the group's own lines; the group line stays black. */
export const LADDER_COLOR_SLOTS = 8;

/** One stable colour per group boat for the whole chart (finish order, not the current leg). */
export function ladderBoatColor(id: string, group: readonly string[]): string {
  const i = group.indexOf(id);
  return `var(--s${((i >= 0 ? i : 0) % LADDER_COLOR_SLOTS) + 1})`;
}

/** Legend label: "USA 328 Mirage", or the sail when that is the name. */
export function coachLegendName(b: { sail: string; name: string }): string {
  return b.name && b.name !== `#${b.sail}` ? `${b.sail} ${b.name}` : b.sail;
}

export interface LegSpan {
  name: string;
  fromMs: number;
  toMs: number;
  leg: number;
}

/**
 * One span per course leg, from the gun through the chosen boat's roundings to
 * the chart end (its finish, or last fix). Missing roundings stretch the
 * neighbouring span — those identical or overlapping stretches are merged into
 * one label when drawn (`mergeLadderLegLabels`).
 */
export function ladderLegSpans(legs: readonly { name: string }[], gunMs: number, roundings: readonly { tMs: number; leg: number }[], endMs: number): LegSpan[] {
  const n = legs.length;
  if (!n) return [];
  const edge: (number | null)[] = Array.from({ length: n + 1 }, () => null);
  edge[0] = gunMs;
  edge[n] = Math.max(endMs, gunMs);
  for (const r of roundings) {
    if (r.leg > 0 && r.leg < n) edge[r.leg] = r.tMs;
  }
  const known = (k: number, dir: -1 | 1): number => {
    for (let i = k; i >= 0 && i <= n; i += dir) if (edge[i] != null) return edge[i]!;
    return dir < 0 ? gunMs : edge[n]!;
  };
  return legs.map((leg, k) => ({ name: leg.name, fromMs: known(k, -1), toMs: known(k + 1, 1), leg: k }));
}

const spansOverlap = (a: Pick<LegSpan, 'fromMs' | 'toMs'>, b: Pick<LegSpan, 'fromMs' | 'toMs'>): boolean =>
  a.fromMs < b.toMs && b.fromMs < a.toMs;

/**
 * Legs that share a span (no known rounding between them — a data hole, or
 * none at all) become one label, e.g. `Beat 1 – Run 2`. Adjacent but distinct
 * spans stay separate.
 */
export function mergeLadderLegLabels(spans: readonly LegSpan[]): LegSpan[] {
  const groups: { span: LegSpan; names: string[] }[] = [];
  for (const s of spans) {
    const prev = groups[groups.length - 1];
    if (prev && spansOverlap(prev.span, s)) {
      prev.span.fromMs = Math.min(prev.span.fromMs, s.fromMs);
      prev.span.toMs = Math.max(prev.span.toMs, s.toMs);
      prev.names.push(s.name);
    } else {
      groups.push({ span: { ...s }, names: [s.name] });
    }
  }
  return groups.map((g) => ({
    ...g.span,
    name: g.names.length === 1 ? g.names[0] : `${g.names[0]} – ${g.names[g.names.length - 1]}`,
  }));
}

const niceStep = (span: number): number => [5, 10, 15, 30, 60, 120, 300].find((s) => span / s <= 6) ?? 600;

/** Geometry for `ladder` at `widthPx`: the gap panel with zero always in view, a wind strip under it. */
export function ladderLayout(ladder: RivalLadder, wind: { twdAt: (t: number) => number }, gunMs: number, widthPx = 720, each = true): LadderLayout {
  const W = Math.max(300, Math.round(widthPx));
  const narrow = W < 520;
  const padL = narrow ? 40 : 46;
  const padR = 12;
  const padT = narrow ? 20 : 22;
  const gapH = narrow ? 200 : 250;
  const gapB = padT + gapH;
  const windT = gapB + 34;
  const windB = windT + (narrow ? 52 : 60);
  const H = windB + 22;
  const t0 = gunMs;
  const t1 = Math.max(gunMs + 60_000, ladder.points.length ? ladder.points[ladder.points.length - 1].tMs : gunMs + 60_000);
  // Zero, the group line and, with `each`, the group boats' own lines. Up to GROUP_MEAN_MAX_BOATS boats every line
  // fits, padded a little; with more, they widen the group line's range by at most EACH_HEADROOM of it, then clip.
  const ref: number[] = [0];
  const own: number[] = [];
  for (const p of ladder.points) {
    if (p.behindS != null) ref.push(-p.behindS);
    if (each) for (const e of p.each) if (e != null) own.push(-e);
  }
  const mHi = Math.max(...ref);
  const mLo = Math.min(...ref);
  let hi = Math.max(mHi, ...own);
  let lo = Math.min(mLo, ...own);
  if (ladder.group.length <= GROUP_MEAN_MAX_BOATS) {
    const pad = own.length ? Math.max(0.05 * (hi - lo), 3) : 0;
    hi += pad;
    lo -= pad;
  } else {
    const room = EACH_HEADROOM * Math.max(mHi - mLo, 60);
    hi = Math.min(hi, mHi + room);
    lo = Math.max(lo, mLo - room);
  }
  const sStep = niceStep(Math.max(hi - lo, 20));
  hi = Math.ceil((hi + 1e-9) / sStep) * sStep;
  lo = Math.floor((lo - 1e-9) / sStep) * sStep;
  const ws: number[] = [];
  const w0 = wind.twdAt(t0);
  // Unwrapped about the gun's wind so 355° → 5° is +10°, not −350°.
  for (let t = t0; t <= t1; t += 60_000) ws.push(w0 + ((((wind.twdAt(t) - w0 + 180) % 360) + 360) % 360) - 180);
  let wLo = Math.floor(Math.min(...ws) / 5) * 5;
  let wHi = Math.ceil(Math.max(...ws) / 5) * 5;
  if (wHi - wLo < 10) {
    const m = (wHi + wLo) / 2;
    wLo = Math.floor((m - 5) / 5) * 5;
    wHi = wLo + 10;
  }
  const pw = W - padL - padR;
  const x = (t: number): number => padL + ((t - t0) / (t1 - t0)) * pw;
  const y = (s: number): number => padT + ((hi - s) / (hi - lo)) * gapH;
  const yw = (d: number): number => windT + ((wHi - d) / (wHi - wLo)) * (windB - windT);
  const tAt = (px: number): number => Math.min(t1, Math.max(t0, t0 + ((px - padL) / pw) * (t1 - t0)));
  return { W, H, padL, padR, padT, gapB, windT, windB, t0, t1, hi, lo, sStep, wLo, wHi, x, y, yw, tAt };
}

const r1 = (v: number): string => v.toFixed(1);

/**
 * The points a line is drawn through, as indices: every one with a value, joined straight across any stretch without
 * one (display only: the series and what the cards read are untouched); one run, or none.
 */
export function ladderRuns(pts: readonly { tMs: number }[], val: (i: number) => number | null): number[][] {
  const run = pts.flatMap((_, i) => (val(i) == null ? [] : [i]));
  return run.length ? [run] : [];
}

/** A line's runs (ladderRuns) as SVG path data. */
function runsPath(pts: { tMs: number }[], val: (i: number) => number | null, L: LadderLayout): string {
  return ladderRuns(pts, val)
    .map((run) => run.map((i, k) => `${k ? 'L' : 'M'}${r1(L.x(pts[i].tMs))} ${r1(L.y(val(i)!))}`).join(''))
    .join('');
}

/**
 * Where group boat `k`'s thin line leaves the gap panel: the x it crosses the top or bottom, one per exit (a stretch
 * without a value while it is off the panel is not a new one), skipping one within 6 px of the last at that edge.
 */
function clipMarks(pts: readonly { tMs: number; each: (number | null)[] }[], k: number, L: LadderLayout): { x: number; top: boolean }[] {
  const out: { x: number; top: boolean }[] = [];
  const lastX = { top: -Infinity, bottom: -Infinity };
  const edge = (v: number): 'top' | 'bottom' | null => (v > L.hi ? 'top' : v < L.lo ? 'bottom' : null);
  let was: 'top' | 'bottom' | null = null;
  let prev: { tMs: number; v: number } | null = null;
  for (const p of pts) {
    const e = p.each[k];
    if (e == null) continue;
    const v = -e;
    const now = edge(v);
    if (now && now !== was) {
      const lim = now === 'top' ? L.hi : L.lo;
      const x = L.x(prev ? prev.tMs + ((p.tMs - prev.tMs) * (lim - prev.v)) / (v - prev.v) : p.tMs);
      if (x - lastX[now] >= 6) out.push({ x, top: now === 'top' });
      lastX[now] = x;
    }
    was = now;
    prev = { tMs: p.tMs, v };
  }
  return out;
}

/** "45 s ahead", "12 s behind", "level". */
export const gapWords = (behindS: number): string => {
  const s = Math.round(Math.abs(behindS));
  return s === 0 ? 'level' : `${s} s ${behindS > 0 ? 'behind' : 'ahead'}`;
};

export interface LadderOptions {
  widthPx?: number;
  each?: boolean;
  /** Shade these windows (ms): the selected opportunity card's. */
  highlight?: readonly [number, number][];
}

/** The chart as SVG. */
export function ladderChart(a: RaceAnalysis, m: CoachModel, ladder: RivalLadder, g: Group, opts: LadderOptions = {}): string {
  const each = opts.each ?? true;
  if (!ladder.group.length) {
    return `<p class="muted coach-none">${g.kind === 'custom' ? 'Tick boats under Custom to compare with.' : 'No boats in this group for this race.'}</p>`;
  }
  if (!ladder.points.some((p) => p.behindS != null)) return `<p class="muted coach-none">No stretch where this boat and the group were tracked at the same point of the course.</p>`;
  const L = ladderLayout(ladder, m.wind, a.meta.gunMs, opts.widthPx, each);
  const tz = a.meta.tzOffsetMs;
  const fs = L.W < 520 ? 11 : 12;
  const out: string[] = [];
  // The selected card's window(s), across both panels.
  for (const [p, q] of opts.highlight ?? []) {
    const a0 = Math.max(L.t0, p);
    const b0 = Math.min(L.t1, q);
    if (!(b0 >= a0)) continue;
    const x0 = L.x(a0);
    out.push(`<rect class="cl-hl" x="${r1(x0 - (b0 === a0 ? 1.5 : 0))}" y="${L.padT}" width="${r1(Math.max(3, L.x(b0) - x0))}" height="${L.windB - L.padT}"><title>${hm(p, tz)}–${hm(q, tz)}</title></rect>`);
  }
  // Gap gridlines: + ahead above zero, − behind below.
  for (let s = L.lo; s <= L.hi + 1e-9; s += L.sStep) {
    const y = r1(L.y(s));
    out.push(`<line class="${s === 0 ? 'cl-zero' : 'cl-grid'}" x1="${L.padL}" x2="${L.W - L.padR}" y1="${y}" y2="${y}"/>`);
    out.push(`<text class="cl-axis" x="${L.padL - 5}" y="${r1(L.y(s) + fs * 0.35)}" font-size="${fs}" text-anchor="end">${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s)}</text>`);
  }
  out.push(`<text class="cl-dir" x="${L.padL + 4}" y="${L.padT + fs}" font-size="${fs}">▲ s ahead</text>`);
  out.push(`<text class="cl-dir" x="${L.padL + 4}" y="${L.gapB - 5}" font-size="${fs}">▼ s behind</text>`);
  // Time: venue clock every 5 / 10 / 15 min, across both panels.
  const spanMin = (L.t1 - L.t0) / 60_000;
  const tick = spanMin <= 40 ? 5 : spanMin <= 90 ? 10 : 15;
  const first = Math.ceil((L.t0 + tz) / (tick * 60_000)) * tick * 60_000 - tz;
  for (let t = first; t <= L.t1; t += tick * 60_000) {
    const x = r1(L.x(t));
    out.push(`<line class="cl-tick" x1="${x}" x2="${x}" y1="${L.padT}" y2="${L.windB}"/>`);
    out.push(`<text class="cl-axis" x="${x}" y="${L.windB + fs + 4}" font-size="${fs}" text-anchor="middle">${hm(t, tz)}</text>`);
  }
  // Roundings: plain dashed separators. Legs are labelled in the segment, not the mark.
  for (const r of ladder.roundings) {
    const x = r1(L.x(r.tMs));
    out.push(`<line class="cl-mark" x1="${x}" x2="${x}" y1="${L.padT - 4}" y2="${L.windB}"><title>${esc(a.legs[r.leg - 1]?.to ?? 'Mark')} ${hm(r.tMs, tz)}</title></line>`);
  }
  for (const s of mergeLadderLegLabels(ladderLegSpans(a.legs, L.t0, ladder.roundings, L.t1))) {
    const x = (L.x(s.fromMs) + L.x(s.toMs)) / 2;
    out.push(`<text class="cl-leg-lbl" data-leg="${s.leg}" x="${r1(x)}" y="${L.padT - 6}" font-size="${fs - 1}" text-anchor="middle">${esc(s.name)}</text>`);
  }
  // The group line, bold black, then each group boat, thin, one colour for the whole race, on top (clipped to the panel):
  // a boat that is on the group line (the middle of a large odd group) runs along it instead of vanishing under it.
  const clip = `cl-clip-${Math.round(L.W)}`;
  out.push(`<clipPath id="${clip}"><rect x="${L.padL}" y="${L.padT}" width="${L.W - L.padL - L.padR}" height="${L.gapB - L.padT}"/></clipPath><g clip-path="url(#${clip})">`);
  const med = runsPath(ladder.points, (i) => (ladder.points[i].behindS == null ? null : -ladder.points[i].behindS!), L);
  out.push(`<path class="cl-med" d="${med}"/>`);
  const byId = new Map(a.boats.map((b) => [b.id, b]));
  if (each) {
    ladder.group.forEach((id, k) => {
      const b = byId.get(id);
      const d = runsPath(ladder.points, (i) => (ladder.points[i].each[k] == null ? null : -ladder.points[i].each[k]!), L);
      if (d && b) {
        out.push(`<path class="cl-each" data-boat="${esc(id)}" d="${d}" stroke="${ladderBoatColor(id, ladder.group)}"><title>${esc(boatLabel(b, id))}</title></path>`);
      }
    });
  }
  out.push(`</g>`);
  // A small caret in the boat's colour where its thin line runs off the panel (only a group over GROUP_MEAN_MAX_BOATS clips).
  if (each) {
    ladder.group.forEach((id, k) => {
      for (const c of clipMarks(ladder.points, k, L)) {
        const tip = c.top ? L.padT : L.gapB;
        const base = c.top ? tip + 5 : tip - 5;
        out.push(`<path class="cl-clip-mark" data-boat="${esc(id)}" d="M${r1(c.x - 3.5)} ${base}L${r1(c.x + 3.5)} ${base}L${r1(c.x)} ${tip}Z" fill="${ladderBoatColor(id, ladder.group)}"/>`);
      }
    });
  }
  // A lone point (a run of one) as a dot so it doesn't vanish.
  for (const run of ladderRuns(ladder.points, (i) => ladder.points[i].behindS)) {
    if (run.length > 1) continue;
    const p = ladder.points[run[0]];
    out.push(`<circle class="cl-dot" cx="${r1(L.x(p.tMs))}" cy="${r1(L.y(-p.behindS!))}" r="2.5"/>`);
  }
  // Wind strip.
  out.push(`<text class="cl-unit" x="${L.padL}" y="${L.windT - 6}" font-size="${fs - 1}">Wind from, ° (fleet est.)</text>`);
  for (const d of [L.wLo, L.wHi]) {
    out.push(`<line class="cl-grid" x1="${L.padL}" x2="${L.W - L.padR}" y1="${r1(L.yw(d))}" y2="${r1(L.yw(d))}"/>`);
    out.push(`<text class="cl-axis" x="${L.padL - 5}" y="${r1(L.yw(d) + fs * 0.35)}" font-size="${fs}" text-anchor="end">${degLabel(d)}</text>`);
  }
  const w0 = m.wind.twdAt(L.t0);
  const unwrap = (t: number): number => w0 + ((((m.wind.twdAt(t) - w0 + 180) % 360) + 360) % 360) - 180;
  const seg = (ok: boolean): string => {
    let d = '';
    m.wind.t.forEach((t, i) => {
      if (t < L.t0 || t > L.t1) return;
      const both = ok ? m.wind.ok[i] && m.wind.ok[i + 1] : !(m.wind.ok[i] && m.wind.ok[i + 1]);
      const t2 = m.wind.t[i + 1];
      if (!both || t2 == null || t2 > L.t1) return;
      d += `M${r1(L.x(t))} ${r1(L.yw(unwrap(t)))}L${r1(L.x(t2))} ${r1(L.yw(unwrap(t2)))}`;
    });
    return d;
  };
  // Wind estimated between minutes: the same line, lighter (style.css .cl-wind.est).
  out.push(`<path class="cl-wind" d="${seg(true)}"/><path class="cl-wind est" d="${seg(false)}"/>`);
  const me = byId.get(ladder.boat);
  const aria = `${me ? boatLabel(me, me.id) : ladder.boat}: seconds ahead or behind ${GROUP_SHORT[g.kind]} over the race, with the wind direction below.`;
  return `<svg viewBox="0 0 ${L.W} ${L.H}" width="${L.W}" height="${L.H}" class="chart coach-ladder" role="img" aria-label="${esc(aria)}">
    <g>${out.join('')}</g><line class="cl-hair" x1="0" x2="0" y1="${L.padT}" y2="${L.windB}" visibility="hidden"/></svg>`;
}

/** The readout under the pointer: the nearest point in time with a group value (within `reachMs`) and the wind then. */
export function ladderHover(ladder: RivalLadder, L: LadderLayout, px: number, reachMs = 30_000): { i: number; tMs: number } | null {
  const t = L.tAt(px);
  let best = -1;
  let bd = reachMs;
  ladder.points.forEach((p, i) => {
    if (p.behindS == null) return;
    const d = Math.abs(p.tMs - t);
    if (d <= bd) {
      bd = d;
      best = i;
    }
  });
  return best < 0 ? null : { i: best, tMs: ladder.points[best].tMs };
}

/** "mean of 3 boats", "median of 8 boats": the group line's statistic and the boats in it. */
export const boatsCount = (p: Pick<GapPoint, 'n'>): string => `${groupStatKind(p.n)} of ${p.n} boat${p.n === 1 ? '' : 's'}`;

/**
 * The legend's name for the group line: "mean" or "median" when every drawn point uses it, "mean / median" when it
 * changes during the race; with nothing drawn, what the whole group (`groupSize` boats) would use.
 */
export function ladderStatLabel(points: readonly Pick<GapPoint, 'n' | 'behindS'>[], groupSize: number): string {
  const kinds = new Set(points.filter((p) => p.behindS != null).map((p) => groupStatKind(p.n)));
  return kinds.size > 1 ? 'mean / median' : ([...kinds][0] ?? groupStatKind(groupSize));
}

/** The tooltip's HTML for point `i`. */
export function ladderTipHtml(a: RaceAnalysis, m: CoachModel, ladder: RivalLadder, g: Group, i: number): string {
  const p = ladder.points[i];
  const tz = a.meta.tzOffsetMs;
  const head = `<b>${localTime(p.tMs, tz)}</b> <span class="muted">(gun +${duration((p.tMs - a.meta.gunMs) / 1000)})</span>`;
  const gap = p.behindS == null ? '' : `<b>${gapWords(p.behindS)}</b> of ${GROUP_SHORT[g.kind]} <span class="muted">(${boatsCount(p)})</span><br>`;
  const leg = p.leg != null ? `<br><span class="muted">${esc(a.legs[p.leg]?.name ?? '')}</span>` : '';
  return `${head}<br>${gap}Wind ${degLabel(m.wind.twdAt(p.tMs))}${leg}`;
}

/** The chart's legend chips: the bold group line (mean or median), each group boat by name and colour. */
export function ladderChips(a: RaceAnalysis, ladder: RivalLadder, g: Group, each: boolean): Chip[] {
  const me = a.boats.find((b) => b.id === ladder.boat);
  const chips: Chip[] = [
    {
      text: `${me ? `#${me.sail}` : ladder.boat} vs ${GROUP_SHORT[g.kind]} (${ladderStatLabel(ladder.points, ladder.group.length)})`,
      swatch: 'bold',
      title: `The mean of the boats with data when there are ${GROUP_MEAN_MAX_BOATS} or fewer, the median when there are more`,
    },
  ];
  if (each) {
    const byId = new Map(a.boats.map((b) => [b.id, b]));
    for (const id of ladder.group) {
      const b = byId.get(id);
      chips.push({
        text: b ? (ladder.group.length > 6 ? b.sail : coachLegendName(b)) : id,
        swatch: 'line',
        swatchColor: ladderBoatColor(id, ladder.group),
        title: boatLabel(b, id),
      });
    }
  }
  return chips;
}
