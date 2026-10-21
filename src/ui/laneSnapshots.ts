/**
 * The Start tab's "Lane snapshots" (Chris): the fleet at gun +60 s, +120 s and +180 s, each boat a dot with
 * its trail back to LANE_TRAIL_FROM_S (gun −30 s) in every frame, so a coach can see how each boat came off
 * the line and whether it held its lane. Pure: frames → boats, trails, the selected boat's place to windward;
 * ui/laneSnapshotsView.ts draws them.
 *
 * Positions are the scrubber's (mapPieces.ts boatAt): linear between fixes, held hollow for MAP_HOLD_S inside
 * a gap, else none (the boat is missing in that frame, never placed). Trails come from the same drawn tracks
 * (the pre-gun track and the legs), broken wherever consecutive fixes are a gap apart (mapPoints.ts's rule).
 *
 * The view is wind-up (the analysis's wind at the gun, as the start chart) and shared by the three frames: fitted
 * tightly to what they draw (laneView); a true-wind badge points downwind, and places are by distance made to windward
 * along the wind. With no wind estimate the view is north up and the wind is assumed square to the line, from
 * the course side. "Over" (a ring on the map only): a boat over early (StartReplay, the worker's startCross facts,
 * as Map C) is over at a frame until its clearing (clearedMs; never cleared: still over); from then on it is
 * "cleared", with when, in every frame (each trail runs from before the gun, so each shows the excursion and the return).
 */
import { dot, len, sub, type Vec } from '../analysis/geo';
import type { StartReplay } from '../analysis/startReplay';
import type { RaceAnalysis } from '../analysis/types';
import { degLabel } from './format';
import { boatAt, legRanges, lowerBound, rotator, rotTrack, timeRange, type LegRange } from './mapPieces';
import { drawingGapMs } from './mapPoints';
import { gunRel } from './scrub';
import type { Box } from './view';

/** The frames, s from the gun. */
export const LANE_FRAMES_S = [60, 120, 180] as const;
/** Every frame's trail starts here, s from the gun (or where the data does). */
export const LANE_TRAIL_FROM_S = -30;
/**
 * The outlier guard (it only ever leaves points out, never pads): points further than max(LANE_GUARD_LINES × the
 * line, LANE_GUARD_MIN_M) from the line's middle don't count toward the shared view, nor do boats away from the line.
 */
export const LANE_GUARD_LINES = 3;
export const LANE_GUARD_MIN_M = 400;
/** The view's padding: this share of its width / height on each side, and at least LANE_PAD_M. */
export const LANE_PAD = 0.08;
export const LANE_PAD_M = 10;
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
  /** The trail from LANE_TRAIL_FROM_S to the frame, map coordinates, one polyline per stretch without a gap. */
  trail: Vec[][];
  role: LaneRole;
  /** OCS at the frame's time (until clearedMs); 'cleared': cleared by then, within the trail. */
  over: LaneOver;
  /** The clearing time (ms) when `over` is 'cleared'. */
  clearedMs: number | null;
  /** Distance made to windward from the line's middle, along the (true or assumed) wind axis, m. */
  windwardM: number | null;
  /** 1 = furthest to windward by `windwardM`, of the boats placed in this frame (approximate). */
  rank: number | null;
}

export interface LaneFrame {
  /** Gun-relative seconds and the race time, ms. */
  s: number;
  t: number;
  /** The trail starts here, ms. */
  from: number;
  /** "gun +1:00". */
  title: string;
  boats: LaneBoat[];
  /** No boat has a position or a trail. */
  empty: boolean;
  /** Placed boats (for "of n"). */
  placed: number;
  /** The selected boat's place to windward, or its one gap / not-tracked note; "No tracks at this time." when empty; else ''. */
  caption: string;
  /** The frame's accessible description. */
  label: string;
}

/** The true-wind arrow. */
export interface LaneWind {
  /** The way the wind blows (downwind), unit, map coordinates: straight down when wind-up. */
  down: Vec;
  /** "TWD ~18° est.", "TWD 18° (model)", "TWD ~18° assumed"; no wind estimate: "Wind assumed ⟂ line". */
  label: string;
  /** Its hover / spoken text. */
  title: string;
  /** No wind estimate: assumed square to the line, from the course side. */
  assumed: boolean;
}

export interface LaneSnapshots {
  frames: LaneFrame[];
  /** The start line's pin and RC ends, map coordinates. */
  line: [Vec, Vec];
  /** The true wind (null: no wind estimate and no line to assume it from). */
  wind: LaneWind | null;
  /** The shared view, map coordinates. */
  view: Box;
  /** Wind at the top (else north-up). */
  windUp: boolean;
  /** The key's note on the wind and the orientation. */
  note: string;
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

/** The first mark (only to tell the course side): the legs' first turn, else the first mark rounded; null with neither. */
function firstMark(a: Pick<RaceAnalysis, 'legPts' | 'marks'>): Vec | null {
  const p = a.legPts?.[1];
  if (p && a.legPts!.length > 2) return p;
  return a.marks[0]?.xy[0] ?? p ?? null;
}

/**
 * The upwind axis, unit, east/north: from the wind at the gun (`twd`) or, with no wind estimate (null), square to
 * the line toward the course side (toward the first mark, as startReplay's courseSide; without one, the pin on
 * the left looking upwind). Null: neither (no wind and a zero-length line).
 */
function upwindAxis(a: RaceAnalysis, twd: number | null): Vec | null {
  if (twd != null) {
    const th = (twd * Math.PI) / 180;
    return [Math.sin(th), Math.cos(th)];
  }
  const { left, right } = a.line;
  const along = sub(right, left);
  const l = len(along);
  if (!(l > 0)) return null;
  const n: Vec = [-along[1] / l, along[0] / l];
  const fm = firstMark(a);
  return fm && dot(sub(fm, left), n) < 0 ? [-n[0], -n[1]] : n;
}

/** The wind arrow's label and title (also said in each frame's label) and the key's note, by where the wind comes from (as the start chart's wind chip). */
function windWords(a: RaceAnalysis, windUp: boolean): { label: string; title: string; note: string } {
  if (!windUp) {
    return {
      label: 'Wind assumed ⟂ line',
      title: 'No wind estimate: wind assumed square to the start line',
      note: 'North up: no wind estimate; wind assumed square to the line, from the course side.',
    };
  }
  const deg = degLabel(a.wind.twdAtGunDeg);
  if (a.wind.method === 'tacks') {
    return { label: `TWD ~${deg} est.`, title: `True wind from ${deg} (estimated)`, note: "True wind ↓ from the top, estimated from the fleet's tacks." };
  }
  if (a.wind.method === 'model') {
    return { label: `TWD ${deg} (model)`, title: `True wind from ${deg} (weather model)`, note: 'True wind ↓ from the top, from the weather model.' };
  }
  return { label: `TWD ~${deg} assumed`, title: `True wind from ${deg} (assumed from the course)`, note: 'True wind ↓ from the top, assumed from the course (first leg dead upwind).' };
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

/**
 * The frame's caption: "USA 016: ≈ 6 of 15" for the selected boat's place (approximate), or its one note ("…: no position
 * (tracker gap)." / "…: not tracked."); "No tracks at this time." for an empty frame; '' with no boat selected.
 * `spoken`: the same for the frame's screen-reader label, the place said as "USA 016: ≈ 6 of 15 upwind.".
 */
function frameCaption(f: Omit<LaneFrame, 'caption' | 'label'>, me: string | null): { caption: string; spoken: string } {
  const note = (t: string): { caption: string; spoken: string } => ({ caption: t, spoken: t });
  if (f.empty) return note('No tracks at this time.');
  const mine = me != null ? f.boats.find((b) => b.id === me) : undefined;
  if (!mine) return note('');
  if (!mine.tracked) return note(`${mine.sail}: not tracked.`);
  if (!mine.pos) return note(`${mine.sail}: no position (tracker gap).`);
  if (mine.rank == null) return note('');
  const place = `${mine.sail}: ≈ ${mine.rank} of ${f.placed}`;
  const hold = mine.hold ? ' (last fix)' : '';
  return { caption: place + hold, spoken: `${place} upwind${hold}.` };
}

/**
 * The shared view: the tight box around the line's ends and every point drawn in any frame (positions and trails
 * from gun −0:30), padded LANE_PAD each side (at least LANE_PAD_M). Points beyond `guard` from the line's middle
 * are left out (a stray boat can't blow the view up); nothing else is added (the wind badge sits outside the map).
 */
export function laneView(line: [Vec, Vec], pts: readonly Vec[], guard: number): Box {
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
  for (const p of pts) if (len(sub(p, mid)) <= guard) grow(p);
  const px = Math.max(LANE_PAD_M, LANE_PAD * (box.x1 - box.x0));
  const py = Math.max(LANE_PAD_M, LANE_PAD * (box.y1 - box.y0));
  return { x0: box.x0 - px, y0: box.y0 - py, x1: box.x1 + px, y1: box.y1 + py };
}

/** The three lane snapshots of race `a` for the selected boat and its group. */
export function laneSnapshots(a: RaceAnalysis, o: LaneOptions): LaneSnapshots {
  const gun = a.meta.gunMs;
  const windUp = Number.isFinite(a.wind.twdAtGunDeg);
  const twd = windUp ? a.wind.twdAtGunDeg : 0;
  const rot = rotator(twd);
  const { left, right } = a.line;
  const lineM = len(sub(right, left));
  const mid: Vec = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
  // Places to windward: along the wind at the gun, else square to the line.
  const up = upwindAxis(a, windUp ? twd : null);
  const words = windWords(a, windUp);
  const group = new Set(o.group ?? []);
  const repOf = new Map((o.replays ?? []).map((r) => [r.boat, r]));
  const drawn = new Map(a.drawings.map((d) => [d.id, d]));
  // Who has any fix at all (the selected boat's "not tracked").
  const tracked = new Set(a.drawings.filter((d) => legRanges(d, true).some((r) => r.hi > r.lo)).map((d) => d.id));
  const frames: LaneFrame[] = [];
  const allPts: Vec[] = [];
  const from = gun + LANE_TRAIL_FROM_S * 1000;
  for (const s of LANE_FRAMES_S) {
    const t = gun + s * 1000;
    const boats: LaneBoat[] = a.boats.map((b) => {
      const d = drawn.get(b.id);
      const at = d ? placeAt(b.id, legRanges(d, true), t, drawingGapMs(d), twd) : null;
      const pos: Vec | null = at ? [at.mx, at.my] : null;
      const en: Vec | null = at ? [at.x, at.y] : null;
      const r = repOf.get(b.id);
      let over: LaneOver = null;
      if (r) {
        if (r.clearedMs == null || t < r.clearedMs) over = 'over';
        else if (r.clearedMs > from) over = 'cleared';
      }
      const trail = d ? trailOf(a, b.id, twd, from, t) : [];
      // A boat away from the line (start.awayFromLine) is drawn but doesn't size the view.
      if (!b.start?.awayFromLine) {
        if (pos) allPts.push(pos);
        for (const seg of trail) allPts.push(...seg);
      }
      return {
        id: b.id,
        sail: b.sail,
        pos,
        hold: !!at?.hold,
        tracked: tracked.has(b.id),
        trail,
        role: b.id === o.me ? 'me' : group.has(b.id) ? 'group' : 'other',
        over,
        clearedMs: over === 'cleared' ? r!.clearedMs : null,
        windwardM: en && up ? dot(sub(en, mid), up) : null,
        rank: null,
      };
    });
    const ranked = boats.filter((b) => b.windwardM != null).sort((x, y) => y.windwardM! - x.windwardM!);
    ranked.forEach((b, i) => (b.rank = i + 1));
    const placed = boats.filter((b) => b.pos).length;
    const empty = boats.every((b) => !b.pos && !b.trail.length);
    const base = { s, t, from, title: gunRel(t, gun), boats, empty, placed };
    const { caption, spoken } = frameCaption(base, o.me);
    const label = empty
      ? `Lane snapshot at ${base.title}: no tracks at this time.`
      : [`Lane snapshot at ${base.title}: ${placed} of ${boats.length} boats placed.`, spoken, up ? `${words.title}.` : ''].filter(Boolean).join(' ');
    frames.push({ ...base, caption, label });
  }
  const line: [Vec, Vec] = [rot(left), rot(right)];
  // Downwind in map coordinates: the upwind axis turned as the view is, reversed (straight down when wind-up).
  const upMap = up ? rot(up) : null;
  const wind: LaneWind | null = upMap ? { down: [-upMap[0], -upMap[1]], label: words.label, title: words.title, assumed: !windUp } : null;
  const view = laneView(line, allPts, Math.max(LANE_GUARD_LINES * lineM, LANE_GUARD_MIN_M));
  return { frames, line, wind, view, windUp, note: words.note, me: o.me };
}
