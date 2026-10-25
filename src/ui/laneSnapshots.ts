/**
 * The Start tab's "Start Playback" view: the fleet at any second from gun −1:30 to gun +3:00 (a time slider), each
 * boat the start chart's hull pointing along its course (or its last heading; a dot only with none known:
 * ui/boatShape.ts boatMark), filled while its data is fresh and hollow once it is lost, with the track map's fading
 * trail behind it (ui/trail.ts: the last BOAT_TRAIL_MS, from LANE_TRAIL_FROM_S at the earliest, the slider's start),
 * so a coach can see how each boat set up, came off the line and whether it held its lane. Pure: per-second frames → boats, trails, the selected boat's place to windward;
 * ui/laneSnapshotsView.ts draws them. Kept apart from the start chart.
 *
 * Everything is worked out once per race and selection (laneScrub): each boat's position and course on the 1 s
 * grid LANE_START_S … LANE_END_S and its trail points up to LANE_END_S; a frame (frame(s)) only slices those.
 *
 * Positions are the scrubber's (mapPieces.ts boatAt, over the tracks with their short gaps filled in for display:
 * mapPieces.ts filledRanges, ui/gapFill.ts, so a boat in one is placed on the curve, filled): linear between fixes, held at the last fix for MAP_HOLD_S
 * inside a gap over SHORT_GAP_S (hollow: boatShape.ts boatStale), else none (the boat is missing at that second, never placed); its course is the scrubber's too (the step
 * it is on), none while held or between fixes too close. Trails come from the same drawn tracks
 * (the pre-gun track and the legs), broken wherever consecutive fixes are a gap apart (mapPoints.ts's rule), a filled-in
 * stretch drawn lighter.
 *
 * The view is wind-up (the analysis's wind at the gun, as the start chart) and fixed for the whole slider: fitted
 * once to everything drawn at any second of it (laneView), so it never rescales while scrubbing (zooming is the
 * reader's alone); a true-wind badge points downwind, and places are by distance made to windward along the wind. With
 * no wind estimate the view is north up and the wind is assumed square to the line, from the course side. "Over":
 * a boat over early (StartReplay, the worker's startCross facts, as Map C) is over at a second until its clearing
 * (clearedMs; never cleared: still over); from then on it is "cleared", with when. Its track is drawn as the track
 * map's replay draws it (ui/ocsStyle.ts: the stretch over the line, the dip back, where it went back and cleared).
 */
import { dot, len, sub, type Vec } from '../analysis/geo';
import { windSource } from '../analysis/line';
import type { StartReplay } from '../analysis/startReplay';
import type { RaceAnalysis } from '../analysis/types';
import type { ClassDims } from '../data/classes';
import { startClass } from './charts';
import { degLabel } from './format';
import { boatAt, endHoldBefore, filledRanges, lastHeadingAt, legRanges, lowerBound, rotator, rotTrack, timeRange, type LegRange } from './mapPieces';
import { drawingGapMs } from './mapPoints';
import { ocsStretch, type OcsStretch } from './ocsStyle';
import { gunRel } from './scrub';
import { BOAT_TRAIL_MS, trailSlices } from './trail';
import type { Box } from './view';

/** The slider's start and end, s from the gun (−1:30 … +3:00), in steps of LANE_STEP_S. */
export const LANE_START_S = -90;
export const LANE_END_S = 180;
export const LANE_STEP_S = 1;
/** No frame's trail starts before this, s from the gun (or where the data does): the slider's start; each is BOAT_TRAIL_MS at most. */
export const LANE_TRAIL_FROM_S = LANE_START_S;
/**
 * The outlier guard (it only ever leaves points out, never pads): points further than max(LANE_GUARD_LINES × the
 * line, LANE_GUARD_MIN_M) from the line's middle don't count toward the view, nor do boats away from the line.
 */
export const LANE_GUARD_LINES = 3;
export const LANE_GUARD_MIN_M = 400;
/** The view's padding: this share of its width / height on each side, and at least LANE_PAD_M. */
export const LANE_PAD = 0.08;
export const LANE_PAD_M = 10;
/** Outside its track (before the first fix, after the last), a boat is placed at its end fix when that is this close in time, ms (a feed that starts at −59.9 s). */
export const LANE_SNAP_MS = 1000;

/**
 * Boat `id` at `t`: the scrubber's position (boatAt, held past its final fix before `endHold` as the Race Viewer
 * holds it), else its track's end fix within LANE_SNAP_MS; east/north and map coordinates.
 */
export function placeAt(id: string, ranges: readonly LegRange[], t: number, gapMs: number, twd: number, endHold = -Infinity): { x: number; y: number; mx: number; my: number; hold: boolean; stale: boolean } | null {
  const at = boatAt(id, ranges, t, gapMs, twd, endHold);
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
  return { x: best.r.src.x[best.i], y: best.r.src.y[best.i], mx: rot.x[best.i], my: rot.y[best.i], hold: false, stale: false };
}

export type LaneRole = 'me' | 'group' | 'other';
export type LaneOver = 'over' | 'cleared' | null;

export interface LaneBoat {
  id: string;
  sail: string;
  /** Map coordinates (wind-up, y down) at the frame's time; null: no fix near enough (missing at this second). */
  pos: Vec | null;
  /** In a gap, held at the fix before it. */
  hold: boolean;
  /** Held and that fix is stale (boatShape.ts boatStale): drawn hollow. */
  stale: boolean;
  /** Its course over ground at the frame's time, unit, map coordinates (the scrubber's); null: none (held, not moving, snapped). */
  dir: Vec | null;
  /** The last heading known by the frame's time (mapPieces.ts lastHeadingAt); null: none yet. */
  lastDir: Vec | null;
  /** SOG at the frame's time, kn (NaN: unknown). */
  sog: number;
  /** The boat has a track (any fix) in the race; false: never tracked. */
  tracked: boolean;
  /** The trail over the BOAT_TRAIL_MS before the frame (from LANE_TRAIL_FROM_S at the earliest), map coordinates, one polyline per stretch without a gap. */
  trail: Vec[][];
  /** The same trail as path data per fade slice, head first (ui/trail.ts trailPaths)… */
  fade: string[];
  /** …and its stretches filled into a short gap, per slice (drawn lighter: ui/gapFill.ts). */
  fadeEst: string[];
  role: LaneRole;
  /** OCS at the frame's time (until clearedMs); 'cleared': cleared by then, within the trail. */
  over: LaneOver;
  /** The clearing time (ms) when `over` is 'cleared'. */
  clearedMs: number | null;
  /** Over early: its track over the line and back up to the frame, within the trail (ui/ocsStyle.ts); null otherwise. */
  ocs: OcsStretch | null;
  /** Distance made to windward from the line's middle, along the (true or assumed) wind axis, m. */
  windwardM: number | null;
  /** 1 = furthest to windward by `windwardM`, of the boats placed at this second (approximate). */
  rank: number | null;
}

export interface LaneFrame {
  /** Gun-relative seconds and the race time, ms. */
  s: number;
  t: number;
  /** The trail starts here, ms. */
  from: number;
  /** "gun +1:23". */
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

export interface LaneScrub {
  /** The slider's start and end, s from the gun (LANE_START_S, LANE_END_S). */
  start: number;
  end: number;
  /** The fleet at gun + `s` (to the whole second, clamped to start … end), sliced from the precomputed grid. */
  frame: (s: number) => LaneFrame;
  /** The start line's pin and RC ends, map coordinates. */
  line: [Vec, Vec];
  /** The true wind (null: no wind estimate and no line to assume it from). */
  wind: LaneWind | null;
  /** The view's fit box (zoom 1, the default), map coordinates: fixed for the whole slider (the extent over all of it). */
  view: Box;
  /** The class's hull dimensions for the boat shapes (null: unknown class: dots). */
  dims: ClassDims | null;
  /** Some boat was over early (the key's legend for the rings). */
  anyOver: boolean;
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

/** The wind arrow's label and title (also said in every frame's label) and the key's note, by where the wind comes from (as the start chart's wind chip). */
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
    return { label: `TWD ~${deg} est.`, title: `True wind from ${deg} (estimated)`, note: `True wind ↓ from the top, estimated ${windSource(a.wind).from}.` };
  }
  if (a.wind.method === 'model') {
    return { label: `TWD ${deg} (model)`, title: `True wind from ${deg} (weather model)`, note: 'True wind ↓ from the top, from the weather model.' };
  }
  return { label: `TWD ~${deg} assumed`, title: `True wind from ${deg} (assumed from the course)`, note: 'True wind ↓ from the top, assumed from the course (first leg dead upwind).' };
}

interface TrailPt {
  t: number;
  p: Vec;
  /** Filled into a short gap (ui/gapFill.ts). */
  est?: boolean;
}

/**
 * A boat's trail points over [from, to]: its drawn track there (map coordinates, short gaps filled in), with its position at
 * both ends where it has one; not yet broken at gaps.
 */
function trailPts(d: RaceAnalysis['drawings'][number], twd: number, from: number, to: number): TrailPt[] {
  const gapMs = drawingGapMs(d);
  const ranges = filledRanges(d, true);
  const pts: TrailPt[] = [];
  const start = boatAt(d.id, ranges, from, gapMs, twd);
  if (start && !start.hold) pts.push({ t: from, p: [start.mx, start.my], ...(start.est ? { est: true } : {}) });
  for (const r of ranges) {
    const [i0, i1] = timeRange(r.src.t, from, to, r.lo, r.hi);
    const rot = rotTrack(twd, r.src);
    for (let i = i0; i < i1; i++) {
      const t = r.src.t[i];
      // Ranges share a fix where one leg ends and the next begins: keep it once.
      if (pts.length && t <= pts[pts.length - 1].t) continue;
      pts.push({ t, p: [rot.x[i], rot.y[i]], ...(r.src.est?.[i] === 1 ? { est: true } : {}) });
    }
  }
  const end = boatAt(d.id, ranges, to, gapMs, twd);
  if (end && !end.hold && (!pts.length || pts[pts.length - 1].t < to)) pts.push({ t: to, p: [end.mx, end.my], ...(end.est ? { est: true } : {}) });
  return pts;
}

/** Trail points as polylines, broken wherever consecutive points are over `gapMs` apart (single points dropped). */
function breakAtGaps(pts: readonly TrailPt[], gapMs: number): Vec[][] {
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

/** A boat's trail over [from, to], worked out directly (the reference the sliced trails match). */
export function laneTrail(a: RaceAnalysis, id: string, twd: number, from: number, to: number): Vec[][] {
  const d = a.drawings.find((x) => x.id === id);
  return d ? breakAtGaps(trailPts(d, twd, from, to), drawingGapMs(d)) : [];
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
 * The view: the tight box around the line's ends and every point drawn at any second of the slider (positions and
 * trails from gun −1:30 to +3:00), padded LANE_PAD each side (at least LANE_PAD_M). Points beyond `guard` from the line's middle
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

/** A boat's place at one second of the grid: map and east/north coordinates, course and SOG; `ends`: its trail ends here (the scrubber's own position, not held or snapped). */
interface GridPos {
  pos: Vec;
  en: Vec;
  hold: boolean;
  stale: boolean;
  ends: boolean;
  dir: Vec | null;
  lastDir: Vec | null;
  sog: number;
  /** Placed on a stretch filled into a short gap (ui/gapFill.ts). */
  est: boolean;
}

/** `s` (s from the gun) as a second of the slider: rounded to the step, clamped to `start` … `end` (not a number: the gun). */
export const laneSecond = (s: number, end = LANE_END_S, start = LANE_START_S): number =>
  Math.max(start, Math.min(end, Number.isFinite(s) ? Math.round(s / LANE_STEP_S) * LANE_STEP_S : 0)) + 0;

/**
 * The Start Playback view of race `a` for the selected boat and its group: every boat's position and course on
 * the 1 s grid LANE_START_S … LANE_END_S and its trail points from the slider's start to its end, worked out once, and the view fitted once to all
 * of them and the line; frame(s) slices them for second `s` (memoised), so scrubbing does no new work.
 */
export function laneScrub(a: RaceAnalysis, o: LaneOptions): LaneScrub {
  const gun = a.meta.gunMs;
  const start = LANE_START_S;
  const end = LANE_END_S;
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
  const from = gun + LANE_TRAIL_FROM_S * 1000;
  const allPts: Vec[] = [];
  // Once per boat: its position at every second, and its trail points to the end (a frame takes those up to its time).
  const pre = a.boats.map((b) => {
    const d = drawn.get(b.id);
    const grid: (GridPos | null)[] = [];
    let pts: TrailPt[] = [];
    let gapMs = Infinity;
    let ranges: LegRange[] = [];
    if (d) {
      ranges = filledRanges(d, true);
      gapMs = drawingGapMs(d);
      for (let s = start; s <= end; s += LANE_STEP_S) {
        const t = gun + s * 1000;
        const at = placeAt(b.id, ranges, t, gapMs, twd, endHoldBefore(b.finishMs));
        // The trail ends at the boat only where the scrubber itself places it (not held, not snapped to an end fix); so does its course.
        const own = at && !at.hold ? boatAt(b.id, ranges, t, gapMs, twd) : null;
        grid.push(
          at
            ? {
                pos: [at.mx, at.my],
                en: [at.x, at.y],
                hold: at.hold,
                stale: at.stale,
                ends: own != null,
                dir: own?.dir ?? null,
                lastDir: lastHeadingAt(ranges, t, gapMs, twd),
                sog: own ? own.sog : NaN,
                est: !!own?.est,
              }
            : null,
        );
      }
      pts = trailPts(d, twd, from, gun + end * 1000);
    }
    // A boat away from the line (start.awayFromLine) is drawn but doesn't size the view.
    if (!b.start?.awayFromLine) {
      for (const g of grid) if (g) allPts.push(g.pos);
      for (const q of pts) allPts.push(q.p);
    }
    return { b, grid, pts, gapMs, ranges };
  });
  const line: [Vec, Vec] = [rot(left), rot(right)];
  // Downwind in map coordinates: the upwind axis turned as the view is, reversed (straight down when wind-up).
  const upMap = up ? rot(up) : null;
  const wind: LaneWind | null = upMap ? { down: [-upMap[0], -upMap[1]], label: words.label, title: words.title, assumed: !windUp } : null;
  // Fitted once to every second's positions and the trails to the end (each frame's trail is a prefix of those).
  const view = laneView(line, allPts, Math.max(LANE_GUARD_LINES * lineM, LANE_GUARD_MIN_M));

  const build = (s: number): LaneFrame => {
    const t = gun + s * 1000;
    const boats: LaneBoat[] = pre.map(({ b, grid, pts, gapMs, ranges }) => {
      const g = grid[(s - start) / LANE_STEP_S] ?? null;
      // Its trail: from BOAT_TRAIL_MS back (its position there, as laneTrail) through its points up to t, then its
      // position at t, broken at gaps.
      const tail = Math.max(from, t - BOAT_TRAIL_MS);
      let i0 = 0;
      while (i0 < pts.length && pts[i0].t < tail) i0++;
      let n = i0;
      while (n < pts.length && pts[n].t <= t) n++;
      const upTo: TrailPt[] = [];
      if (tail > from) {
        const at = boatAt(b.id, ranges, tail, gapMs, twd);
        if (at && !at.hold && (i0 >= n || pts[i0].t > tail)) upTo.push({ t: tail, p: [at.mx, at.my], ...(at.est ? { est: true } : {}) });
      }
      for (let i = i0; i < n; i++) upTo.push(pts[i]);
      if (g?.ends && (!upTo.length || upTo[upTo.length - 1].t < t)) upTo.push({ t, p: g.pos, ...(g.est ? { est: true } : {}) });
      const est = upTo.some((q) => q.est) ? { est: upTo.map((q) => (q.est ? 1 : 0)) } : {};
      const fade = trailSlices([{ t: upTo.map((q) => q.t), x: upTo.map((q) => q.p[0]), y: upTo.map((q) => q.p[1]), i0: 0, i1: upTo.length, ...est }], t, BOAT_TRAIL_MS, gapMs);
      const r = repOf.get(b.id);
      let over: LaneOver = null;
      if (r) {
        if (r.clearedMs == null || t < r.clearedMs) over = 'over';
        else if (r.clearedMs > from) over = 'cleared';
      }
      return {
        id: b.id,
        sail: b.sail,
        pos: g ? g.pos : null,
        hold: !!g?.hold,
        stale: !!g?.stale,
        dir: g?.dir ?? null,
        lastDir: g?.lastDir ?? null,
        sog: g ? g.sog : NaN,
        tracked: tracked.has(b.id),
        trail: breakAtGaps(upTo, gapMs),
        fade: fade.d,
        fadeEst: fade.est,
        role: b.id === o.me ? 'me' : group.has(b.id) ? 'group' : 'other',
        over,
        clearedMs: over === 'cleared' ? r!.clearedMs : null,
        // Its track over the line and back, as far as the frame and within the trail: the track map's replay styling.
        ocs: r && over ? ocsStretch(r, ranges, gapMs, twd, t, [from, t]) : null,
        windwardM: g && up ? dot(sub(g.en, mid), up) : null,
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
      ? `Fleet at ${base.title}: no tracks at this time.`
      : [`Fleet at ${base.title}: ${placed} of ${boats.length} boats placed.`, spoken, up ? `${words.title}.` : ''].filter(Boolean).join(' ');
    return { ...base, caption, label };
  };
  const memo = new Map<number, LaneFrame>();
  const frame = (s: number): LaneFrame => {
    const k = laneSecond(s, end, start);
    let f = memo.get(k);
    if (!f) memo.set(k, (f = build(k)));
    return f;
  };
  // Over or cleared at some second (one cleared before the trails start never shows).
  const anyOver = a.boats.some((b) => {
    const r = repOf.get(b.id);
    return !!r && (r.clearedMs == null || r.clearedMs > from);
  });
  return { start, end, frame, line, wind, view, dims: startClass(a)?.dims ?? null, windUp, note: words.note, me: o.me, anyOver };
}
