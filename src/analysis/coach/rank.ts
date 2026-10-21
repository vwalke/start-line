/**
 * Rank, dedupe, gate (spec §5). Confidence is the lowest of its inputs
 * (opportunity.ts confidenceOf); score = seconds × weight. Each race-second is
 * claimed once: the higher score keeps an overlapped stretch, the other's
 * seconds shrink by the share of its window overlapped, and it is re-scored.
 * Then the per-confidence minimum, and the top 3 (ties → the earlier window).
 */
import { CONF_WEIGHT, MIN_SECONDS, confidenceOf, type ConfLimit, type Opportunity } from './opportunity';

export const TOP_N = 3;

export interface Card extends Opportunity {
  /** seconds × weight, after any overlap was taken off. */
  score: number;
  /** What capped the confidence (null when high). */
  limit: ConfLimit | null;
}

const spansOf = (o: Opportunity): [number, number][] => o.spans ?? [[o.t0, o.t1]];
const lengthOf = (sp: [number, number][]): number => sp.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);

/** How much of `o`'s window the accepted cards already hold, ms. */
export function overlapMs(o: Opportunity, taken: readonly Opportunity[]): number {
  let ms = 0;
  for (const [a, b] of spansOf(o)) {
    // Merge the taken spans inside [a, b] so a stretch held twice counts once.
    const cut = taken
      .flatMap(spansOf)
      .map(([p, q]): [number, number] => [Math.max(a, p), Math.min(b, q)])
      .filter(([p, q]) => q > p)
      .sort((x, y) => x[0] - y[0]);
    let end = -Infinity;
    for (const [p, q] of cut) {
      const lo = Math.max(p, end);
      if (q > lo) ms += q - lo;
      end = Math.max(end, q);
    }
  }
  return ms;
}

/** `o` with the share of its window in `taken` taken off its seconds. */
function trimmed(o: Card, taken: readonly Opportunity[]): Card {
  const len = lengthOf(spansOf(o));
  const f = len > 0 ? 1 - overlapMs(o, taken) / len : 1;
  if (f >= 1) return o;
  const seconds = o.seconds * f;
  return { ...o, seconds, secondsLo: o.secondsLo * f, secondsHi: o.secondsHi * f, score: seconds * CONF_WEIGHT[o.confidence] };
}

const better = (p: Card, q: Card): number => q.score - p.score || p.t0 - q.t0;

/** The cards to show, best first (at most `max`: TOP_N for a race's cards; the Regatta view keeps them all), from every detector's opportunities. */
export function rankOpportunities(opps: readonly Opportunity[], max = TOP_N): Card[] {
  // Untrimmed; each round trims them afresh against what is taken so far.
  const queue: Card[] = opps
    .map((o) => {
      const { level, limit } = confidenceOf(o.conf);
      return { ...o, confidence: level, limit, score: o.seconds * CONF_WEIGHT[level] };
    })
    .filter((c) => c.confidence !== 'none' && c.seconds > 0);
  const taken: Card[] = [];
  while (queue.length) {
    const now = queue.map((c, i) => ({ c: trimmed(c, taken), i })).sort((p, q) => better(p.c, q.c));
    const head = now[0];
    queue.splice(head.i, 1);
    if (head.c.seconds >= MIN_SECONDS[head.c.confidence]) taken.push(head.c);
  }
  return taken.sort(better).slice(0, max);
}
