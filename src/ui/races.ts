/**
 * The race picker's option text and the race header's key line: official numbering, practice,
 * rebuilt races and where the finishes came from, as chips (⚠ for caveats) with the why behind
 * one ⓘ, which also holds the small form that links (or unlinks) official results by hand.
 * Times are Eastern (America/New_York), the club's clock for the events this was built for.
 */
import type { LinkOutcome } from '../data/official/link';
import { YS_EVENT_URL } from '../data/official/yachtscoring';
import { isOrphanKey } from '../data/orphans';
import type { ListedRace } from '../data/raceList';
import type { RaceResults } from '../data/types';
import { esc } from './format';
import { capHtml, warnChip, type Chip } from './info';

const ET = 'America/New_York';
const dayTime = new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const zone = new Intl.DateTimeFormat('en-US', { timeZone: ET, timeZoneName: 'short' });

/** "Wed 08:55" on the Eastern clock. */
export function easternDayTime(ms: number): string {
  const p = Object.fromEntries(dayTime.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.hour}:${p.minute}`;
}

/** "EDT" or "EST" at that moment. */
export const easternZone = (ms: number): string => zone.formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName')?.value ?? 'ET';

/** "Race 4", "Practice", or "RS 6" for a race the official results don't have. */
export function raceName(r: Pick<ListedRace, 'practice' | 'number' | 'rsNumber' | 'raceNumber'>): string {
  if (r.practice) return 'Practice';
  if (r.number != null) return `Race ${r.number}`;
  return r.rsNumber != null ? `RS ${r.rsNumber}` : 'Race';
}

/** A race name, short for tight spots: "Race 7" → `R7`; others as they are (`RS 6`, `Practice`). */
export const shortRaceName = (name: string): string => name.replace(/^Race (\d+)$/, 'R$1');

/** RaceSense's number when it differs from the one shown (practice included), for transparency. */
export const rsSuffix = (r: Pick<ListedRace, 'practice' | 'number' | 'rsNumber'>): string | null =>
  r.rsNumber != null && (r.practice || r.number !== r.rsNumber) && !(r.number == null && !r.practice) ? `RS ${r.rsNumber}` : null;

/** The race header's title: event · class · race name (as the picker names it), with RaceSense's number as a small tag when it differs. */
export function raceTitleHtml(m: { eventName: string; boatClass: string; raceNumber: number }, listed: ListedRace | undefined): string {
  const rs = listed ? rsSuffix(listed) : null;
  const title = listed ? raceName(listed) : isOrphanKey(m.raceNumber) ? 'Race' : `Race ${m.raceNumber}`;
  return `<h2>${esc(m.eventName)} · ${esc(m.boatClass)} · ${esc(title)}${rs ? ` <span class="rs-no">${esc(rs)}</span>` : ''}</h2>`;
}

/** The picker's option: `Race 4 · Wed 11:40 · RS 5`, `Practice · Mon 09:55`, `Race 3 · Wed 08:55 · RS 4 · ~ tracker`. */
export function raceOptionText(r: ListedRace, showDivision: boolean): string {
  const parts = [showDivision ? r.division : '', raceName(r), easternDayTime(r.gunMs), rsSuffix(r) ?? ''];
  if (r.rebuilt) parts.push('rebuilt');
  else if (r.finishes === 'tracker' && !r.practice) parts.push('~ tracker');
  return parts.filter(Boolean).join(' · ');
}

export type OfficialState =
  | { status: 'pending' }
  | { status: 'off' }
  | { status: 'done'; outcome: LinkOutcome };

export interface FeedCheck {
  status: 'idle' | 'running' | 'done';
  used: number;
  max: number;
  found: number;
  exhausted: boolean;
}

export interface RaceHead {
  chips: Chip[];
  bullets: string[];
  more: { title: string; items: string[] } | null;
  /** The link form's current value (the hand-set event, if any). */
  ys: number | null;
}

const listOf = (xs: readonly string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The header's chips and ⓘ for the race on screen. */
export function raceHead(o: { race: ListedRace | undefined; official: OfficialState; feed: FeedCheck; results?: RaceResults; ys?: number | null }): RaceHead {
  const { race, official, feed, results } = o;
  const chips: Chip[] = [];
  const bullets: string[] = [];
  let more: RaceHead['more'] = null;
  const outcome = official.status === 'done' ? official.outcome : null;
  const link = outcome?.status === 'linked' ? outcome : null;
  const div = link && race ? link.divisions.find((d) => d.division === race.division) : undefined;

  // Official link state.
  if (official.status === 'pending') chips.push({ text: 'checking official results…' });
  else if (official.status === 'off') chips.push({ text: 'official results off', title: 'ys=0 in the link' });
  else if (outcome?.status === 'error') chips.push(warnChip('official results unavailable', outcome.message));
  else if (outcome?.status === 'none') chips.push(warnChip('no official results linked'));
  else if (link && !div) chips.push(warnChip('no official match', `${race?.division ?? 'This division'} matched no class of Yachtscoring ${link.eventId}`));
  else if (link && div) chips.push({ text: `official · YS ${link.eventId}`, title: `${link.eventName}: ${div.cls.className}${div.cls.circle ? ` (${div.cls.circle})` : ''}` });

  if (link && div) {
    const sails = div.score.sails != null ? `, ${div.boats.pairs.length} of ${div.boats.pairs.length + div.boats.rsOnly.length} boats by sail number` : '';
    bullets.push(
      `Official results: Yachtscoring ${link.eventId}, ${link.eventName}, class ${div.cls.className}${div.cls.circle ? ` (${div.cls.circle})` : ''}; ${link.how === 'manual' ? 'linked by hand' : `matched on name, dates, start times${sails}`}.`,
      'Races are matched to official ones by start time (then order), not by number; RS n is RaceSense’s number.',
    );
    const unmatched = div.boats.rsOnly.length + div.boats.ysOnly.length;
    if (unmatched) {
      chips.push(warnChip(`${unmatched} boat${unmatched > 1 ? 's' : ''} unmatched`));
      more = {
        title: 'Boats not matched by sail number or name',
        items: [...div.boats.rsOnly.map((s) => `RaceSense ${s}: no official entry`), ...div.boats.ysOnly.map((s) => `Yachtscoring ${s}: no tracker entry`)],
      };
    }
  }

  // The race itself.
  if (race?.practice) {
    chips.push({ text: 'Practice' });
    bullets.push(
      race.rsNumber != null && race.numbering === 'official'
        ? 'Practice: before official race 1, with no official race at its gun.'
        : 'Practice: RaceSense marks it, or it is the lone race with no finishes on the first day, before the first day with finishes.',
    );
  }
  if (race?.noOfficial) {
    chips.push(warnChip('no official race at this gun'));
    bullets.push('No official race starts within 2 minutes of this gun; shown with RaceSense’s number.');
  }
  if (race?.rebuilt) {
    chips.push(warnChip(race.rebuilt.gunFrom === 'official' ? 'rebuilt · official gun' : 'rebuilt from the feed'));
    bullets.push(
      race.rebuilt.gunFrom === 'official'
        ? 'Rebuilt: RaceSense doesn’t list this race and the trackers never switched to racing; gun from the official start time, start line from the start-line trackers.'
        : 'Rebuilt: RaceSense doesn’t list this race; gun where the boats’ trackers switched to racing, start line from the start-line trackers at the gun. No Vakaros start fixes.',
      `Link to it with race=${race.raceNumber} (its gun’s UTC minute).`,
    );
  }
  if (race && race.numbering === 'ordinal') {
    chips.push(warnChip('unofficial numbering'));
    bullets.push('No official results linked: races numbered in order of their guns, practice left out; RS n is RaceSense’s number.');
  }

  // Where the places and times came from (once the race is analysed).
  if (results?.places === 'official') {
    if (results.times === 'official') chips.push({ text: 'official places & times' });
    else chips.push({ text: `official places · ${results.times === 'racesense' ? 'RaceSense' : 'tracker'} times` });
    if (results.times !== 'official') bullets.push(`Official finish times not used (${results.timesNote ?? 'not plausible'}): RaceSense’s finishes, else the tracks’ finish-line crossings (~).`);
    else bullets.push('Official finish times agree with the tracks’ finish-line crossings (median within a minute), so they are used.');
    if (results.officialNoTrack?.length) bullets.push(`In the official results without a track here: ${listOf(results.officialNoTrack)}.`);
  } else if (results?.places === 'tracker') {
    chips.push(warnChip(results.trackerFinishes ? '~ tracker finishes' : 'no finishes'));
    bullets.push(
      results.trackerFinishes
        ? '~ Tracker finish: where the boat’s track crosses the finish line (its two trackers, where they were then), on its last leg. A track that never crosses gets no finish.'
        : 'Neither RaceSense nor the tracks give finishes for this race (no finish-line crossing found).',
    );
  }

  // The feed check for unlisted races.
  if (feed.status === 'running') chips.push({ text: `looking for missing races ${feed.used}/${feed.max}`, title: 'The race list is already on screen. Checking the feed for races RaceSense doesn’t list (at most this many requests).' });
  else if (feed.status === 'done' && feed.found) chips.push({ text: `${feed.found} race${feed.found > 1 ? 's' : ''} rebuilt` });
  if (feed.exhausted) chips.push(warnChip('feed check incomplete', `Stopped after ${feed.max} requests`));
  if (feed.status !== 'idle') {
    bullets.push(
      `Unlisted races: short feed checks where one is likely (an official race RaceSense lacks; after the last race of a short racing day), at most ${feed.max} requests per division, cached.`,
    );
  }

  bullets.push('To link official results by hand, paste a Yachtscoring link (yachtscoring.com/emenu/…) or event number below. Off turns them off for this event; Auto matches again.');
  return { chips, bullets, more, ys: o.ys ?? null };
}

/** The header's key line: chips, then an ⓘ whose body ends with the link form. */
export function raceHeadHtml(k: RaceHead, open = false): string {
  const items = k.bullets.map((b) => `<li>${esc(b)}</li>`).join('');
  const more = k.more?.items.length ? `<p class="info-sub">${esc(k.more.title)}</p><ul>${k.more.items.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '';
  const value = k.ys ? `${YS_EVENT_URL}${k.ys}` : '';
  const form = `<form class="ys-form" data-ys-form><input type="text" name="ys" inputmode="url" autocomplete="off" spellcheck="false" placeholder="yachtscoring.com/emenu/…" aria-label="Yachtscoring event link or number" value="${esc(value)}"><button type="submit">Link</button><button type="button" data-ys="off">Off</button><button type="button" data-ys="auto">Auto</button></form>`;
  const info = `<details class="info"${open ? ' open' : ''}><summary><span class="info-i" aria-hidden="true">ⓘ</span><span class="info-lbl">Results &amp; numbering</span></summary><div class="info-body"><ul>${items}</ul>${more}${form}</div></details>`;
  return capHtml(k.chips, info);
}
