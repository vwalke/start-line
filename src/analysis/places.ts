/**
 * Place changes through the race (the bump chart): each boat's place at the
 * start, at every mark rounding and at the finish.
 *
 * Start: the start table's place among clean starters (null when over or
 * with no reliable figure). Each mark: the order of the rounding times (the
 * leg splits in analyze.ts) among the boats with a time there; a boat with
 * none (a telemetry gap through the rounding, or it never got there) is left
 * out, so the others close up. Finish: the finish order. Boats set aside as
 * not racing are never in `RaceAnalysis.boats`, so never here.
 */
import type { BoatResult, LegDef, RaceAnalysis } from './types';

export interface PlaceColumn {
  /** "Start", the mark as the legs name it ("M1", "Gate", "M1 (2)" when repeated), "Finish". */
  label: string;
  kind: 'start' | 'mark' | 'finish';
  /** For a mark: the leg it ends. */
  legIndex?: number;
}

export interface BoatPlaces {
  id: string;
  /** Place per column; null = none (no start place, missing rounding, not reached, DNF). */
  places: (number | null)[];
  /** Places gained since the last column with a place (+ = gained); null at the first point. */
  gains: (number | null)[];
  /** The column each gain is measured from. */
  since: (number | null)[];
  /** The last column with a place (-1 with none). */
  lastCol: number;
  /** No finish place. */
  dnf: boolean;
  /** First place to last place, + = gained; null with fewer than two places. */
  net: number | null;
}

export interface PlaceChanges {
  columns: PlaceColumn[];
  boats: BoatPlaces[];
  /** The largest place drawn (the y axis). */
  maxPlace: number;
  /** Per column, the boats with no place there that have a place later (a gap, not a DNF). */
  missing: number[];
}

/** Column labels: Start, each mark the legs end at (repeats numbered), Finish. */
export function placeColumns(legs: LegDef[]): PlaceColumn[] {
  const seen = new Map<string, number>();
  const marks = legs.slice(0, -1).map((l) => {
    const n = (seen.get(l.to) ?? 0) + 1;
    seen.set(l.to, n);
    return { label: n > 1 ? `${l.to} (${n})` : l.to, kind: 'mark' as const, legIndex: l.index };
  });
  return [{ label: 'Start', kind: 'start' }, ...marks, { label: 'Finish', kind: 'finish' }];
}

/** When a boat rounded the mark ending leg `li`: that leg's end, else the next leg's start; null when unknown. */
export function roundingMs(b: BoatResult, li: number): number | null {
  return b.legs[li]?.endMs ?? b.legs[li + 1]?.startMs ?? null;
}

/**
 * Order of the given times (null = no place), 1 = earliest. Equal times (thinned
 * fixes) keep the order of the legs table's place at the mark (`tie`), so the two agree.
 */
function orderPlaces(times: (number | null)[], tie: (number | null)[]): (number | null)[] {
  const idx = times.map((t, i) => [t, i] as const).filter((x): x is readonly [number, number] => x[0] != null);
  idx.sort((p, q) => p[0] - q[0] || (tie[p[1]] ?? Infinity) - (tie[q[1]] ?? Infinity) || p[1] - q[1]);
  const out: (number | null)[] = times.map(() => null);
  idx.forEach(([, i], k) => (out[i] = k + 1));
  return out;
}

export function placeChanges(a: Pick<RaceAnalysis, 'legs' | 'boats'>): PlaceChanges {
  const columns = placeColumns(a.legs);
  const cols: (number | null)[][] = columns.map((c) => {
    if (c.kind === 'start') return a.boats.map((b) => b.start?.startPlace ?? null);
    if (c.kind === 'finish') return a.boats.map((b) => b.finishPos);
    return orderPlaces(
      a.boats.map((b) => roundingMs(b, c.legIndex!)),
      a.boats.map((b) => b.legs[c.legIndex!]?.rankAtEnd ?? null),
    );
  });
  const boats = a.boats.map((b, i): BoatPlaces => {
    const places = cols.map((c) => c[i]);
    const gains: (number | null)[] = [];
    const since: (number | null)[] = [];
    let prev = -1;
    places.forEach((p, k) => {
      const from = p != null && prev >= 0 ? prev : null;
      gains.push(from != null ? places[from]! - p! : null);
      since.push(from);
      if (p != null) prev = k;
    });
    const first = places.findIndex((p) => p != null);
    return {
      id: b.id,
      places,
      gains,
      since,
      lastCol: prev,
      dnf: b.finishPos == null,
      net: first >= 0 && prev > first ? places[first]! - places[prev]! : null,
    };
  });
  const missing = columns.map((_, k) => boats.filter((b) => b.places[k] == null && b.lastCol > k && b.places.slice(0, k).some((p) => p != null)).length);
  const maxPlace = Math.max(1, ...boats.flatMap((b) => b.places.filter((p): p is number => p != null)));
  return { columns, boats, maxPlace, missing };
}
