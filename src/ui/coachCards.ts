/**
 * The Coach's opportunity cards (spec §1, §6; the mockup's layout): number,
 * a 3–6 word title, the red seconds chip, the window in the venue's clock, at
 * most 3 key-number chips, ⚠ chips when gated, one sentence and one tip — all
 * templates with the detector's numbers filled in, the conditional fragments
 * in code. Then the ✓ Not the problem row and the ➕ Went well list (at most 3,
 * with the seconds gained).
 *
 * An official code is the penalty card (analysis/coach/penalty.ts), pinned above the ranked cards and never
 * numbered: the code, what it means, what it cost in places ("Cost 3 places — 12th on the water, scored 15th"), the
 * over-the-line figures of a scored OCS / UFD / BFD and any penalty turns. The ranked cards then sit under a heading
 * that says they are smaller than the penalty.
 *
 * A card's window chip is a toggle button: pressed, the gap chart shades the
 * card's window (a click anywhere on the card does the same).
 */
import { RACE_MIN_COVERAGE, type CoachDebrief } from '../analysis/coach/debrief';
import { D3_WINDOW_MS } from '../analysis/coach/detectors/early';
import { D9_SLOW_S } from '../analysis/coach/detectors/rounding';
import { D13_TRAFFIC_BOATS } from '../analysis/coach/detectors/gate';
import { D8_WINDOW_MS } from '../analysis/coach/detectors/shadow';
import type { Fact, GoodNote } from '../analysis/coach/opportunity';
import type { PenaltyFinding } from '../analysis/coach/penalty';
import type { PenaltyTurn } from '../analysis/coach/detectors/penaltyTurn';
import { pointsText } from '../data/official/codes';
import type { Card } from '../analysis/coach/rank';
import type { RaceAnalysis } from '../analysis/types';
import { duration, esc, f1, localTime, ordinal, pct } from './format';

/** Show a range (`10–35 s`) rather than `≈ mid` when hi/lo exceeds this. */
export const RANGE_RATIO = 2;
/** A low-confidence card names a hole in its window this long or longer, s. */
export const HOLE_CHIP_S = 60;
export const KEY_CHIPS_MAX = 3;
/** The merged start card (D1 + D3) has one more: back at the gun, place over the line, crossing time, early tacks. */
export const START_CHIPS_MAX = 4;
/** How many key-number chips card `c` shows. */
export const chipsMax = (c: Pick<Card, 'kind' | 'facts'>): number => (c.kind === 'D1' && c.facts.d3S != null ? START_CHIPS_MAX : KEY_CHIPS_MAX);

const num = (f: Fact): number => (typeof f === 'number' ? f : NaN);
const r0 = (f: Fact): string => String(Math.round(num(f)));
const kn = (f: Fact): string => f1(num(f));
const hm = (ms: number, tz: number): string => localTime(ms, tz).slice(0, 5);
/** "3:51" after the gun. */
const mss = (s: Fact): string => duration(num(s));
const s1 = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** `≈ 30 s`, or `10–35 s` when the bound is loose (hi/lo > RANGE_RATIO). */
export function secondsChip(c: Pick<Card, 'seconds' | 'secondsLo' | 'secondsHi'>): string {
  const lo = Math.round(c.secondsLo);
  const hi = Math.round(c.secondsHi);
  return hi / Math.max(1, lo) > RANGE_RATIO ? `${lo}–${hi} s` : `≈ ${Math.round(c.seconds)} s`;
}

/** The window in the venue's clock (`11:06–11:11`), or the legs when it spans several (`Run 1 + Run 2`). */
export function windowChip(c: Card, a: RaceAnalysis): string {
  if (c.spans && c.spans.length > 1 && typeof c.facts.legs === 'string') return c.facts.legs;
  const tz = a.meta.tzOffsetMs;
  const p = hm(c.t0, tz);
  const q = hm(c.t1, tz);
  return p === q ? p : `${p}–${q}`;
}

export interface CardText {
  title: string;
  /** Key-number chips, at most KEY_CHIPS_MAX. */
  chips: string[];
  sentence: string;
  tip: string;
}

const windWord = (w: Fact): string => (w === 'light' ? 'light-air' : w === 'fresh' ? 'fresh' : 'medium-air');

/** "the boats that finished 5th–10th", or "the boats near you" (the Near fallback). */
const peersPhrase = (f: Card['facts']): string =>
  f.peersAhead && f.placeLo != null && f.placeHi != null ? `the boats that finished ${ordinal(num(f.placeLo))}–${ordinal(num(f.placeHi))}` : 'the boats near you';

/** When D5's peers aren't the page's reference set: "vs 5th–10th", or "vs boats near you". */
export function d5RefChip(f: Card['facts']): string | null {
  if (f.placeLo != null && f.placeHi != null) return `vs ${ordinal(num(f.placeLo))}–${ordinal(num(f.placeHi))}`;
  if (f.peersAhead === 0) return 'vs boats near you';
  return null;
}

/** "67 s up" / "level" / "20 s down": a gap as the boat sees it (+ = behind). */
const upDown = (behindS: Fact): string => {
  const v = Math.round(num(behindS));
  return v < 0 ? `${-v} s up` : v > 0 ? `${v} s down` : 'level';
};

/** Title, chips, sentence and tip for a card: one template per detector variant (spec §6). `tz`: the venue's offset, for clock times in the sentence. */
export function cardText(c: Card, tz = 0): CardText {
  const f = c.facts;
  const sec = r0(c.seconds);
  switch (c.kind) {
    case 'D1': {
      const crossed = f.crossRank != null;
      const rank = crossed ? `${ordinal(num(f.crossRank))} of ${r0(f.n)}` : '';
      const front = frontPhrase(f);
      if (f.d3S != null) return startText(c, rank, front);
      if (c.variant === 'ocs') {
        return { title: ocsTitle(f), chips: ['over early', `cleared +${r0(f.crossS)} s`, `${rank} over line`], sentence: ocsLead(f, sec), tip: OCS_TIP };
      }
      if (c.variant === 'late') {
        return {
          title: 'Late over the line',
          chips: [`crossed +${r0(f.crossS)} s`, `${rank} over line`, `${r0(f.dtl)} m back at gun`],
          sentence: `You crossed ${r0(f.crossS)} s after the gun, ${rank} over the line; ${front}.`,
          tip: 'Time the final approach so you hit the line at the gun, at full speed.',
        };
      }
      return {
        title: 'Second-row start',
        chips: crossed ? [`${r0(f.dtl)} m back at gun`, `${rank} over line`, `crossed +${r0(f.crossS)} s`] : [`${r0(f.dtl)} m back at gun`],
        sentence: crossed
          ? `You were ${r0(f.dtl)} m back at the gun and ${rank} over the line; ${front}.`
          : `You were ${r0(f.dtl)} m back at the gun, about ${sec} s late.`,
        tip: `Set up closer and time the final approach; ${r0(f.dtl)} m back costs about ${sec} s.`,
      };
    }
    case 'D3': {
      const tacks = num(f.tacks);
      const tackChip = tacks >= 2 ? `${tacks} tacks by ${mss(f.lastTackS)}` : null;
      const rolled = c.chips?.find((x) => x.kind === 'D2')?.facts;
      const shadow = c.chips?.find((x) => x.kind === 'D8')?.facts;
      if (c.variant === 'slow-start' && rolled) {
        const shadowChip = shadow ? [dirtyChip(shadow)] : [];
        const tail = tacks > 1 ? ` and ${tacks} early tacks left you ${r0(f.gapEnd)} s off the top 3` : `; you were ${r0(f.gapEnd)} s off the top 3 by +5 min`;
        return {
          title: 'Slow off a great start',
          chips: [`${r0(f.dtl)} m off at gun`, `${kn(rolled.sog)} vs ${kn(rolled.nbrSog)} kn ${rolled.nbrName}`, ...(tackChip ? [tackChip] : []), ...shadowChip].slice(0, KEY_CHIPS_MAX),
          sentence: `Front row but ${kn(rolled.sog)} kn at the gun; ${rolled.nbrName}, bow-level ${r0(rolled.nbrM)} m to windward, rolled you at ${kn(rolled.nbrSog)} kn${tail}.`,
          tip: 'Hit the line at full speed. If pinned, foot a length before tacking.',
        };
      }
      const rolledChip = rolled ? [`${kn(rolled.sog)} vs ${kn(rolled.nbrSog)} kn ${rolled.nbrName}`] : [];
      // Dirty air (D8 on D3) ahead of the tack count: it says why the lane cost time.
      const dirty = shadow ? [dirtyChip(shadow)] : [];
      if (c.variant === 'tacks') {
        return {
          title: 'Early tacks off the line',
          chips: [tackChip!, ...dirty, `fleet median ${r0(f.fleetTacks)}`, ...rolledChip].slice(0, KEY_CHIPS_MAX),
          sentence: `You tacked ${tacks} times by ${mss(f.lastTackS)} after the gun, the fleet ${r0(f.fleetTacks)}, and lost ${r0(f.dgap)} s to the top 3 in the first 5 minutes.`,
          tip: 'Pick one lane off the line and stay in it; tack only into a clear lane.',
        };
      }
      return {
        title: 'Lost ground after the start',
        chips: [`${r0(f.dgap)} s to top 3 by +5 min`, ...dirty, `${tacks} ${s1(tacks, 'tack', 'tacks')}`, ...rolledChip].slice(0, KEY_CHIPS_MAX),
        sentence: `In the 5 minutes after you crossed the line you lost ${r0(f.dgap)} s to the top 3.`,
        tip: 'Sail fast in a clear lane first; foot off rather than pinch in dirty air.',
      };
    }
    case 'D4': {
      const shift = r0(f.shift);
      const ldrH = f.ldrHeaded != null ? ` vs ${f.ldr} ${pct(num(f.ldrHeaded))}` : '';
      return {
        title: `Wrong side of a ${shift}° ${f.dir} shift`,
        chips: [`wind ${r0(f.twd0)}° → ${r0(f.twd1)}°`, `headed ${pct(num(f.headed))}${ldrH}`, `${r0(f.sepM)} m ${f.side} of ${f.ldr}`],
        sentence: `You went ${f.side} while the leaders held ${f.otherSide}; the wind ${f.dir === 'left' ? 'backed' : 'veered'} ${shift}° and you spent ${pct(num(f.headed))} of those minutes headed${ldrH}.`,
        tip: 'When the wind keeps going one way, sail the lifted tack toward it; on a header more than 30 s, tack.',
      };
    }
    case 'D5': {
      if (c.variant === 'caught-leader') {
        const went = num(f.tacked) ? 'tacked' : 'stayed';
        return {
          title: num(f.tacked) ? 'Caught the leader, then tacked away' : 'Caught the leader, then let go',
          chips: [`level with ${f.ldr} ${hm(num(f.tPeak), tz)}`, `${r0(f.sepM)} m apart`, `${r0(f.gTrough)} s behind by ${hm(num(f.tTrough), tz)}`],
          sentence: `Even with ${f.ldr} at ${hm(num(f.tPeak), tz)}; you ${went} ${f.side} and ${f.ldr} sailed into a ${f.dir}-hand lift, ${r0(f.gTrough)} s ahead by ${hm(num(f.tTrough), tz)}.`,
          tip: 'Once level with the leader, stay between them and the mark.',
        };
      }
      const peers = peersPhrase(f);
      const side = f.side ?? 'far';
      const chips = [`${r0(f.sepM)} m ${f.side ?? 'away'}`, ...(f.layFromM != null ? [`layline from ${r0(f.layFromM)} m`] : []), `${upDown(f.gPeak)} → ${upDown(f.gTrough)}`];
      const sentence = `The ${side} paid first, ${upDown(f.gPeak)} on ${peers}; then the wind swung back ${r0(f.shift)}° and you were ${upDown(f.gTrough)}.`;
      if (c.variant === 'overstand') {
        return {
          title: `Overstood the ${side} corner`,
          chips,
          sentence,
          tip: 'When the corner pays, tack on the next header and come back toward the fleet; avoid early laylines.',
        };
      }
      return { title: `Gave back a ${side} gain`, chips, sentence, tip: 'Bank gains: tack on the header and get back between the fleet and the mark.' };
    }
    case 'D6': {
      // D11 on the same beat: the heel chip in place of the VMG one (the sentence has the VMG).
      const heel = c.chips?.find((x) => x.kind === 'D11')?.facts;
      const chips = [...(heel ? [heelChip(heel)] : []), `${r0(f.twa)}° vs fleet ${r0(f.fTwa)}°`, `${kn(f.sog)} vs ${kn(f.fSog)} kn`, `VMG ${kn(f.vmg)} vs ${kn(f.fVmg)} kn`].slice(0, KEY_CHIPS_MAX);
      const sentence = `In the same minutes you sailed ${r0(f.twa)}° to the wind at ${kn(f.sog)} kn, the fleet ${r0(f.fTwa)}° at ${kn(f.fSog)} kn; VMG ${kn(f.vmg)} vs ${kn(f.fVmg)} kn${heel ? `, ${heelClause(heel)}` : ''}.`;
      if (c.variant === 'high-slow') return { title: 'Pinching upwind', chips, sentence, tip: 'Ease a touch and sail for speed; height comes once the boat is moving.' };
      if (c.variant === 'low-fast') return { title: 'Footing too low upwind', chips, sentence, tip: 'You have the speed: trim for height and point higher.' };
      return { title: 'Slow upwind', chips, sentence, tip: 'Check trim and weight against the boats around you; change one thing at a time.' };
    }
    case 'D7': {
      const runs = num(f.runs) > 1 ? 'runs' : 'run';
      const w = windWord(f.wind);
      const top = f.tTwa != null;
      const boatTwa = num(f.twa);
      const refTwa = top ? num(f.tTwa) : num(f.fTwa);
      const deeper = boatTwa > refTwa;
      const hotter = boatTwa < refTwa;
      // Angle chip only when it supports the claim: too deep / too hot, or a
      // speed card where the boat was actually deeper. Higher than the top 3
      // on a "slow on the run" card is noise.
      const angleOk = c.variant === 'hot' ? hotter : deeper;
      const angle = top ? `${r0(f.twa)}° vs top-3 ${r0(f.tTwa)}°` : `${r0(f.twa)}° vs fleet ${r0(f.fTwa)}°`;
      const heel = c.chips?.find((x) => x.kind === 'D11')?.facts;
      const chips = [
        ...(heel ? [heelChip(heel)] : []),
        ...(angleOk ? [angle] : []),
        top && f.tSog != null ? `${kn(f.sog)} vs ${kn(f.tSog)} kn` : `${kn(f.sog)} vs ${kn(f.fSog)} kn`,
        `VMG ${kn(f.vmg)} vs fleet ${kn(f.fVmg)} kn`,
      ].slice(0, KEY_CHIPS_MAX);
      const heelTail = heel ? `; ${heelClause(heel)}` : '';
      const angles = top
        ? `You sailed ${r0(f.twa)}° vs the top 3's ${r0(f.tTwa)}° at ${kn(f.sog)} vs ${kn(f.tSog)} kn${heelTail}.`
        : `You sailed ${r0(f.twa)}° vs the fleet's ${r0(f.fTwa)}° at ${kn(f.sog)} vs ${kn(f.fSog)} kn${heelTail}.`;
      if (c.variant === 'deep') {
        return {
          title: `Too deep on the ${w} ${runs}`,
          chips,
          sentence: angles,
          tip: f.wind === 'light' ? 'In light air sail hotter angles; head up when speed drops, gybe on the angle.' : 'Sail hotter in the lulls and soak low only in the puffs; gybe on the angle.',
        };
      }
      if (c.variant === 'hot') return { title: `Too hot on the ${w} ${runs}`, chips, sentence: angles, tip: 'Soak lower in the puffs: the speed was there, the extra distance cost it.' };
      return {
        title: `Slow on the ${w} ${runs}`,
        chips,
        sentence: `Your downwind VMG was ${kn(f.vmg)} vs the fleet's ${kn(f.fVmg)} kn, at ${r0(f.twa)}° and ${kn(f.sog)} kn${heelTail}.`,
        tip: 'Keep someone calling pressure and gybe into the puffs.',
      };
    }
    case 'D8': {
      const by = f.byName ? [`mostly behind ${f.byName}`] : [];
      return {
        title: 'Dirty air early on the beats',
        chips: [dirtyChip(f), `${r0(f.stretches)} ${s1(num(f.stretches), 'stretch', 'stretches')}`, ...by],
        sentence: `In the first ${D8_WINDOW_MS / 60_000} minutes of the beats you sailed ${pct(num(f.share))} of the time in another boat's wind shadow (fleet ${pct(num(f.fleetShare))}) and lost ${r0(f.dgap)} s to the top 3 in those stretches.`,
        tip: 'Get a clear lane: tack or foot out of a boat’s shadow within a few lengths; don’t sit in its wind.',
      };
    }
    case 'D9': {
      if (f.mode === 'places') return placesText(f);
      const where = roundingName(f);
      const ref = d9RefPhrase(f);
      const wide = num(f.wide) === 1;
      const wideBy = `${r0(f.wideLoa)} ${num(f.wideLoa) >= 1.5 ? 'lengths' : 'length'}`;
      const slow = num(f.dS) >= D9_SLOW_S;
      const lower = String(f.mark).toLowerCase();
      const chips = [
        `${r0(f.zoneS)} s vs ${r0(f.refZoneS)} s in the zone`,
        ...(f.exitM != null && f.refExitM != null ? [`exit ${r0(f.exitM)} m vs ${r0(f.refExitM)} m off`] : []),
        ...(f.ref !== 'leaders' ? [d9RefChip(f)] : []),
      ];
      const sentence = slow
        ? `${where}: ${r0(f.dS)} s slower than ${ref} through the zone${wide ? `, exited ${wideBy} wide` : ''}.`
        : `${where}: exited ${wideBy} wider than ${ref}; ${r0(f.zoneS)} s in the zone vs ${r0(f.refZoneS)} s.`;
      return {
        title: slow ? `Slow ${lower} rounding` : `Wide at the ${lower}`,
        chips,
        sentence,
        tip: ROUNDING_TIPS[String(f.type)] ?? ROUNDING_TIPS.windward,
      };
    }
    case 'D10': {
      const b = f.b != null && num(f.db) >= 1 ? ` and ${f.b} ${r0(f.db)} s` : '';
      const places = num(f.placeLo) === num(f.placeHi) ? ordinal(num(f.placeLo)) : `${ordinal(num(f.placeLo))}/${ordinal(num(f.placeHi))}`;
      const ahead = r0(f.aheadLo) === r0(f.aheadHi) ? `${r0(f.aheadLo)} s` : `${r0(f.aheadLo)}–${r0(f.aheadHi)} s`;
      const chips = [...(f.sog != null && f.ldrSog != null ? [`${kn(f.sog)} vs ${kn(f.ldrSog)} kn`] : []), `${places} ${ahead} ahead`];
      const sentence = `${f.a} pulled ${r0(f.da)} s${b} further ahead over the last ${r0(f.mins)} tracked minutes.`;
      return c.variant === 'beat'
        ? { title: 'Last beat, lost to the boats ahead', chips, sentence, tip: 'Sail the lifted tack and stay between the boats just ahead and the finish.' }
        : { title: 'Last run, short of pressure', chips, sentence, tip: 'Keep someone calling pressure and gybe into the puffs.' };
    }
    case 'D11':
      return heelText(c.variant, f);
    case 'D12': {
      const loops = num(f.loops);
      const at = localTime(num(f.firstMs), tz);
      const mins = Math.round(num(f.firstS) / 60);
      const what = c.variant === '720' ? 'a 720' : 'a 360';
      return {
        title: c.variant === '720' ? 'Penalty turns (720)' : 'Penalty turn (360)',
        chips: [`at ${at} (+${mins} min)`, `${r0(f.turns)} ${s1(num(f.turns), 'turn', 'turns')}`, ...(loops > 1 ? [`${loops} times`] : [])],
        sentence:
          loops > 1
            ? `You did penalty turns ${loops} times, the first (${what}) at ${at}, ${mins} min after the gun; together they cost about ${sec} s against your course and speed before each.`
            : `You did ${what} at ${at}, ${mins} min after the gun; it cost about ${sec} s against your course and speed before it.`,
        tip: TURN_TIP,
      };
    }
    case 'D13':
      return gateText(c);
    default:
      return { title: 'Time lost', chips: [], sentence: `About ${sec} s.`, tip: '' };
  }
}

/** "the front row crossed within 1 s of the gun" (its median is never before the gun; its first may be), or "6–9 s after the gun". */
function frontPhrase(f: Card['facts']): string {
  const lo = Math.round(num(f.frontLo));
  const hi = Math.round(num(f.frontHi));
  return lo < 1 || hi <= 1 ? `the front row crossed within ${Math.max(1, hi)} s of the gun` : `the front row crossed ${lo}–${hi} s after the gun`;
}

/** "0–1 times" (a median between two counts), "1 time". */
const timesPhrase = (v: Fact): string => {
  const lo = Math.floor(num(v));
  const hi = Math.ceil(num(v));
  return lo === hi ? `${lo} ${s1(lo, 'time', 'times')}` : `${lo}–${hi} times`;
};

/** Over early (D1 'ocs'): "Over early — cleared at +28 s"; the seconds are the red chip's. */
const ocsTitle = (f: Card['facts']): string => `Over early — cleared at +${r0(f.crossS)} s`;
const ocsLead = (f: Card['facts'], behindS: string): string =>
  `You were over at the gun and had to come back; you cleared at +${r0(f.crossS)} s, about ${behindS} s behind the front row.`;
const OCS_TIP = 'Hold a safe gap to the line in the last 30 s; a bow out costs far more than a second late.';
const TURN_TIP = 'Keep clear early: a penalty turn costs far more than giving room or ducking.';

/** D1 with the D3 after it (debrief.ts mergeStart): the start and the first 5 minutes as one card. */
function startText(c: Card, rank: string, front: string): CardText {
  const f = c.facts;
  const crossed = f.crossRank != null;
  const tacks = num(f.tacks);
  const d3 = Math.round(num(f.d3S));
  const rolled = c.chips?.find((x) => x.kind === 'D2')?.facts;
  const shadow = c.chips?.find((x) => x.kind === 'D8')?.facts;
  // The fourth chip: the early tacks, else why the first minutes cost time (dirty air, rolled).
  const extra = tacks >= 2 ? `${tacks} early tacks` : shadow ? dirtyChip(shadow) : rolled ? `${kn(rolled.sog)} vs ${kn(rolled.nbrSog)} kn ${rolled.nbrName}` : null;
  const ocs = c.variant === 'ocs';
  const base = ocs
    ? ['over early', `cleared +${r0(f.crossS)} s`, `${rank} over line`]
    : crossed
      ? [`${r0(f.dtl)} m back at gun`, `${rank} over line`, `crossed +${r0(f.crossS)} s`]
      : [`${r0(f.dtl)} m back at gun`];
  const lead = ocs
    ? ocsLead(f, r0(f.d1S))
    : c.variant === 'late' && crossed
      ? `You crossed ${r0(f.crossS)} s after the gun, ${rank} over the line; ${front}.`
      : crossed
        ? `You were ${r0(f.dtl)} m back at the gun and ${rank} over the line; ${front}.`
        : `You were ${r0(f.dtl)} m back at the gun, about ${r0(f.d1S)} s late.`;
  const by = num(f.lastTackS) < 120 ? `${r0(f.lastTackS)} s` : `${Math.round(num(f.lastTackS) / 60)} min`;
  const air = c.variant === 'second-row' || shadow ? ' looking for clear air' : '';
  const cost = d3 >= 1 ? ` cost about ${d3} s more on the top 3` : '';
  const then =
    tacks >= 2
      ? ` Then ${tacks} tacks in the first ${by}${air} (the fleet tacked ${timesPhrase(f.fleetTacks)})${cost}.`
      : d3 >= 1
        ? ` Then you lost about ${d3} s more on the top 3 in the first ${D3_WINDOW_MS / 60_000} minutes.`
        : '';
  return {
    title: ocs ? ocsTitle(f) : c.variant === 'late' ? 'Late over the line' : 'Second-row start',
    chips: [...base, ...(extra ? [extra] : [])].slice(0, START_CHIPS_MAX),
    sentence: `${lead}${then}`,
    tip: ocs
      ? `${OCS_TIP} Coming back up, foot for clear air before tacking.`
      : 'Set up closer and time the final approach so you hit the line at the gun. From the second row, foot for clear air before tacking.',
  };
}

/** Who D11 compared with: "the top 3", or "the boats near you" (the peers fallback). */
const heelRef = (f: Record<string, Fact>): string => (f.ref === 'peers' ? 'the boats near you' : 'the top 3');
const heelRefShort = (f: Record<string, Fact>): string => (f.ref === 'peers' ? 'peers' : 'top 3');
/** "0.2 kt slower" / "0.2 kt faster" in VMG (dVmg: + = slower). */
const vmgWord = (dVmg: Fact): string => `${f1(Math.abs(num(dVmg)))} kt ${num(dVmg) >= 0 ? 'slower' : 'faster'}`;

/** How the heel differed, as a chip: "heel 18° vs 14° top 3" (the spread for a rolling run). */
export function heelChip(f: Record<string, Fact>): string {
  if (f.variant === 'rolling') return `heel ±${r0(f.std)}° vs ±${r0(f.refStd)}° ${heelRefShort(f)}`;
  return `heel ${r0(f.heel)}° vs ${r0(f.refHeel)}° ${heelRefShort(f)}`;
}

/** The heel difference as a clause: "~4° more heeled than the top 3" (D11 on a D6 / D7 card). */
export function heelClause(f: Record<string, Fact>): string {
  const d = r0(Math.abs(num(f.dHeel)));
  const ref = heelRef(f);
  if (f.variant === 'over') return `~${d}° more heeled than ${ref}`;
  if (f.variant === 'under') return `~${d}° flatter than ${ref}`;
  if (f.variant === 'windward') return `~${d}° more to windward than ${ref}`;
  return `heel swinging ±${r0(f.std)}° vs ±${r0(f.refStd)}° for ${ref}`;
}

/** D11's card: one template per direction; the tips generic (no rig settings). */
function heelText(variant: string, f: Record<string, Fact>): CardText {
  const leg = String(f.leg);
  const lower = num(f.dTwa);
  // Upwind: sailing lower (wider) or higher than the group, when it is clear of the angle noise (D6_TWA_DEG).
  const angle = f.legKind === 'upwind' && Math.abs(lower) >= 2 ? `, ${r0(Math.abs(lower))}° ${lower > 0 ? 'lower' : 'higher'}` : '';
  const chips = [heelChip(f), `VMG ${kn(f.vmg)} vs ${kn(f.refVmg)} kn`, `${r0(f.windows)} of ${r0(f.of)} windows`];
  const sentence = `${leg}: you sailed ${heelClause(f)}${angle} and were ${vmgWord(f.dVmg)} in VMG.`;
  if (variant === 'over') return { title: `Over-heeled on ${leg}`, chips, sentence, tip: 'Ease or depower in the puffs, or hike harder: keep the boat on its lines.' };
  if (variant === 'under') {
    return {
      title: `Too flat on ${leg}`,
      chips,
      sentence,
      tip: f.wind === 'light' ? 'In light air let the boat heel a little: weight to leeward helps the sails set and the helm load up.' : 'Power up and let the boat heel to its groove, like the boats going faster.',
    };
  }
  if (variant === 'windward') return { title: `Heeled to windward on ${leg}`, chips, sentence, tip: 'On the runs keep the boat flat; heel to windward only as far as the faster boats do.' };
  return { title: `Rolling on ${leg}`, chips, sentence: `${leg}: your heel swung ±${r0(f.std)}° vs ±${r0(f.refStd)}° for ${heelRef(f)} and you were ${vmgWord(f.dVmg)} in VMG.`, tip: 'Steady the boat on the runs: smooth steering and trim, and keep the weight still.' };
}

/** D9's low-resolution fallback: places lost through the rounding (sparse data), with the shift note when the other side gained too. */
function placesText(f: Card['facts']): CardText {
  const where = roundingName(f);
  const lower = String(f.mark).toLowerCase();
  const span = `${ordinal(num(f.before))} → ${ordinal(num(f.after))} of ${r0(f.fleet)}`;
  const shift = f.shiftSide != null;
  const tail = shift
    ? ` Boats coming in from the ${f.shiftSide} (looking upwind) gained ${f1(num(f.shiftGain))} places on average through it too: more likely a shift than the rounding.`
    : '';
  return {
    title: `Lost places at the ${lower}`,
    chips: [span, `passed by ${r0(f.passers)}`, shift ? `${f.shiftSide} side gained ${f1(num(f.shiftGain))}` : 'sparse data'],
    sentence: `${where}: lost ${r0(f.lost)} places through the rounding, ${span} (sparse data, timing approximate).${tail}`,
    tip: shift
      ? `Look up the course before the mark: the boats from the ${f.shiftSide} brought more pressure or a shift in with them.`
      : (ROUNDING_TIPS[String(f.type)] ?? ROUNDING_TIPS.windward),
  };
}

/** "lost 10 places" / "gained 2 places" / "no places lost" (D13: between the contours). */
const placesPhrase = (gained: Fact): string => {
  const g = Math.round(num(gained));
  return g < 0 ? `lost ${-g} ${s1(-g, 'place', 'places')}` : g > 0 ? `gained ${g} ${s1(g, 'place', 'places')}` : 'no places lost';
};
/** "net +4 s" / "net −12 s" (+ = gained overall). */
const netPhrase = (s: Fact): string => `net ${num(s) < 0 ? '−' : '+'}${Math.abs(Math.round(num(s)))} s`;
const GATE_TIP = 'Before the gate, look upwind: round the buoy further upwind unless it is crowded, and the one on the side you want for the next beat.';

/** D13's card: the unfavoured buoy of a favoured gate (sides looking upwind), D9's places at the same rounding as a chip. */
function gateText(c: Card): CardText {
  const f = c.facts;
  const places = c.chips?.find((x) => x.kind === 'D9')?.facts;
  const where = roundingName(f);
  const net = f.netS != null ? ` The ${f.beatSide} paid up the next beat: ${netPhrase(f.netS)}.` : '';
  // The favoured buoy was busy, but its queue still came out ahead: no traffic excuse (gate.ts busy).
  const busy = num(f.traffic) >= D13_TRAFFIC_BOATS && f.trafficS != null ? ` The ${f.fav} mark was busy (${r0(f.traffic)} boats just ahead), but they were still ${r0(-num(f.trafficS))} s quicker.` : '';
  const lost = num(f.gained) < 0 ? `you ${placesPhrase(f.gained)}` : `you ${num(f.gained) > 0 ? 'still ' : ''}${placesPhrase(f.gained)}`;
  return {
    title: `Unfavoured gate mark (${f.side})`,
    chips: [
      `${f.side} mark · ${r0(f.deltaM)} m downwind`,
      `${f.fav} side ${r0(f.empS)} s quicker`,
      places ? `${ordinal(num(places.before))} → ${ordinal(num(places.after))} of ${r0(places.fleet)} at the mark` : num(f.gained) < 0 ? placesPhrase(f.gained) : `${f.fav} mark ${r0(f.nFav)} boats, ${f.side} ${r0(f.nOther)}`,
    ],
    sentence: `${where}: took the ${f.side} mark (looking upwind) — ${r0(f.deltaM)} m further downwind, about ${r0(f.beatS)} s on the beat. Boats rounding the ${f.fav} mark at the same time were ${r0(f.ownS)} s quicker 300 m up the beat; ${lost}.${busy}${net}`,
    tip: GATE_TIP,
  };
}

/** D13's ➕ and ✓ lines (no glyph). */
function gateWent(n: GoodNote): string {
  const f = n.facts;
  const where = roundingName(f);
  if (n.variant === 'traffic') {
    const gained = num(f.gained) > 0 ? `; ${placesPhrase(f.gained)}` : '';
    return `${where}: favoured gate was busy (${r0(f.traffic)} ${s1(num(f.traffic), 'boat', 'boats')} ahead) — the clear one was reasonable${gained}`;
  }
  if (n.variant === 'net') return `${where}: took the ${f.side} gate (unfavoured by ~${r0(f.deltaM)} m / ${r0(f.beatS)} s), and the ${f.beatSide} paid off up the next beat — ${netPhrase(f.netS)}`;
  return `${where}: took the favoured ${f.side} mark (${r0(f.deltaM)} m further upwind) and ${placesPhrase(f.gained)}`;
}

/** D8 as a chip: "20% in dirty air vs fleet 2%". */
export const dirtyChip = (f: Card['facts']): string => `${pct(num(f.share))} in dirty air vs fleet ${pct(num(f.fleetShare))}`;

/** "Leeward gate, 2nd rounding" (the count only when the race rounded that kind of mark more than once). */
export const roundingName = (f: Record<string, Fact>): string => `${f.mark}${num(f.of) > 1 ? `, ${ordinal(num(f.nth))} rounding` : ''}`;

/** Who a rounding was compared with, in the sentence. */
const d9RefPhrase = (f: Card['facts']): string =>
  f.ref === 'leaders' ? 'the leaders' : f.ref === 'own' ? `your other ${String(f.type)} roundings` : `${r0(f.refN)} boats with data`;

/** …and as a chip when it is not the leaders (the card says so: spec D9 fallback). */
const d9RefChip = (f: Card['facts']): string => (f.ref === 'own' ? 'vs your own roundings: no leader data' : `vs ${r0(f.refN)} boats: no leader data`);

const ROUNDING_TIPS: Record<string, string> = {
  windward: 'Plan the bear-away: come in on the layline, ease the main as you turn, hoist once round.',
  leeward: 'Wide in, tight out: drop early, swing wide on the approach and leave close to the mark.',
  offset: 'Set up early for the offset: hoist and settle before it, then turn tight.',
  reach: 'Turn tight at the reach marks and trim for the new angle as you go round.',
};

/** The ⚠ chips (spec §5): medium → what capped it (`data 58%`, `marks est.`…); low → `low confidence` and its reason; `wind est.`; race under 25 % → `low data`. */
export function cardWarnings(c: Card, a: RaceAnalysis, raceCov?: number | null): string[] {
  const out: string[] = [];
  const why = (): string =>
    c.limit === 'data'
      ? `data ${pct(c.coverage)}`
      : c.limit === 'marks'
        ? 'marks est.'
        : c.limit === 'wind'
          ? 'wind est.'
          : c.kind === 'D12'
            ? 'from the tracker feed'
            : c.kind === 'D13'
            ? num(c.facts.shift) === 1
              ? 'wind shifting'
              : 'few boats a side'
            : c.kind === 'D9' && c.facts.mode === 'places'
            ? c.facts.shiftSide != null
              ? 'likely a shift'
              : 'sparse data'
            : c.kind === 'D9' && c.facts.ref !== 'leaders'
              ? 'no leader data'
              : c.kind === 'D11' && c.facts.ref === 'peers'
                ? 'no leader heel data'
                : c.kind === 'D11' && c.facts.legKind === 'downwind'
                  ? 'heel on runs: indicative'
                  : 'few boats to compare';
  if (c.confidence === 'medium') out.push(why());
  if (c.confidence === 'low') {
    out.push('low confidence');
    const h = c.conf.hole;
    if (h && (h.toMs - h.fromMs) / 1000 >= HOLE_CHIP_S) {
      const g = a.meta.gunMs;
      out.push(`no data ${Math.round((h.fromMs - g) / 60_000)}–${Math.round((h.toMs - g) / 60_000)} min`);
    } else out.push(why());
  }
  if (c.windEst && !out.includes('wind est.')) out.push('wind est.');
  if (raceCov != null && raceCov < RACE_MIN_COVERAGE) out.push('low data');
  return out;
}

/** A ➕ Went well line (no glyph): "Beat 2: gained 34 s on the top 3". */
export function wentText(n: GoodNote): string {
  const f = n.facts;
  const s = r0(n.seconds ?? f.gainS);
  if (n.detector === 'D9') return `${roundingName(f)}: ${s} s quicker than the top 3 through the zone`;
  if (n.detector === 'D13') return gateWent(n);
  if (n.detector === 'D1') return `Start: crossed the line ${s} s ahead of the top 3`;
  if (n.detector === 'D3') return `First ${D3_WINDOW_MS / 60_000} minutes: gained ${s} s on the top 3`;
  if (n.detector === 'D11') return `${f.leg}: ${heelClause(f)} and ${vmgWord(f.dVmg)} in VMG`;
  return f.how === 'time' ? `${f.leg}: ${s} s faster than the top 3's leg time` : `${f.leg}: gained ${s} s on the top 3`;
}

/** "✓ Upwind pointing 40° vs fleet 42°" etc. (no glyph: the row adds it). */
export function goodTexts(n: GoodNote): string[] {
  const f = n.facts;
  if (n.kind === 'plus') return [wentText(n)];
  if (n.detector === 'D1') return [`Start ${r0(f.dtl)} m off the line at the gun`];
  if (n.detector === 'D4') return ['Shifts: on the lifted side'];
  if (n.detector === 'D5') return ['Banked gains'];
  if (n.detector === 'D8') return [`Clear air: ${pct(num(f.share))} in shadow vs fleet ${pct(num(f.fleetShare))}`];
  if (n.detector === 'D9') return [`Mark roundings: ${r0(f.n)} timed, none slow or wide`];
  if (n.detector === 'D13') return [gateWent(n)];
  if (n.detector === 'D11') return [`Heel upwind ${r0(f.heel)}° vs ${heelRefShort(f)} ${r0(f.refHeel)}°`];
  const side = n.detector === 'D6' ? 'Upwind' : 'Downwind';
  return [`${side} ${n.detector === 'D6' ? 'pointing' : 'angles'} ${r0(f.twa)}° vs fleet ${r0(f.fTwa)}°`, `${side} VMG ${kn(f.vmg)} vs fleet ${kn(f.fVmg)} kn`];
}

const chip = (text: string, cls = ''): string => `<li class="chip${cls ? ` ${cls}` : ''}">${esc(text)}</li>`;
const warnLi = (text: string): string => `<li class="chip warn"><span aria-hidden="true">⚠ </span><span class="vh">Warning: </span>${esc(text)}</li>`;

/** One card. `on`: its window is shaded on the chart. */
export function cardHtml(c: Card, i: number, a: RaceAnalysis, on: boolean, raceCov?: number | null): string {
  const t = cardText(c, a.meta.tzOffsetMs);
  const when = windowChip(c, a);
  const secs = secondsChip(c);
  const ref = c.kind === 'D5' ? d5RefChip(c.facts) : null;
  const chips = [
    `<li class="chip sec" title="Seconds at stake">${esc(secs)}</li>`,
    `<li><button type="button" class="chip opp-when" data-opp="${i}" aria-pressed="${on}" title="Show on the gap chart" aria-label="${esc(`${when}: show on the gap chart`)}">${esc(when)}</button></li>`,
    ...(ref ? [chip(ref)] : []),
    ...t.chips.slice(0, chipsMax(c)).map((x) => chip(x)),
    ...cardWarnings(c, a, raceCov).map(warnLi),
  ].join('');
  return `<article class="card coach-opp${on ? ' on' : ''}" data-opp="${i}" data-kind="${c.kind}" aria-labelledby="coach-opp-${i}">
    <span class="opp-n" aria-hidden="true">${i + 1}</span>
    <h4 id="coach-opp-${i}"><span class="vh">${i + 1}. </span>${esc(t.title)}</h4>
    <ul class="chips">${chips}</ul>
    <p class="opp-what">${esc(t.sentence)}</p>
    ${t.tip ? `<p class="opp-tip"><b>Tip</b> ${esc(t.tip)}</p>` : ''}
  </article>`;
}

// ---- the penalty card

/** "15th", or "13.9 points" (an SCP score is fractional). */
export const scoredWord = (p: number): string => (Number.isInteger(p) ? ordinal(p) : `${pointsText(p)} points`);
const placesWord = (n: number): string => `${pointsText(n)} ${n === 1 ? 'place' : 'places'}`;

/** A penalty turn as the card says it: "720 at 11:23:40 (+18 min), ≈ 45 s". */
export function turnChip(t: PenaltyTurn, gunMs: number, tz: number): string {
  const lost = t.lostS != null ? `, ≈ ${Math.round(t.lostS)} s` : '';
  return `${t.turns === 2 ? '720' : '360'} at ${localTime(t.t0, tz)} (+${Math.round((t.t0 - gunMs) / 60_000)} min)${lost}`;
}

/** The penalty card's text: the title (what it cost), the chips (the code first), a sentence (what the code means) and a tip. */
export function penaltyText(p: PenaltyFinding, a: Pick<RaceAnalysis, 'meta'>): CardText & { code: string } {
  const tz = a.meta.tzOffsetMs;
  const gun = a.meta.gunMs;
  let title: string;
  let sailed = '';
  if (p.lost) {
    title = `Scored ${p.code}${p.points != null ? ` — ${pointsText(p.points)} points` : ''}; the result is lost`;
    if (p.onWater != null) sailed = ` You sailed on to ${ordinal(p.onWater)} on the water.`;
  } else if (p.onWater != null && p.points != null) {
    const where = `${ordinal(p.onWater)} on the water, scored ${scoredWord(p.points)}`;
    const n = p.penaltyPlaces ?? 0;
    title = p.points < p.onWater ? `Score adjusted — ${where}` : n > 0 ? `Cost ${placesWord(n)} — ${where}` : `No places lost — ${where}`;
  } else title = `Scored ${p.code}${p.points != null ? ` — ${pointsText(p.points)} points` : ''}`;
  const o = p.over;
  const overChips = o
    ? [
        ...(o.overM != null ? [`over ${Math.max(1, Math.round(o.overM))} m at gun`] : []),
        ...(o.backS != null ? [`back +${Math.round(o.backS)} s`] : []),
        ...(o.clearedS != null ? [`recrossed +${Math.round(o.clearedS)} s`] : []),
      ]
    : [];
  const turnChips = p.turns.map((t) => `penalty turn ${turnChip(t, gun, tz)}`);
  const turnS = p.turns.reduce((s, t) => s + (t.lostS ?? 0), 0);
  const turns = p.turns.length
    ? ` The track shows ${p.turns.length === 1 ? 'a penalty turn' : `${p.turns.length} penalty turns`} (${p.turns.map((t) => (t.turns === 2 ? '720' : '360')).join(', ')})${turnS >= 1 ? `, about ${Math.round(turnS)} s lost` : ''}.`
    : '';
  const over = o && (o.overM != null || o.backS != null) ? ` You were over at the gun${o.clearedS != null ? ` and recrossed at +${Math.round(o.clearedS)} s` : ''}.` : '';
  const tip = o ? OCS_TIP : p.turns.length ? TURN_TIP : '';
  return { code: p.code, title, chips: [...overChips, ...turnChips], sentence: `${p.meaning}.${sailed}${over}${turns}`, tip };
}

/** The pinned penalty card (no number, no seconds chip: a penalty is not ranked by seconds). */
export function penaltyHtml(p: PenaltyFinding, a: Pick<RaceAnalysis, 'meta'>): string {
  const t = penaltyText(p, a);
  const chips = [`<li class="chip pen" title="${esc(`Official result: ${p.meaning}`)}">${esc(p.code)}</li>`, ...t.chips.map((x) => chip(x))].join('');
  return `<article class="card coach-penalty" data-code="${esc(p.code)}" aria-labelledby="coach-penalty-h">
    <h4 id="coach-penalty-h"><span class="vh">Penalty: </span>${esc(t.title)}</h4>
    <ul class="chips">${chips}</ul>
    <p class="opp-what">${esc(t.sentence)}</p>
    ${t.tip ? `<p class="opp-tip"><b>Tip</b> ${esc(t.tip)}</p>` : ''}
  </article>`;
}

/** The ranked cards' heading under a penalty card: they are what cost time on the water, smaller than the penalty. */
export const rankedHead = (p: PenaltyFinding): string =>
  p.lost || (p.penaltyPlaces ?? 0) > 0 ? 'Smaller than the penalty: what cost time on the water' : 'What cost time on the water';

/** "Only 2 clear gains with this data" (fewer than 3 cards, at least one). */
export const fewerLine = (n: number): string => `Only ${n} clear ${n === 1 ? 'gain' : 'gains'} with this data`;

/** The ➕ Went well list (both Coach views): one line each, the seconds gained in bold. */
export function wentWellHtml(lines: readonly { text: string; seconds: number }[], empty = ''): string {
  if (!lines.length) return empty ? `<section class="card coach-went"><h4>Went well</h4><p class="muted">${esc(empty)}</p></section>` : '';
  const li = lines.map((l) => `<li><span class="went-s">+${Math.round(l.seconds)} s</span> ${esc(l.text)}</li>`).join('');
  return `<section class="card coach-went"><h4>Went well</h4><ul class="went-list">${li}</ul></section>`;
}

/** The cards, the "only N" line, the ✓ row and the ➕ Went well list; or the no-data line with its coverage chip. */
export function coachCardsHtml(a: RaceAnalysis, d: CoachDebrief, selected: number | null, trackerCov: number | null): string {
  // The penalty is the official result: shown whatever the tracker covered.
  if (d.noData) {
    return `${d.penalty ? penaltyHtml(d.penalty, a) : ''}<section class="card coach-nodata"><p>Not enough tracker data for a debrief</p><ul class="chips">${warnLi(`tracker ${pct(trackerCov ?? d.raceCov)}`)}</ul></section>`;
  }
  const n = d.cards.length;
  const pen = d.penalty ? `${penaltyHtml(d.penalty, a)}<h4 class="coach-ranked-head">${esc(rankedHead(d.penalty))}</h4>` : '';
  const fewer = n < 3 ? `<p class="coach-fewer muted">${n ? esc(fewerLine(n)) : 'No clear gains with this data'}</p>` : '';
  const cards = n ? `<div class="coach-opps">${d.cards.map((c, i) => cardHtml(c, i, a, selected === i, d.raceCov)).join('')}</div>` : '';
  const ok = d.ok.flatMap(goodTexts).map((x) => chip(`✓ ${x}`, 'good'));
  const row = ok.length ? `<section class="card coach-ok"><ul class="chips"><li class="ok-lbl">Not the problem</li>${ok.join('')}</ul></section>` : '';
  const went = wentWellHtml(d.plus.map((n) => ({ text: wentText(n), seconds: n.seconds ?? num(n.facts.gainS) })));
  return `${pen}${fewer}${cards}${went}${row}`;
}

/** The windows of card `i` (several for a card summed over legs), for the chart's band. */
export const cardSpans = (c: Card): [number, number][] => c.spans ?? [[c.t0, c.t1]];
