/** Hull length overall and max beam per one-design class, for drawing boats to scale. */

export interface ClassDims {
  loaM: number;
  beamM: number;
  /**
   * The class's usual tracker-to-bow distance, cm: what RaceSense divisions of the class set as their offset
   * (`offsetOverrideCm`) where they set one. Taken for a boat whose feed gives none (bowAheadM).
   */
  bowCm?: number;
}

const ILCA: ClassDims = { loaM: 4.23, beamM: 1.37 }; // https://ilcasailing.org (ILCA Handbook 2026, "Parts of the ILCA Class dinghy")

const DIMS: Record<string, ClassDims> = {
  j70: { loaM: 6.934, beamM: 2.249, bowCm: 265 }, // 22.75 ft x 7.38 ft, https://www.jboats.com/j70-tech-specs
  j22: { loaM: 6.86, beamM: 2.44, bowCm: 272 }, // https://www.jboats.com/j22-tech-specs
  j24: { loaM: 7.32, beamM: 2.71, bowCm: 314 }, // https://www.jboats.com/j24-tech-specs
  j88: { loaM: 8.9, beamM: 2.9, bowCm: 383 }, // https://www.jboats.com/j88-tech-specs
  j105: { loaM: 10.51, beamM: 3.35, bowCm: 437 }, // https://www.jboats.com/j105-tech-specs
  j111: { loaM: 11.1, beamM: 3.29, bowCm: 473 }, // https://www.jboats.com/j111-tech-specs
  ilca: ILCA,
  ilca4: ILCA,
  ilca6: ILCA,
  ilca7: ILCA,
  laser: ILCA,
  melges24: { loaM: 7.31, beamM: 2.489, bowCm: 282 }, // https://melges.com/pages/melges-24
  viper640: { loaM: 6.4, beamM: 2.5, bowCm: 290 }, // https://www.viper640.org/why-viper/design/
  vxone: { loaM: 5.79, beamM: 2.19, bowCm: 246 }, // https://www.vxone.com/specs
  star: { loaM: 6.922, beamM: 1.734, bowCm: 254 }, // nominal dimensions, https://starclass.org/classic/rules_items/specifications.htm
  etchells: { loaM: 9.3, beamM: 2.12, bowCm: 392 }, // hull 9300 mm, beam 2105-2125 mm at section 6, https://etchells.org/class/technical/rules-and-plans
  // International Cape 31 Class, https://www.cape31class.com/the-boat (builder CPS lists 9.56 x 3.10; ORC certificates measure 9.573 x 3.054).
  cape31: { loaM: 9.55, beamM: 3.05, bowCm: 444 },
  // IC37 Class specifications, https://ic37class.org (LOA 11.30 m, beam 3.65 m; the ORC certificates agree).
  ic37: { loaM: 11.3, beamM: 3.65, bowCm: 490 },
};

/** Other names a feed uses for a class (normalized) → its DIMS key. */
const ALIASES: Record<string, string> = {
  c31: 'cape31', // RaceSense division name / event classLabel for the C31 Gold Cup ("C31", "C 31")
  // The IC37 NA division name and boatClass are "IC37" ("IC 37" normalizes to the same DIMS key); the builder's name:
  melgesic37: 'ic37',
};

/** "J/70", "J70", "j-70" → "j70". */
export const normalizeClass = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Class dimensions, or null for an unknown class. */
export function classDims(name: string): ClassDims | null {
  const key = normalizeClass(name);
  return DIMS[ALIASES[key] ?? key] ?? null;
}

/** How a class sails downwind: an asymmetric kite (gybing ~30–45° off dead downwind), a symmetric one, or none. */
export type KiteKind = 'asym' | 'sym' | 'none';

const KITES: Record<string, KiteKind> = {
  j70: 'asym',
  j80: 'asym',
  j88: 'asym',
  j105: 'asym',
  j111: 'asym',
  melges20: 'asym',
  melges24: 'asym',
  vxone: 'asym',
  viper640: 'asym',
  cape31: 'asym',
  ic37: 'asym',
  etchells: 'sym',
  j22: 'sym',
  j24: 'sym',
  dragon: 'sym',
  star: 'none',
  ilca: 'none',
  ilca4: 'none',
  ilca6: 'none',
  ilca7: 'none',
  laser: 'none',
};

/** Other names a feed uses for a class (normalized) → its KITES key, besides ALIASES. */
const KITE_ALIASES: Record<string, string> = { m24: 'melges24', m20: 'melges20' };

/** The kite of the first of `names` (in order) that is a known class; null if none. */
export function kiteOf(names: (string | null | undefined)[]): KiteKind | null {
  for (const name of names) {
    if (!name) continue;
    const key = normalizeClass(name);
    const k = KITES[KITE_ALIASES[key] ?? ALIASES[key] ?? key];
    if (k) return k;
  }
  return null;
}

/** The first of `names` (in order) with known dimensions, and that name as given; null if none. */
export function matchClass(names: (string | null | undefined)[]): { name: string; dims: ClassDims } | null {
  for (const name of names) {
    const dims = name ? classDims(name) : null;
    if (name && dims) return { name: name.trim(), dims };
  }
  return null;
}

/** A race's class with dimensions: its division's boat class, then the division's name, then the event's class label. */
export const raceClass = (meta: { boatClass?: string | null; division?: string | null; classLabel?: string | null }): { name: string; dims: ClassDims } | null =>
  matchClass([meta.boatClass, meta.division, meta.classLabel]);

/**
 * How far the bow is ahead of the tracker, m: the feed's antenna-to-bow distance where it gives one that fits the
 * hull (over 0, at most its LOA), else the class's usual offset (ClassDims.bowCm), else half the LOA (the tracker
 * taken as amidships). With no class dimensions, the feed's distance when it gives one, else 0 (no hull drawn).
 *
 * The one answer for the whole app: the sources resolve Boat.bowOffsetM with it (racesense/adapter.ts, vkx/merge.ts),
 * and the start's distance to the line, its crossing, the ladder and the hull on the map all measure from that bow.
 * A feed that sets no offset gets the class's: at the J/70 NAs every offset was unset (-1), so race 6 measured
 * 1513's distance to the line from its tracker (3.7 m) while the hull on the map had its bow 3.5 m ahead of it;
 * from a 2.65 m bow it is 2.1 m.
 */
export function bowAheadM(bowOffsetM: number | null | undefined, dims: ClassDims | null): number {
  const set = bowOffsetM != null && Number.isFinite(bowOffsetM) && bowOffsetM > 0;
  if (!dims || !(dims.loaM > 0)) return set ? bowOffsetM : 0;
  if (set && bowOffsetM <= dims.loaM) return bowOffsetM;
  return dims.bowCm != null ? dims.bowCm / 100 : dims.loaM / 2;
}
