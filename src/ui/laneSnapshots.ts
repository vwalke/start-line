/**
 * The Start tab's "Lane snapshots" (Chris): the fleet at gun −60 s, +60 s and +120 s, each boat a dot with
 * its trail back to the frame before (the first from LANE_FIRST_FROM_S), so a coach can see whether a
 * boat held its lane off the line. Pure: frames → boats, trails, captions; ui/laneSnapshotsView.ts draws them.
 *
 * Positions are the scrubber's (mapPieces.ts boatAt): linear between fixes, held hollow for MAP_HOLD_S inside
 * a gap, else none (the boat is missing in that frame, never placed). Trails come from the same drawn tracks
 * (the pre-gun track and the legs), broken wherever consecutive fixes are a gap apart (mapPoints.ts's rule).
 *
 * The view is wind-up (the analysis's wind at the gun, as the start chart) and shared by the three frames.
 * "Over": a boat over early (StartReplay, the worker's startCross facts, as Map C) is over at a frame at or
 * after the gun until its clearing (clearedMs; never cleared: still over); a frame whose trail spans its
 * clearing says when it cleared. Before the gun nobody is over yet: a boat whose antenna is on the course
 * side of the line then is marked "above the line" instead.
 */
import { dot, len, sub, type Vec } from '../analysis/geo';
import type { StartReplay } from '../analysis/startReplay';
import type { RaceAnalysis } from '../analysis/types';
import { ordinal } from './format';
import { boatAt, legRanges, lowerBound, rotator, rotTrack, timeRange, type LegRange } from './mapPieces';
import { drawingGapMs } from './mapPoints';
import { gunRel } from './scrub';
import type { Box } from './view';

/** The frames, s from the gun. */
export const LANE_FRAMES_S = [-60, 60, 120] as const;
/** The first frame's trail starts here, s from the gun (or where the data does). */
export const LANE_FIRST_FROM_S = -90;
/** The shared view takes in boats this far from the line's middle, at most: max(LANE_REACH_LINES × the line, LANE_REACH_MIN_M). */
export const LANE_REACH_LINES = 3;
export const LANE_REACH_MIN_M = 600;
/** The view's padding: this share of its size each way, and at least LANE_PAD_M. */
const LANE_PAD = 0.08;
const LANE_PAD_M = 20;
/** Outside its track (before the first fix, after the last), a boat is placed at its end fix when that is this close in time, ms (a feed that starts at −59.9 s). */
export const LANE_SNAP_MS = 1000;

/** Boat `id` at `t`: the scrubber's position (boatAt), else its track's end fix within LANE_SNAP_MS; east/north and map coordinates. */
function placeAt(id: string, ranges: readonly LegRange[], t: number, gapMs: number, twd: number): { x: number; y: number; mx: number; my: number; hold: boolean } | null {
  const at = boatAt(id, ranges, t, gapMs, twd);
  if (at) return at;
  let best: { i: number; r: LegRange; dt: number } | null = null;
  for (const r of ranges) {
    if (r.hi <= r.lo) continue;
    const j = lowerBound(r.src.t, t, r.lo, r.hi);
    for (const i of [j - 1, j]) {
      if (i < r.lo || i >= r.hi) continue;
      const dt = Math.abs(r.src.t[i] - t);
      if (dt <= LANE_SNAP_MS && (!best || dt < best.dt)) best = { i, r, dt };
    }
  }
  if (!best) return null;
  const rot = rotTrack(twd, best.r.src);
  return { x: best.r.src.x[best.i], y: best.r.src.y[best.i], mx: rot.x[best.i], my: rot.y[best.i], hold: false };
}

export type LaneRole = 'me' | 'group' | 'other';
export type LaneThird = 'pin' | 'middle' | 'rc';
export type LaneOver = 'over' | 'cleared' | null;

export interface LaneBoat {
  id: string;
  sail: string;
  /** Map coordinates (wind-up, y down) at the frame's time; null: no fix near enough (missing in this frame). */
  pos: Vec | null;
  /** In a gap, held at the fix before it (drawn hollow). */
  hold: boolean;
  /** The boat has a track (any fix) in the race; false: never tracked. */
  tracked: boolean;
  /** The trail since the frame before, map coordinates, one polyline per stretch without a gap. */
  trail: Vec[][];
  role: LaneRole;
  /** OCS at the frame's time (at or after the gun, until clearedMs); 'cleared': cleared since the frame before. */
  over: LaneOver;
  /** The clearing time (ms) when `over` is 'cleared'. */
  clearedMs: number | null;
  /** Before the gun, the antenna on the course side of the line. */
  courseSide: boolean;
  /** Across the line, 0 at the pin and 1 at the RC end (projected along the line; may run past either end). */
  across: number | null;
  third: LaneThird | null;
  /** Approximate distance still to go toward the first mark, along the course axis (line middle → mark), m. */
  toMarkM: number | null;
  /** 1 = nearest the first mark by `toMarkM`, of the boats placed in this frame (approximate). */
  rank: number | null;
}

export interface LaneFrame {
  /** Gun-relative seconds and the race time, ms. */
  s: number;
  t: number;
  /** The trail starts here, ms. */
  from: number;
  /** "gun −1:00". */
  title: string;
  boats: LaneBoat[];
  /** No boat has a position or a trail (e.g. no data before the gun). */
  empty: boolean;
  /** Boats with no position in this frame (sail numbers). */
  missing: string[];
  /** Placed boats (for "of n"). */
  placed: number;
  caption: string;
  /** The frame's accessible description. */
  label: string;
}

export interface LaneSnapshots {
  frames: LaneFrame[];
  /** The start line's pin and RC ends, map coordinates. */
  line: [Vec, Vec];
  /** The first mark, map coordinates; and the unit direction from the line's middle toward it. */
  mark: Vec | null;
  markName: string;
  markDir: Vec | null;
  /** The shared view, map coordinates. */
  view: Box;
  /** Wind at the top (else north-up). */
  windUp: boolean;
  /** A small note on the orientation ("wind assumed from the course", "north up: no wind estimate"); null when plain. */
  note: string | null;
  me: string | null;
}

export interface LaneOptions {
  /** The selected boat; null: none (no highlight). */
  me: string | null;
  /** Its comparison group (Coach's), never including `me`. */
  group?: readonly string[];
  /** The over-early boats' facts (the worker's); null: not in yet. */
  replays?: readonly StartReplay[] | null;
}

/** Where along the line (0 pin … 1 RC) falls into which third. */
export const thirdOf = (across: number): LaneThird => (across < 1 / 3 ? 'pin' : across < 2 / 3 ? 'middle' : 'rc');

const THIRD_TEXT: Record<LaneThird, string> = { pin: 'pin third', middle: 'middle third', rc: 'RC third' };

/** "middle third (48% from pin)", "past the pin end (by 8% of the line)", "past the RC end (by 41% of the line)". */
export function laneText(across: number): string {
  const pc = (x: number): number => Math.round(x * 100);
  if (across < 0) return `past the pin end (by ${pc(-across)}% of the line)`;
  if (across > 1) return `past the RC end (by ${pc(across - 1)}% of the line)`;
  return `${THIRD_TEXT[thirdOf(across)]} (${pc(across)}% from pin)`;
}

/** The first mark: the legs' first turn, else the first mark rounded; null with neither. */
function firstMark(a: Pick<RaceAnalysis, 'legPts' | 'marks' | 'legs'>): { xy: Vec; name: string } | null {
  const p = a.legPts?.[1];
  const name = a.legs[0]?.to && a.legs[0].to !== 'Finish' ? a.legs[0].to : 'first mark';
  if (p && a.legPts!.length > 2) return { xy: p, name };
  const m = a.marks[0]?.xy[0];
  return m ? { xy: m, name: a.marks[0].name || name } : p ? { xy: p, name } : null;
}

/** A boat's trail over [from, to]: its drawn fixes there (map coordinates), with its position at both ends where it has one, broken at gaps. */
function trailOf(a: RaceAnalysis, id: string, twd: number, from: number, to: number): Vec[][] {
  const d = a.drawings.find((x) => x.id === id);
  if (!d) return [];
  const gapMs = drawingGapMs(d);
  const ranges = legRanges(d, true);
  const pts: { t: number; p: Vec }[] = [];
  const start = boatAt(id, ranges, from, gapMs, twd);
  if (start && !start.hold) pts.push({ t: from, p: [start.mx, start.my] });
  for (const r of ranges) {
    const [i0, i1] = timeRange(r.src.t, from, to, r.lo, r.hi);
    const rot = rotTrack(twd, r.src);
    for (let i = i0; i < i1; i++) {
      const t = r.src.t[i];
      // Ranges share a fix where one leg ends and the next begins: keep it once.
      if (pts.length && t <= pts[pts.length - 1].t) continue;
      pts.push({ t, p: [rot.x[i], rot.y[i]] });
    }
  }
  const end = boatAt(id, ranges, to, gapMs, twd);
  if (end && !end.hold && (!pts.length || pts[pts.length - 1].t < to)) pts.push({ t: to, p: [end.mx, end.my] });
  const out: Vec[][] = [];
  let cur: Vec[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && pts[i].t - pts[i - 1].t > gapMs) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
    cur.push(pts[i].p);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** "USA 017 over", "USA 017 cleared +26 s". */
const plusS = (ms: number, gun: number): string => {
  const s = Math.round((ms - gun) / 1000);
  return `${s < 0 ? '−' : '+'}${Math.abs(s)} s`;
};

/** A list of sail numbers, the first few then "+n more". */
function sails(xs: readonly string[], max = 4): string {
  return xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} +${xs.length - max} more`;
}

/**
 * The frame's caption: the selected boat's lane and its approximate place toward the mark; who is over; who isn't tracked
 * (the selected boat said once, in its own words). `firstFix`: the fleet's earliest fix, ms (null: none).
 */
function frameCaption(f: Omit<LaneFrame, 'caption' | 'label'>, me: string | null, gun: number, markName: string, firstFix: number | null): string {
  if (f.empty) {
    if (f.t >= gun) return 'No tracks at this time.';
    return firstFix != null && firstFix > f.t && firstFix < gun ? `Tracking starts at ${gunRel(firstFix, gun)}.` : 'No data before the gun.';
  }
  const parts: string[] = [];
  const mine = me != null ? f.boats.find((b) => b.id === me) : undefined;
  if (mine) {
    if (!mine.tracked) parts.push(`${mine.sail}: not tracked.`);
    else if (!mine.pos) parts.push(`${mine.sail}: no position (tracker gap).`);
    else {
      const lane = mine.across != null ? laneText(mine.across) : '';
      const rank = mine.rank != null ? `≈ ${ordinal(mine.rank)} of ${f.placed} toward ${markName}` : '';
      parts.push(`${mine.sail}: ${[lane, rank].filter(Boolean).join(' · ')}${mine.hold ? ' (last fix)' : ''}.`);
    }
  }
  const over = f.boats.filter((b) => b.over === 'over').map((b) => b.sail);
  const cleared = f.boats.filter((b) => b.over === 'cleared').map((b) => `${b.sail} ${plusS(b.clearedMs!, gun)}`);
  const above = f.boats.filter((b) => b.courseSide).map((b) => b.sail);
  if (over.length) parts.push(`Over (OCS): ${sails(over)}.`);
  if (cleared.length) parts.push(`OCS, cleared: ${sails(cleared)}.`);
  if (above.length) parts.push(`Above the line: ${sails(above)}.`);
  const missing = f.boats.filter((b) => !b.pos && b !== mine).map((b) => b.sail);
  if (missing.length) parts.push(`Not tracked: ${sails(missing)}.`);
  return parts.join(' ');
}

/** The view: the line, the boats placed in any frame (near the start only), the mark if near; padded, shared by all frames. */
function laneView(line: [Vec, Vec], mark: Vec | null, pts: readonly Vec[], reach: number): Box {
  const mid: Vec = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = ([x, y]: Vec): void => {
    box.x0 = Math.min(box.x0, x);
    box.x1 = Math.max(box.x1, x);
    box.y0 = Math.min(box.y0, y);
    box.y1 = Math.max(box.y1, y);
  };
  grow(line[0]);
  grow(line[1]);
  for (const p of pts) if (len(sub(p, mid)) <= reach) grow(p);
  const markIn = !!mark && len(sub(mark, mid)) <= reach;
  if (markIn) grow(mark);
  const size = Math.max(box.x1 - box.x0, box.y1 - box.y0);
  const pad = Math.max(LANE_PAD_M, LANE_PAD * size);
  const out = { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
  // A mark out of reach is an arrow at the frame's edge: room for it beyond the boats, on its side.
  if (mark && !markIn) {
    const v = sub(mark, mid);
    const l = len(v);
    const room = LANE_ARROW_ROOM * size;
    if (l > 0) {
      if (v[0] / l > 0.5) out.x1 += room;
      if (v[0] / l < -0.5) out.x0 -= room;
      if (v[1] / l > 0.5) out.y1 += room;
      if (v[1] / l < -0.5) out.y0 -= room;
    }
  }
  return out;
}
/** Room for the first mark's arrow, as a share of the view's size. */
const LANE_ARROW_ROOM = 0.12;

/** The three lane snapshots of race `a` for the selected boat and its group. */
export function laneSnapshots(a: RaceAnalysis, o: LaneOptions): LaneSnapshots {
  const gun = a.meta.gunMs;
  const windUp = Number.isFinite(a.wind.twdAtGunDeg);
  const twd = windUp ? a.wind.twdAtGunDeg : 0;
  const rot = rotator(twd);
  const { left, right } = a.line;
  const lineM = len(sub(right, left));
  const alongU: Vec | null = lineM > 0 ? [(right[0] - left[0]) / lineM, (right[1] - left[1]) / lineM] : null;
  const mid: Vec = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
  const fm = firstMark(a);
  const axisL = fm ? len(sub(fm.xy, mid)) : 0;
  const axis: Vec | null = fm && axisL > 0 ? [(fm.xy[0] - mid[0]) / axisL, (fm.xy[1] - mid[1]) / axisL] : null;
  // The course side: the line's normal toward the mark.
  let side: Vec | null = null;
  if (alongU && axis) {
    const n: Vec = [-alongU[1], alongU[0]];
    side = dot(axis, n) < 0 ? [-n[0], -n[1]] : n;
  }
  const group = new Set(o.group ?? []);
  const repOf = new Map((o.replays ?? []).map((r) => [r.boat, r]));
  const drawn = new Map(a.drawings.map((d) => [d.id, d]));
  // Who has any fix at all, and the fleet's earliest fix (for an empty pre-gun frame's caption).
  const tracked = new Set<string>();
  let firstFix: number | null = null;
  for (const d of a.drawings) {
    for (const r of legRanges(d, true)) {
      if (r.hi <= r.lo) continue;
      tracked.add(d.id);
      if (firstFix == null || r.src.t[r.lo] < firstFix) firstFix = r.src.t[r.lo];
    }
  }
  const frames: LaneFrame[] = [];
  const allPts: Vec[] = [];
  let prev = gun + LANE_FIRST_FROM_S * 1000;
  for (const s of LANE_FRAMES_S) {
    const t = gun + s * 1000;
    const from = prev;
    const boats: LaneBoat[] = a.boats.map((b) => {
      const d = drawn.get(b.id);
      const at = d ? placeAt(b.id, legRanges(d, true), t, drawingGapMs(d), twd) : null;
      const pos: Vec | null = at ? [at.mx, at.my] : null;
      const en: Vec | null = at ? [at.x, at.y] : null;
      const across = en && alongU ? dot(sub(en, left), alongU) / lineM : null;
      const r = repOf.get(b.id);
      let over: LaneOver = null;
      if (r && t >= gun) {
        if (r.clearedMs == null || t < r.clearedMs) over = 'over';
        else if (r.clearedMs > from) over = 'cleared';
      }
      if (pos) allPts.push(pos);
      return {
        id: b.id,
        sail: b.sail,
        pos,
        hold: !!at?.hold,
        tracked: tracked.has(b.id),
        trail: d ? trailOf(a, b.id, twd, from, t) : [],
        role: b.id === o.me ? 'me' : group.has(b.id) ? 'group' : 'other',
        over,
        clearedMs: over === 'cleared' ? r!.clearedMs : null,
        courseSide: t < gun && en != null && side != null && dot(sub(en, left), side) > 0,
        across,
        third: across != null ? thirdOf(across) : null,
        toMarkM: en && fm && axis ? dot(sub(fm.xy, en), axis) : null,
        rank: null,
      };
    });
    const ranked = boats.filter((b) => b.toMarkM != null).sort((x, y) => x.toMarkM! - y.toMarkM!);
    ranked.forEach((b, i) => (b.rank = i + 1));
    const missing = boats.filter((b) => !b.pos).map((b) => b.sail);
    const placed = boats.length - missing.length;
    const empty = boats.every((b) => !b.pos && !b.trail.length);
    const base = { s, t, from, title: gunRel(t, gun), boats, empty, missing, placed };
    const caption = frameCaption(base, o.me, gun, fm?.name ?? 'the first mark', firstFix);
    const label = `Lane snapshot at ${base.title}${empty ? '' : `: ${placed} of ${boats.length} boats placed`}. ${caption}`;
    frames.push({ ...base, caption, label });
    prev = t;
  }
  const line: [Vec, Vec] = [rot(left), rot(right)];
  const mark = fm ? rot(fm.xy) : null;
  let markDir: Vec | null = null;
  if (mark) {
    const m = rot(mid);
    const v = sub(mark, m);
    const l = len(v);
    markDir = l > 0 ? [v[0] / l, v[1] / l] : null;
  }
  const view = laneView(line, mark, allPts, Math.max(LANE_REACH_LINES * lineM, LANE_REACH_MIN_M));
  const note = !windUp ? 'North up: no wind estimate.' : a.wind.method === 'course' ? 'Wind ↓ from top, assumed from the course.' : null;
  return { frames, line, mark, markName: fm?.name ?? 'first mark', markDir, view, windUp, note, me: o.me };
}
