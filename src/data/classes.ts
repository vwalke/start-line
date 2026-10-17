/** Hull length overall and max beam per one-design class, for drawing boats to scale. */

export interface ClassDims {
  loaM: number;
  beamM: number;
}

const ILCA: ClassDims = { loaM: 4.23, beamM: 1.37 }; // https://ilcasailing.org (ILCA Handbook 2026, "Parts of the ILCA Class dinghy")

const DIMS: Record<string, ClassDims> = {
  j70: { loaM: 6.934, beamM: 2.249 }, // 22.75 ft x 7.38 ft, https://www.jboats.com/j70-tech-specs
  j22: { loaM: 6.86, beamM: 2.44 }, // https://www.jboats.com/j22-tech-specs
  j24: { loaM: 7.32, beamM: 2.71 }, // https://www.jboats.com/j24-tech-specs
  j88: { loaM: 8.9, beamM: 2.9 }, // https://www.jboats.com/j88-tech-specs
  j105: { loaM: 10.51, beamM: 3.35 }, // https://www.jboats.com/j105-tech-specs
  j111: { loaM: 11.1, beamM: 3.29 }, // https://www.jboats.com/j111-tech-specs
  ilca: ILCA,
  ilca4: ILCA,
  ilca6: ILCA,
  ilca7: ILCA,
  laser: ILCA,
  melges24: { loaM: 7.31, beamM: 2.489 }, // https://melges.com/pages/melges-24
  viper640: { loaM: 6.4, beamM: 2.5 }, // https://www.viper640.org/why-viper/design/
  vxone: { loaM: 5.79, beamM: 2.19 }, // https://www.vxone.com/specs
  star: { loaM: 6.922, beamM: 1.734 }, // nominal dimensions, https://starclass.org/classic/rules_items/specifications.htm
  etchells: { loaM: 9.3, beamM: 2.12 }, // hull 9300 mm, beam 2105-2125 mm at section 6, https://etchells.org/class/technical/rules-and-plans
};

/** "J/70", "J70", "j-70" → "j70". */
export const normalizeClass = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Class dimensions, or null for an unknown class. */
export function classDims(name: string): ClassDims | null {
  return DIMS[normalizeClass(name)] ?? null;
}
