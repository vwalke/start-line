/**
 * Rank, dedupe, gate (spec §5). Confidence is the lowest of its inputs
 * (opportunity.ts confidenceOf); the score is the card's impact on the result (impactOf): its seconds lost, at low
 * confidence counted up to LOW_IMPACT_CAP_S, × its confidence's weight. Seconds are the one currency: time lost anywhere
 * adds up at the finish, places don't (a detector that measures places, D9's sparse-data card or D14, turns them into
 * seconds where they were lost). Each race-second is
 * claimed once: the higher score keeps an overlapped stretch, the other's
 * seconds shrink by the share of its window overlapped, and it is re-scored.
 * The line bias (D16) is a start finding too (its window the approach, before D1's). The side of the course (D14) and
 * speed without progress (D15) are whole-leg findings like D6 / D7; the manoeuvres (D17) rate findings over their own
 * stretches. Then the per-confidence minimum (D1's lower at high confidence: minSeconds), and the top 3 (ties → the
 * more seconds, then the earlier window).
 * The start comes first: a start finding (D1, the merged start card, or D3) keeps its window
 * (gun − 10 s → crossing + 5 min); the rate findings (D6, D7, D11, D14, D15, D17) lose that stretch
 * from their spans, and their seconds pro rata, before anything is ranked. Penalty turns (D12) are moments the same
 * way: a leg's rate finding loses the loop's stretch (the loop explains it), never the other way round; and a loop is
 * taken before any other card, so a start card's first minutes (D3) or a leg's gap give up the loop's stretch too
 * (benelux J70 R8, boat 3: a 360 at +3 min was otherwise "lost ground after the start").
 * The gate choice (D13) is a moment too: its passage (the last of the run to the first 300 m of the beat) is the
 * choice's, not the next beat's shift window (D4) or its rate findings (J/24 R2 USA 2607: Beat 2's D4 window took
 * three quarters of the passage and left the gate card under its minimum).
 * In a race's top TOP_N at most MAX_PER_KIND cards come from one detector (penalty turns exempt): a further one is
 * passed over before it claims any seconds, and the next-best card of another detector takes the slot (Melges 24 R5,
 * 853: three "Left paid" cards before D14 was one card a race). The Regatta view (uncapped) keeps them all.
 */
import { confidenceOf, impactOf, minSeconds, type ConfLimit, type Opportunity } from './opportunity';

export const TOP_N = 3;
/** At most this many of a race's top TOP_N cards from one detector kind… */
export const MAX_PER_KIND = 2;
/** …except these (penalty turns: taken first, never passed over). */
export const CAP_EXEMPT: ReadonlySet<Opportunity['kind']> = new Set(['D12']);

export interface Card extends Opportunity {
  /** Its impact on the result (opportunity.ts impactOf: seconds, capped at low confidence, × weight), after any overlap was taken off. */
  score: number;
  /** What capped the confidence (null when high). */
  limit: ConfLimit | null;
}

type Windowed = Pick<Opportunity, 't0' | 't1' | 'spans'>;
const spansOf = (o: Windowed): [number, number][] => o.spans ?? [[o.t0, o.t1]];
const lengthOf = (sp: [number, number][]): number => sp.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);

/** How much of `o`'s window the accepted cards already hold, ms. */
export function overlapMs(o: Windowed, taken: readonly Windowed[]): number {
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

/** The share of `o`'s window (spans) not yet in `taken`, 0–1. */
const freeShare = (o: Windowed, taken: readonly Windowed[]): number => {
  const len = lengthOf(spansOf(o));
  return len > 0 ? 1 - overlapMs(o, taken) / len : 1;
};

/** `o` with the share of its window in `taken` taken off its seconds (part by part when it has `parts`). */
function trimmed(o: Card, taken: readonly Opportunity[]): Card {
  const kept = o.parts ? o.parts.reduce((s, p) => s + p.seconds * freeShare(p, taken), 0) : o.seconds * freeShare(o, taken);
  const f = o.seconds > 0 ? kept / o.seconds : 1;
  if (f >= 1) return o;
  const seconds = kept;
  return { ...o, seconds, secondsLo: o.secondsLo * f, secondsHi: o.secondsHi * f, score: impactOf(seconds, o.confidence) };
}

/** Start findings: their window is never trimmed by a rate finding. */
export const START_KINDS: ReadonlySet<Opportunity['kind']> = new Set(['D1', 'D3', 'D16']);
/** Moments other than the start whose window a rate finding gives up too: penalty turns, and the gate choice. */
export const MOMENT_KINDS: ReadonlySet<Opportunity['kind']> = new Set(['D12', 'D13']);
/** Rate × time findings over whole legs (angles, heel, the side of the course, speed without progress) and the manoeuvres' stretches (D17): trimmed for the start's window instead. */
export const RATE_KINDS: ReadonlySet<Opportunity['kind']> = new Set(['D6', 'D7', 'D11', 'D14', 'D15', 'D17']);

/** [a, b] less the `cut` spans. */
function without(a: number, b: number, cut: readonly [number, number][]): [number, number][] {
  let out: [number, number][] = [[a, b]];
  for (const [p, q] of cut) {
    out = out.flatMap(([x, y]): [number, number][] => {
      if (q <= x || p >= y) return [[x, y]];
      const keep: [number, number][] = [[x, Math.min(y, p)], [Math.max(x, q), y]];
      return keep.filter(([u, v]) => v > u);
    });
  }
  return out;
}

/** A rate finding with the start windows taken out of its spans and its seconds pro rata (null when nothing is left). */
export function clearStart(o: Opportunity, start: readonly [number, number][]): Opportunity | null {
  const before = spansOf(o);
  const spans = before.flatMap(([a, b]) => without(a, b, start));
  const len0 = lengthOf(before);
  const len = lengthOf(spans);
  if (len >= len0) return o;
  if (!(len > 0)) return null;
  const f = len / len0;
  return { ...o, t0: spans[0][0], t1: spans[spans.length - 1][1], spans, seconds: o.seconds * f, secondsLo: o.secondsLo * f, secondsHi: o.secondsHi * f };
}

/** The higher impact; on a tie (two low-confidence cards at the cap) the more seconds, then the earlier window. */
const better = (p: Card, q: Card): number => q.score - p.score || q.seconds - p.seconds || p.t0 - q.t0;

/**
 * The cards to show, best first (at most `max`: TOP_N for a race's cards, at most MAX_PER_KIND of a kind; the Regatta
 * view keeps them all, uncapped), from every detector's opportunities.
 */
export function rankOpportunities(opps: readonly Opportunity[], max = TOP_N): Card[] {
  // The start's windows (of start findings that can make a card on their own seconds) come first; so do penalty turns'.
  const start = opps
    .filter((o) => (START_KINDS.has(o.kind) || MOMENT_KINDS.has(o.kind)) && o.seconds >= minSeconds(o.kind, confidenceOf(o.conf).level))
    .flatMap(spansOf);
  // Untrimmed; each round trims them afresh against what is taken so far.
  const queue: Card[] = opps
    .map((o) => (start.length && RATE_KINDS.has(o.kind) ? clearStart(o, start) : o))
    .filter((o): o is Opportunity => !!o)
    .map((o) => {
      const { level, limit } = confidenceOf(o.conf);
      return { ...o, confidence: level, limit, score: impactOf(o.seconds, level) };
    })
    .filter((c) => c.confidence !== 'none' && c.seconds > 0);
  const taken: Card[] = [];
  const capped = Number.isFinite(max);
  const full = (k: Opportunity['kind']): boolean => capped && !CAP_EXEMPT.has(k) && taken.filter((c) => c.kind === k).length >= MAX_PER_KIND;
  while (queue.length) {
    const moment = (c: Card): number => (MOMENT_KINDS.has(c.kind) ? 1 : 0);
    const now = queue.map((c, i) => ({ c: trimmed(c, taken), i })).sort((p, q) => moment(q.c) - moment(p.c) || better(p.c, q.c));
    const head = now[0];
    queue.splice(head.i, 1);
    if (head.c.seconds >= minSeconds(head.c.kind, head.c.confidence) && !full(head.c.kind)) taken.push(head.c);
  }
  return taken.sort(better).slice(0, max);
}
