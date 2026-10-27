/**
 * The landing page's hero picture: a real race's track map, drawn from an analysis the way the
 * Race tab's map is (wind at the top, tracks coloured by leg, marks, start and finish lines), as
 * one small standalone SVG (public/landing-hero.svg, written by scripts/landing-hero.mjs from a
 * test fixture). Labels are sail numbers only, never a boat's or anyone's name. Day and Night are
 * two files (public/landing-hero-night.svg): an <img> doesn't see the page's tokens or its theme
 * setting, so the page shows the one that matches (style.css .land-hero-fig).
 */
import type { Vec } from '../analysis/geo';
import type { RaceAnalysis } from '../analysis/types';
import { filledRanges, rotator } from '../ui/mapPieces';

export interface HeroOptions {
  /** Drawing width in SVG units (the height follows the course's shape). */
  width?: number;
  /** How many leaders get a heavier track and a sail-number label. */
  leaders?: number;
  /** Douglas–Peucker tolerance in SVG units (keeps the file small). */
  tolerance?: number;
  /** The replay frame's moment, as a share of the winner's elapsed time (default 0.4). */
  at?: number;
  /** The <title>: what the picture shows. */
  title: string;
  /** Day (default) or Night colors. */
  scheme?: 'day' | 'night';
}

/** Leg colours, as the app's --s1…--s8 (Day, then Night). */
const LEG_DAY = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const LEG_NIGHT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#2f9a2f', '#9085e9', '#e66767'];

const r1 = (x: number): string => (Math.round(x * 10) / 10).toString();

/** Douglas–Peucker on a polyline (indices kept), iterative. */
export function simplify(pts: Vec[], tol: number): Vec[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [ax, ay] = pts[i];
    const [bx, by] = pts[j];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs(dy * (pts[k][0] - ax) - dx * (pts[k][1] - ay)) / len;
      if (d > worst) [worst, at] = [d, k];
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** A track's position at `ms` (map metres), interpolated between the points either side (its holes are filled in: mapPieces.ts filledRanges); null outside the track. */
export function positionAt(segs: readonly { x: ArrayLike<number>; y: ArrayLike<number>; t: ArrayLike<number> }[], ms: number): Vec | null {
  for (const s of segs) {
    const n = s.t.length;
    if (!n || ms < s.t[0] || ms > s.t[n - 1]) continue;
    let i = 0;
    while (i < n - 1 && s.t[i + 1] < ms) i++;
    if (i === n - 1) return [s.x[i], s.y[i]];
    const dt = s.t[i + 1] - s.t[i];
    const f = dt > 0 ? (ms - s.t[i]) / dt : 0;
    return [s.x[i] + f * (s.x[i + 1] - s.x[i]), s.y[i] + f * (s.y[i + 1] - s.y[i])];
  }
  return null;
}

const pathOf = (pts: Vec[]): string => pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p[0])} ${r1(p[1])}`).join('');

/** Escape text for SVG. */
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function heroSvg(a: RaceAnalysis, o: HeroOptions): string {
  const W = o.width ?? 640;
  const leaders = o.leaders ?? 3;
  const tol = o.tolerance ?? 0.9;
  const rot = rotator(a.wind.twdAtGunDeg);

  // Each track's legs as the Race tab's map draws them (every hole filled in), and their map coordinates (metres, wind up).
  const ranges = new Map(
    a.drawings.map((d) => [
      d.id,
      filledRanges(d, false).map((r) => ({ leg: r.leg, t: r.src.t.subarray(r.lo, r.hi), x: r.src.x.subarray(r.lo, r.hi), y: r.src.y.subarray(r.lo, r.hi) })),
    ]),
  );
  const tracks = a.drawings.map((d) => ({
    id: d.id,
    legs: ranges.get(d.id)!.map((s) => {
      const run: Vec[] = [];
      for (let i = 0; i < s.x.length; i++) run.push(rot([s.x[i], s.y[i]]));
      return { leg: s.leg, runs: run.length > 1 ? [run] : [] };
    }),
  }));
  const fixed: Vec[] = [rot(a.line.left), rot(a.line.right), ...a.marks.flatMap((m) => m.xy.map(rot))];
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = ([x, y]: Vec): void => {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  };
  fixed.forEach(grow);
  for (const t of tracks) for (const l of t.legs) for (const r of l.runs) r.forEach(grow);
  const pad = 0.05 * Math.max(x1 - x0, y1 - y0);
  [x0, y0, x1, y1] = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  const s = W / (x1 - x0);
  const H = Math.round((y1 - y0) * s);
  const px = ([x, y]: Vec): Vec => [(x - x0) * s, (y - y0) * s];

  const ranked = a.boats.filter((b) => b.finishPos != null).sort((p, q) => p.finishPos! - q.finishPos!);
  const top = new Set(ranked.slice(0, leaders).map((b) => b.id));
  const sailOf = new Map(a.boats.map((b) => [b.id, b.sail]));

  // One path per leg colour for the fleet (small file), the leaders' own on top.
  const fleet = new Map<number, string[]>();
  const lead: string[] = [];
  for (const t of tracks) {
    for (const l of t.legs) {
      if (l.leg < 0) continue;
      for (const r of l.runs) {
        const d = pathOf(simplify(r.map(px), tol));
        if (top.has(t.id)) lead.push(`<path class="k l${l.leg % 8}" d="${d}"/>`);
        else fleet.set(l.leg % 8, [...(fleet.get(l.leg % 8) ?? []), d]);
      }
    }
  }
  const fleetSvg = [...fleet].map(([k, ds]) => `<path class="l${k}" d="${ds.join('')}"/>`).join('');

  // A replay frame: every boat where it was at `at` of the winner's race, the leaders labelled.
  const winner = ranked[0]?.finishMs;
  const atMs = a.meta.gunMs + (o.at ?? 0.4) * ((winner ?? a.meta.gunMs) - a.meta.gunMs);
  const dots: string[] = [];
  const labels: string[] = [];
  const placed: Vec[] = [];
  for (const d of a.drawings) {
    const p = positionAt(ranges.get(d.id)!, atMs);
    if (!p) continue;
    const [x, y] = px(rot(p));
    const lead = top.has(d.id);
    dots.push(`<circle class="${lead ? 'dot k' : 'dot'}" cx="${r1(x)}" cy="${r1(y)}" r="${lead ? 3.6 : 2.6}"/>`);
    const sail = sailOf.get(d.id);
    if (!lead || !sail) continue;
    // Step a label down until it clears the ones already placed.
    let ly = y + 4;
    while (placed.some(([px_, py]) => Math.abs(py - ly) < 14 && Math.abs(px_ - (x + 7)) < 70)) ly += 14;
    placed.push([x + 7, ly]);
    labels.push(`<text x="${r1(x + 7)}" y="${r1(ly)}">${esc(sail)}</text>`);
  }

  const marks = a.marks
    .flatMap((m) => m.xy.map((p) => px(rot(p))))
    .map((p) => `<circle class="mk" cx="${r1(p[0])}" cy="${r1(p[1])}" r="5"/>`)
    .join('');
  const [L, R] = [px(rot(a.line.left)), px(rot(a.line.right))];
  const line = `<line class="ln" x1="${r1(L[0])}" y1="${r1(L[1])}" x2="${r1(R[0])}" y2="${r1(R[1])}"/><circle class="pin" cx="${r1(L[0])}" cy="${r1(L[1])}" r="3.5"/><circle class="pin" cx="${r1(R[0])}" cy="${r1(R[1])}" r="3.5"/>`;
  const fl = a.finishLine;
  const finish =
    fl && Math.hypot(fl.left[0] - a.line.left[0], fl.left[1] - a.line.left[1]) + Math.hypot(fl.right[0] - a.line.right[0], fl.right[1] - a.line.right[1]) > 20
      ? (() => {
          const [p, q] = [px(rot(fl.left)), px(rot(fl.right))];
          return `<line class="fin" x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}"/>`;
        })()
      : '';
  const wind = `<g class="wind" transform="translate(${W - 34} 14)"><path d="M10 0v26M4 20l6 7 6-7"/><text x="10" y="42" text-anchor="middle">Wind</text></g>`;

  const legCss = (cols: string[]): string => cols.map((c, i) => `.l${i}{stroke:${c}}`).join('');
  const base = `path{fill:none;stroke-linejoin:round;stroke-linecap:round}path[class^=l]{stroke-width:1;stroke-opacity:.42}path.k{stroke-width:2.4;stroke-opacity:1}`;
  const day =
    legCss(LEG_DAY) +
    `.mk{fill:#fff;stroke:#131922;stroke-width:1.6}.ln{stroke:#131922;stroke-width:2}.pin{fill:#131922}.fin{stroke:#131922;stroke-width:1.6;stroke-dasharray:4 3}` +
    `.dot{fill:#46505e;stroke:#fff;stroke-width:1}.dot.k{fill:#131922;stroke-width:1.4}text{font:600 12px Archivo,system-ui,sans-serif;fill:#131922;paint-order:stroke;stroke:#f5f7fa;stroke-width:3px}` +
    `.wind path{stroke:#5b6675;stroke-width:1.6}.wind text{font-size:10px;fill:#5b6675}`;
  const night =
    legCss(LEG_NIGHT) +
    `path[class^=l]{stroke-opacity:.5}.mk{fill:#171d26;stroke:#e9eef5}.ln{stroke:#e9eef5}.pin{fill:#e9eef5}.fin{stroke:#e9eef5}.dot{fill:#b9c2ce;stroke:#10151c}.dot.k{fill:#fff}text{fill:#e9eef5;stroke:#10151c}.wind path{stroke:#9aa6b6}.wind text{fill:#9aa6b6}`;
  // Night is Day with its colors swapped, so it keeps Day's sizes and dashes.
  const css = base + day + (o.scheme === 'night' ? night : '');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t">` +
    `<title id="t">${esc(o.title)}</title><style>${css}</style>` +
    `<g>${fleetSvg}</g><g>${lead.join('')}</g>${line}${finish}${marks}<g>${dots.join('')}</g>${labels.join('')}${wind}</svg>\n`
  );
}
