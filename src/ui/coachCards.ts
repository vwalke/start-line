/**
 * The Coach's opportunity cards (spec §1, §6; the mockup's layout): number,
 * a 3–6 word title, the red seconds chip, the window in the venue's clock, at
 * most 3 key-number chips, ⚠ chips when gated, one sentence and one tip — all
 * templates with the detector's numbers filled in, the conditional fragments
 * in code. Then the ✓ Not the problem / ➕ Went well row.
 *
 * A card's window chip is a toggle button: pressed, the gap chart shades the
 * card's window (a click anywhere on the card does the same).
 */
import { RACE_MIN_COVERAGE, type CoachDebrief } from '../analysis/coach/debrief';
import type { Fact, GoodNote } from '../analysis/coach/opportunity';
import type { Card } from '../analysis/coach/rank';
import type { RaceAnalysis } from '../analysis/types';
import { duration, esc, f1, localTime, ordinal, pct } from './format';

/** Show a range (`10–35 s`) rather than `≈ mid` when hi/lo exceeds this. */
export const RANGE_RATIO = 2;
/** A low-confidence card names a hole in its window this long or longer, s. */
export const HOLE_CHIP_S = 60;
export const KEY_CHIPS_MAX = 3;

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
      const front = `the front row crossed ${r0(f.frontLo)}–${r0(f.frontHi)} s after the gun`;
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
      if (c.variant === 'slow-start' && rolled) {
        const tail = tacks > 1 ? ` and ${tacks} early tacks left you ${r0(f.gapEnd)} s off the top 3` : `; you were ${r0(f.gapEnd)} s off the top 3 by +5 min`;
        return {
          title: 'Slow off a great start',
          chips: [`${r0(f.dtl)} m off at gun`, `${kn(rolled.sog)} vs ${kn(rolled.nbrSog)} kn ${rolled.nbrName}`, ...(tackChip ? [tackChip] : [])],
          sentence: `Front row but ${kn(rolled.sog)} kn at the gun; ${rolled.nbrName}, bow-level ${r0(rolled.nbrM)} m to windward, rolled you at ${kn(rolled.nbrSog)} kn${tail}.`,
          tip: 'Hit the line at full speed. If pinned, foot a length before tacking.',
        };
      }
      const rolledChip = rolled ? [`${kn(rolled.sog)} vs ${kn(rolled.nbrSog)} kn ${rolled.nbrName}`] : [];
      if (c.variant === 'tacks') {
        return {
          title: 'Early tacks off the line',
          chips: [tackChip!, `fleet median ${r0(f.fleetTacks)}`, ...rolledChip].slice(0, KEY_CHIPS_MAX),
          sentence: `You tacked ${tacks} times by ${mss(f.lastTackS)} after the gun, the fleet ${r0(f.fleetTacks)}, and lost ${r0(f.dgap)} s to the top 3 in the first 5 minutes.`,
          tip: 'Pick one lane off the line and stay in it; tack only into a clear lane.',
        };
      }
      return {
        title: 'Lost ground after the start',
        chips: [`${r0(f.dgap)} s to top 3 by +5 min`, `${tacks} ${s1(tacks, 'tack', 'tacks')}`, ...rolledChip].slice(0, KEY_CHIPS_MAX),
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
      const chips = [`${r0(f.twa)}° vs fleet ${r0(f.fTwa)}°`, `${kn(f.sog)} vs ${kn(f.fSog)} kn`, `VMG ${kn(f.vmg)} vs ${kn(f.fVmg)} kn`];
      const sentence = `In the same minutes you sailed ${r0(f.twa)}° to the wind at ${kn(f.sog)} kn, the fleet ${r0(f.fTwa)}° at ${kn(f.fSog)} kn; VMG ${kn(f.vmg)} vs ${kn(f.fVmg)} kn.`;
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
      const chips = [
        ...(angleOk ? [angle] : []),
        top && f.tSog != null ? `${kn(f.sog)} vs ${kn(f.tSog)} kn` : `${kn(f.sog)} vs ${kn(f.fSog)} kn`,
        `VMG ${kn(f.vmg)} vs fleet ${kn(f.fVmg)} kn`,
      ];
      const angles = top
        ? `You sailed ${r0(f.twa)}° vs the top 3's ${r0(f.tTwa)}° at ${kn(f.sog)} vs ${kn(f.tSog)} kn.`
        : `You sailed ${r0(f.twa)}° vs the fleet's ${r0(f.fTwa)}° at ${kn(f.sog)} vs ${kn(f.fSog)} kn.`;
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
        sentence: `Your downwind VMG was ${kn(f.vmg)} vs the fleet's ${kn(f.fVmg)} kn, at ${r0(f.twa)}° and ${kn(f.sog)} kn.`,
        tip: 'Keep someone calling pressure and gybe into the puffs.',
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
    default:
      return { title: 'Time lost', chips: [], sentence: `About ${sec} s.`, tip: '' };
  }
}

/** The ⚠ chips (spec §5): medium → what capped it (`data 58%`, `marks est.`…); low → `low confidence` and its reason; `wind est.`; race under 25 % → `low data`. */
export function cardWarnings(c: Card, a: RaceAnalysis, raceCov?: number | null): string[] {
  const out: string[] = [];
  const why = (): string =>
    c.limit === 'data' ? `data ${pct(c.coverage)}` : c.limit === 'marks' ? 'marks est.' : c.limit === 'wind' ? 'wind est.' : 'few boats to compare';
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

/** "✓ Upwind pointing 40° vs fleet 42°" etc. (no glyph: the row adds it). */
export function goodTexts(n: GoodNote): string[] {
  const f = n.facts;
  if (n.kind === 'plus') return [`${r0(f.gainS)} s on ${f.leg} vs top 3`];
  if (n.detector === 'D1') return [`Start ${r0(f.dtl)} m off the line at the gun`];
  if (n.detector === 'D4') return ['Shifts: on the lifted side'];
  if (n.detector === 'D5') return ['Banked gains'];
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
  const chips = [
    `<li class="chip sec" title="Seconds at stake">${esc(secs)}</li>`,
    `<li><button type="button" class="chip opp-when" data-opp="${i}" aria-pressed="${on}" title="Show on the gap chart" aria-label="${esc(`${when}: show on the gap chart`)}">${esc(when)}</button></li>`,
    ...t.chips.slice(0, KEY_CHIPS_MAX).map((x) => chip(x)),
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

/** "Only 2 clear gains with this data" (fewer than 3 cards, at least one). */
export const fewerLine = (n: number): string => `Only ${n} clear ${n === 1 ? 'gain' : 'gains'} with this data`;

/** The cards, the "only N" line, and the ✓ / ➕ row; or the no-data line with its coverage chip. */
export function coachCardsHtml(a: RaceAnalysis, d: CoachDebrief, selected: number | null, trackerCov: number | null): string {
  if (d.noData) {
    return `<section class="card coach-nodata"><p>Not enough tracker data for a debrief</p><ul class="chips">${warnLi(`tracker ${pct(trackerCov ?? d.raceCov)}`)}</ul></section>`;
  }
  const n = d.cards.length;
  const fewer = n < 3 ? `<p class="coach-fewer muted">${n ? esc(fewerLine(n)) : 'No clear gains with this data'}</p>` : '';
  const cards = n ? `<div class="coach-opps">${d.cards.map((c, i) => cardHtml(c, i, a, selected === i, d.raceCov)).join('')}</div>` : '';
  const ok = d.ok.flatMap(goodTexts).map((x) => chip(`✓ ${x}`, 'good'));
  const plus = d.plus.flatMap(goodTexts).map((x) => chip(`➕ ${x}`, 'good'));
  const row =
    ok.length || plus.length
      ? `<section class="card coach-ok"><ul class="chips">${ok.length ? `<li class="ok-lbl">Not the problem</li>${ok.join('')}` : ''}${plus.length ? `<li class="ok-lbl">Went well</li>${plus.join('')}` : ''}</ul></section>`
      : '';
  return `${fewer}${cards}${row}`;
}

/** The windows of card `i` (several for a card summed over legs), for the chart's band. */
export const cardSpans = (c: Card): [number, number][] => c.spans ?? [[c.t0, c.t1]];
