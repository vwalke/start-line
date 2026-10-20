/**
 * The start chart's, the track map's and the race notes' key lines: chips (facts,
 * ⚠ caveats, legend swatches) and the bullets of their "How to read this" (ui/info.ts).
 */
import { START_TRAIL_MS, type RaceAnalysis, type RaceNote } from '../analysis/types';
import { legSplit, pickedExcluded } from './charts';
import { warnChip, type Chip, type KeyLine } from './info';
import type { StartColour } from './sog';
import type { RankBy, SogScale, TrackColour } from './speed';
import { biasBullets, lineChips } from './startLine';

const GESTURES = 'Zoom: pinch, Ctrl/⌘ + scroll or double-tap; drag to pan when zoomed.';

/** Start chart: line, favoured end, wind, scale (+ ⚠ gaps at the gun), "line extended"; bullets for the rest. */
export function startKey(a: RaceAnalysis, o: { scale: { chip: string; info: string }; highlight?: string | null; colour?: StartColour }): KeyLine {
  const chips = [...lineChips(a), { text: o.scale.chip }];
  const gaps = a.boats.filter((b) => b.start?.dtlGapS != null).length;
  if (gaps) chips.push(warnChip(`${gaps} with a gap at the gun`, "Their GPS track has a hole across the gun: our ~ figure is interpolated"));
  chips.push({ text: 'line extended', swatch: 'ext' });
  const away = a.boats.filter((b) => b.start?.awayFromLine).length;
  if (away) chips.push({ text: away === 1 ? '1 away from the line' : `${away} away from the line` });
  if (pickedExcluded(a, o.highlight ?? null)) chips.push({ text: 'not racing', swatch: 'nc' });
  const vakaros = a.boats.some((b) => b.start?.rcDtlM != null);
  return {
    chips,
    bullets: [
      `Bows at the gun (Vakaros timing); trails: the last ${START_TRAIL_MS / 1000} s${o.colour === 'speed' ? ', shaded by speed' : ''}.`,
      o.scale.info,
      `Bow numbers: metres behind the line (${vakaros ? 'Vakaros DTL' : 'our GPS check'}; ~ = across a gap).`,
      ...biasBullets(a),
      'Names: Auto skips overlaps (tap a boat for it); All; Off = selected only.',
      ...(away ? ['Boats far from the line at the gun are listed as away from the line and left out of Fit.'] : []),
      GESTURES,
    ],
  };
}

const listOf = (xs: readonly string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One race note's chips (⚠ for what changes how the numbers read) and its short ⓘ bullets; the full sentence is the chip's title. */
function noteKey(n: RaceNote): KeyLine {
  const t = n.text;
  switch (n.kind) {
    case 'legs-fleet':
      return {
        chips: [warnChip('legs split from turns', t), ...n.est.map((m) => ({ text: `${m} est.`, title: t }))],
        bullets: [
          'Legs split where each boat turned at the top and bottom.',
          ...(n.silent.length ? [`No tracker positions from ${listOf(n.silent)}.`] : []),
          ...(n.tracked.length ? [`Tracked marks (${listOf(n.tracked)}) don't give the rounding order.`] : []),
          ...(!n.silent.length && !n.tracked.length ? ['The feed has no mark trackers for this course.'] : []),
          ...(n.est.length ? [`${cap(listOf(n.est))} placed from the tracks (est.).`] : []),
          ...(n.offset ? ['The offset mark counts as part of the following run.'] : []),
        ],
      };
    case 'leg-order':
      return { chips: [warnChip('leg order from tracks', t)], bullets: ["Leg order from the leaders' tracks; the feed's course list differs."] };
    case 'shortened':
      return { chips: [warnChip('course shortened', t)], bullets: [`Course treated as shortened (skipping ${listOf(n.dropped)}).`] };
    case 'wind-model':
      return { chips: [{ text: 'model wind', title: t }], bullets: ['Too little steady upwind sailing: wind from the weather model.'] };
    case 'wind-assumed':
      return {
        chips: [warnChip('wind assumed', t)],
        bullets: [`Too little steady upwind sailing${n.modelDeg != null ? ` (model ${n.modelDeg}° far off)` : ''}: first leg assumed upwind.`],
      };
    case 'marks-moved':
      return { chips: [{ text: `${listOf(n.names)} moved`, title: t }], bullets: [`${listOf(n.names)} moved; legs use the mark where it was then.`] };
    case 'dtl-off':
      return { chips: [warnChip('Vakaros DTL off vs GPS', t)], bullets: [`Vakaros DTL is a median ${n.medianM} m off the GPS tracks: use with care.`] };
    case 'not-racing':
      return { chips: [{ text: `${n.n} not racing`, title: t }], bullets: ['Not racing: coach or spare trackers, listed under the boat list.'] };
    case 'finish-unranked':
      return { chips: [warnChip(`${n.boat} finish not ranked`, t)], bullets: [`${n.boat}'s finish isn't ranked: ${n.why}.`] };
  }
}

/** The race findings card's notes: every caveat as a chip (⚠ ones first), the why as ⓘ bullets. */
export function raceNotesKey(a: Pick<RaceAnalysis, 'notes'>): KeyLine {
  const keys = a.notes.map(noteKey);
  const chips = keys.flatMap((k) => k.chips);
  return { chips: [...chips.filter((c) => c.warn), ...chips.filter((c) => !c.warn)], bullets: keys.flatMap((k) => k.bullets) };
}

/** Track map: how the legs were split, estimated marks and a picked not-racing boat as swatches; bullets by colour mode. */
export function mapKey(a: RaceAnalysis, o: { highlight?: string | null; colour: TrackColour; rankBy?: RankBy; sogScale?: SogScale; leg?: number | null }): KeyLine {
  const split = legSplit(a);
  const chips: Chip[] = [{ text: split.chip }];
  if (a.marks.some((m) => m.estimated)) chips.push({ text: 'estimated mark', swatch: 'est' });
  if (pickedExcluded(a, o.highlight ?? null)) chips.push({ text: 'not racing', swatch: 'nc' });
  const logged = a.boats.filter((b) => b.log);
  for (const b of logged) chips.push({ text: `${b.sail} from boat log · ${b.log!.rateHz} Hz` });
  const bullets = ['GPS tracker tracks; the few-metre bow offset is left out.', split.info];
  if (logged.length) bullets.push("A boat marked 'from boat log' is drawn from its own uploaded Vakaros log where it covers the race (shared publicly), not the public feed.");
  if (o.colour === 'leg') bullets.push('Pick a leg above to show only that leg.');
  else if (o.colour === 'rank') {
    bullets.push(
      `Rank: elapsed-time rank${o.rankBy === 'overall' ? ' over the race' : ' on each leg'}; yellow, bold = fastest.`,
      'Top 3 / 10 greys the rest; a picked boat outside them shows its rank.',
    );
  } else {
    bullets.push("Boat speed: SOG, 4 s mean; colours span the fleet's 5th–95th percentile.");
    if (o.leg == null) bullets.push("Scale: Per leg uses each leg's own range; Whole race, one range.");
    bullets.push('Hover or tap a track for boat, time, speed and leg.');
  }
  bullets.push('Select a boat anywhere to highlight it on every chart and table.');
  return { chips, bullets };
}
