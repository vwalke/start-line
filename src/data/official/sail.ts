/**
 * Sail numbers across sources. Yachtscoring has prefixes in {"USA", "Uni", "US", "", null,
 * "None"}, numbers that carry the prefix ("USA 322", " USA 313"), leading zeros ("0005") and
 * suffixes ("251-L"); RaceSense has "USA 29" or a bare "29"; Sailti "BRA641". Boats are paired
 * in tiers, each pairing only unique keys: the sail (letters and digits), then digits only,
 * then the boat name. Whatever is left is reported, never guessed.
 */

/** Prefix words that are never part of the number. Any other 2–3 letter word before the digits is taken as a country. */
const FILLER = new Set(['NONE', 'NULL', 'UNI', 'US', 'USA', 'NA', 'N/A']);

/** Upper-case words of letters and digits; a glued country ("BRA641", "USA322") is split off. */
function words(s: string): string[] {
  const out: string[] = [];
  for (const w of s.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (!w) continue;
    const glued = /^([A-Z]{2,3})(\d+[A-Z]?)$/.exec(w);
    if (glued) out.push(glued[1], glued[2]);
    else out.push(w);
  }
  return out;
}

/** The sail without its country / filler prefix, punctuation or leading zeros: "USA 0005" → "5", "251-L" → "251L". */
export function sailKey(prefix: string | null | undefined, number?: string | null): string {
  const ws = words(`${prefix ?? ''} ${number ?? ''}`);
  // Drop leading prefix words while digits follow somewhere after them.
  while (ws.length > 1 && !/\d/.test(ws[0]) && (FILLER.has(ws[0]) || /^[A-Z]{2,3}$/.test(ws[0])) && ws.slice(1).some((w) => /\d/.test(w))) ws.shift();
  if (ws.length === 1 && FILLER.has(ws[0])) return '';
  return ws.join('').replace(/^0+(?=\d)/, '');
}

/** The sail with its country kept ("US"/"Uni"/"None" fillers dropped, "US" read as "USA"): pairs first, so ITA 1474 and USA 1474 stay apart. */
export function sailFullKey(prefix: string | null | undefined, number?: string | null): string {
  const ws = words(`${prefix ?? ''} ${number ?? ''}`)
    .map((w) => (w === 'US' ? 'USA' : w))
    .filter((w) => w === 'USA' || !FILLER.has(w));
  const country = ws.length > 1 && /^[A-Z]{2,3}$/.test(ws[0]) ? ws[0] : '';
  const rest = sailKey(prefix, number);
  return country && rest ? `${country}${rest}` : '';
}

/** Digits only, leading zeros dropped: the third-tier key ("251L" → "251"). */
export const sailDigits = (key: string): string => key.replace(/\D/g, '').replace(/^0+(?=\d)/, '');

/** Boat names compared case- and punctuation-insensitively ("Smoke 'n Oakum" = "SMOKE N OAKUM"). */
export const nameKey = (name: string | null | undefined): string =>
  (name ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export type MatchTier = 'country' | 'sail' | 'digits' | 'name';

export interface BoatKey {
  prefix?: string | null;
  /** The sail number as the source has it (may carry the prefix). */
  sail: string;
  name?: string | null;
}

export interface BoatMatch<A, B> {
  pairs: { a: A; b: B; tier: MatchTier }[];
  onlyA: A[];
  onlyB: B[];
}

/** Pair two boat lists in tiers (country + sail, sail, digits, name); a key shared by two boats on one side pairs nothing in that tier. */
export function matchBoats<A, B>(as: readonly A[], bs: readonly B[], ka: (a: A) => BoatKey, kb: (b: B) => BoatKey): BoatMatch<A, B> {
  const restA = new Set(as);
  const restB = new Set(bs);
  const pairs: BoatMatch<A, B>['pairs'] = [];
  const tiers: [MatchTier, (k: BoatKey) => string][] = [
    ['country', (k) => sailFullKey(k.prefix, k.sail)],
    ['sail', (k) => sailKey(k.prefix, k.sail)],
    ['digits', (k) => sailDigits(sailKey(k.prefix, k.sail))],
    ['name', (k) => nameKey(k.name)],
  ];
  for (const [tier, f] of tiers) {
    const index = <T>(xs: Set<T>, k: (x: T) => BoatKey): Map<string, T[]> => {
      const m = new Map<string, T[]>();
      for (const x of xs) {
        const key = f(k(x));
        if (!key) continue;
        const l = m.get(key);
        if (l) l.push(x);
        else m.set(key, [x]);
      }
      return m;
    };
    const ia = index(restA, ka);
    const ib = index(restB, kb);
    for (const [key, la] of ia) {
      const lb = ib.get(key);
      if (la.length !== 1 || lb?.length !== 1) continue;
      pairs.push({ a: la[0], b: lb[0], tier });
      restA.delete(la[0]);
      restB.delete(lb[0]);
    }
  }
  return { pairs, onlyA: [...restA], onlyB: [...restB] };
}
