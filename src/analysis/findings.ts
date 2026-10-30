/** Plain-English findings from a finished analysis. Short, specific, hedged where the wind is estimated. */
import { compassRound, median, wrap180 } from './geo';
import { biasAngle, lineBias } from './line';
import type { BoatResult, Finding, RaceAnalysis, StartCompare, StartCompareSide, StartResult } from './types';
import { gapAtGun, startDtlM } from './validity';
import { START_WIND_SPAN } from './wind';

/** Findings about the start (the line and the starts), shown under the start chart, and the rest (legs, results, wind), shown with the race. */
export function splitFindings(findings: Finding[]): { start: Finding[]; race: Finding[] } {
  const isStart = (f: Finding): boolean => f.kind === 'start' || f.kind === 'line';
  return { start: findings.filter(isStart), race: findings.filter((f) => !isStart(f)) };
}

/** The DTL to show and rank by (see `StartResult.rank`): Vakaros when valid, else ours when valid, else null. */
export const primaryDtlM = (s: StartResult): number | null => s.rank?.m ?? null;

const named = (b: BoatResult): string | null => (b.name && b.name !== `#${b.sail}` ? b.name : null);
const tag = (b: BoatResult): string => (named(b) ? `#${b.sail} (${named(b)})` : `#${b.sail}`);
const r0 = (x: number): string => Math.round(x).toString();
const rDeg = (x: number): string => compassRound(x).toString();
const r1 = (x: number): string => x.toFixed(1);
const ord = (n: number): string => n + (['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? 'th');

function joinTags(bs: BoatResult[]): string {
  const t = bs.map(tag);
  return t.length <= 1 ? t.join('') : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`;
}

/** The start comparison's rows, the same for both boats. */
export const START_COMPARE_ROWS = ['Behind the line at the gun', 'Late', 'Speed at the gun', 'Line position'] as const;

/** One boat's start under START_COMPARE_ROWS ("—" for a missing value). */
function startSide(b: BoatResult): StartCompareSide {
  const s = b.start!;
  const behind = `${r1(s.rank!.m)} m${s.rank!.source === 'ours' ? ' (our track)' : ''}`;
  return { id: b.id, tag: tag(b), sail: b.sail, name: named(b), values: [behind, s.lateS == null ? '—' : `${r1(s.lateS)} s`, `${r1(s.speedKn)} kn`, `${r0(s.linePosPct)}% from the pin`] };
}

/** The best clean start (first by start place) beside the worst (last), when there are two or more. */
function startCompare(best: BoatResult, worst: BoatResult | null, anyOver: boolean, anyAway: boolean): StartCompare {
  const out = [anyOver && 'over early', anyAway && 'away from the line'].filter(Boolean);
  return {
    rows: [...START_COMPARE_ROWS],
    best: startSide(best),
    worst: worst ? startSide(worst) : null,
    note: out.length ? `Boats ${out.join(' or ')} are left out (listed below).` : null,
  };
}

/** The comparison as plain text, for wherever a finding is read as a sentence. */
export function startCompareText(c: StartCompare): string {
  const side = (head: string, x: StartCompareSide): string =>
    `${head}: ${x.tag} — ${c.rows
      .map((r, i) => (x.values[i] === '—' ? '' : `${r.toLowerCase()}: ${x.values[i]}`))
      .filter(Boolean)
      .join('; ')}.`;
  return [side('Best start', c.best), c.worst && side('Worst start', c.worst), c.note].filter(Boolean).join(' ');
}

export function buildFindings(a: RaceAnalysis): Finding[] {
  const out: Finding[] = [];
  const started = a.boats.filter((b) => b.start);
  const winner = a.boats.find((b) => b.finishPos === 1) ?? null;

  // Line bias.
  const { line, wind } = a;
  const est = wind.method === 'tacks' ? 'estimated' : 'assumed';
  if (line.favored === 'square') {
    out.push({ kind: 'line', text: `The line was close to square to the ${est} wind (${rDeg(wind.twdAtGunDeg)}°).` });
  } else {
    const end = line.favored === 'left' ? 'pin (left)' : 'RC (right)';
    const deg = biasAngle(lineBias(line, wind.twdAtGunDeg));
    let text = `The ${end} end was favored by ${r0(deg)}° ≈ ${r0(line.favoredByM)} m against the ${est} wind of ${rDeg(wind.twdAtGunDeg)}°.`;
    let boatIds: string[] | undefined;
    if (winner?.start) {
      boatIds = [winner.id];
      const winnerLeft = winner.start.linePosPct < 50;
      const onFav = winnerLeft === (line.favored === 'left');
      text += onFav
        ? ` The winner, ${tag(winner)}, started at that end (${r0(winner.start.linePosPct)}% along).`
        : ` Even so, the winner ${tag(winner)} started at the other end (${r0(winner.start.linePosPct)}% along).`;
    }
    out.push({ kind: 'line', text, boatIds });
  }

  // Starts.
  // Ranked by one value per boat (Vakaros when valid, else our track check); boats with neither are skipped.
  const dtl = (b: BoatResult): number => b.start!.rank!.m;
  const over = started.filter((b) => b.start!.over);
  const away = started.filter((b) => b.start!.awayFromLine);
  // Clean starters only (start place set): over-early and away boats have their own findings below.
  const clean = started.filter((b) => b.start!.startPlace != null).sort((x, y) => x.start!.startPlace! - y.start!.startPlace!);
  if (clean.length) {
    const compare = startCompare(clean[0], clean.length >= 2 ? clean[clean.length - 1] : null, over.length > 0, away.length > 0);
    out.push({ kind: 'start', text: startCompareText(compare), boatIds: [compare.best.id, ...(compare.worst ? [compare.worst.id] : [])], compare });
  }
  if (away.length) {
    const km = (b: BoatResult): string => `${(Math.abs(startDtlM(b.start!)) / 1000).toFixed(1)} km`;
    out.push({
      kind: 'start',
      boatIds: away.map((b) => b.id),
      text:
        away.length === 1
          ? `${tag(away[0])} was ${km(away[0])} from the line at the gun (away from the line).`
          : `${joinTags(away)} were away from the line at the gun (${away.map(km).join(', ')}).`,
    });
  }
  for (const b of over) {
    const s = b.start!;
    out.push({
      kind: 'start',
      boatIds: [b.id],
      text: s.ocs
        ? `${tag(b)} was flagged OCS by race control.`
        : `${tag(b)} was over ${r1(-dtl(b))} m by ${s.rank!.source === 'ours' ? 'our track estimate' : 'Vakaros DTL'} (not flagged OCS)`,
    });
  }
  // Boats race control's OCS check couldn't see: no usable Vakaros fix, and our figure is near or over the line.
  for (const b of started.filter((x) => x.start!.ocsBlind)) {
    const s = b.start!;
    const rc = s.rcStatus === 'stale' ? 'Vakaros had no start fix for this race' : 'Vakaros reported no distance for this boat';
    const pos = s.dtlM < 0 ? `≈${r1(-s.dtlM)} m over` : `≈${r1(s.dtlM)} m behind`;
    out.push({
      kind: 'start',
      boatIds: [b.id],
      text: gapAtGun(s)
        ? `${tag(b)}: ${rc}; it may have been over (our track: ${pos}), but neither figure is reliable.`
        : `${tag(b)}: ${rc}, and our track puts the bow ${pos} the line at the start; it may have been over without race control's OCS check seeing it (GPS and bow offset are approximate).`,
    });
  }

  // Legs: biggest single loss / gain vs the fleet median time on that leg.
  let worst: { b: BoatResult; li: number; dt: number } | null = null;
  let best: { b: BoatResult; li: number; dt: number } | null = null;
  a.legs.forEach((_leg, li) => {
    const done = a.boats.filter((b) => b.legs[li]);
    if (done.length < 3) return;
    const med = median(done.map((b) => b.legs[li]!.timeS));
    for (const b of done) {
      const dt = b.legs[li]!.timeS - med;
      if (!worst || dt > worst.dt) worst = { b, li, dt };
      if (!best || dt < best.dt) best = { b, li, dt };
    }
  });
  const legLine = (x: { b: BoatResult; li: number; dt: number }, verb: string): string => {
    const leg = a.legs[x.li];
    const others = a.boats.filter((o) => o !== x.b && o.legs[x.li]).map((o) => o.legs[x.li]!.vmgKn);
    return `${tag(x.b)} ${verb} ${r0(Math.abs(x.dt))} s on ${leg.name} vs the fleet median: VMG ${x.b.legs[x.li]!.vmgKn.toFixed(1)} kn vs ${median(others).toFixed(1)} kn for the rest.`;
  };
  const legFinding = (x: { b: BoatResult; li: number; dt: number }, verb: string): Finding => ({ kind: 'leg', text: legLine(x, verb), boatIds: [x.b.id] });
  if (worst && (worst as { dt: number }).dt > 10) out.push(legFinding(worst, 'lost'));
  if (best && (best as { dt: number }).dt < -10) out.push(legFinding(best, 'gained'));

  // Fastest upwind and downwind by mean VMG over legs of that kind.
  for (const kind of ['upwind', 'downwind'] as const) {
    const idx = a.legs.filter((l) => l.kind === kind).map((l) => l.index);
    if (!idx.length) continue;
    const scored = a.boats
      .map((b) => ({ b, v: idx.map((i) => b.legs[i]?.vmgKn).filter((v): v is number => v != null) }))
      .filter((x) => x.v.length === idx.length)
      .map((x) => ({ b: x.b, v: x.v.reduce((p, q) => p + q, 0) / x.v.length }))
      .sort((x, y) => y.v - x.v);
    if (scored.length >= 3) {
      out.push({
        kind: 'leg',
        boatIds: [scored[0].b.id],
        text: `Quickest ${kind}: ${tag(scored[0].b)} (avg VMG ${scored[0].v.toFixed(2)} kn vs ${median(scored.map((s) => s.v)).toFixed(2)} kn fleet median).`,
      });
    }
  }

  // Places gained from the first mark to the finish.
  if (a.legs.length > 1) {
    const moves = a.boats
      .filter((b) => b.legs[0]?.rankAtEnd != null && b.finishPos != null)
      .map((b) => ({ b, d: b.legs[0]!.rankAtEnd! - b.finishPos! }))
      .sort((x, y) => y.d - x.d);
    if (moves.length && moves[0].d >= 2) {
      const m = moves[0];
      out.push({ kind: 'result', boatIds: [m.b.id], text: `${tag(m.b)} gained ${m.d} places after ${a.legs[0].to}: ${ord(m.b.legs[0]!.rankAtEnd!)} → ${ord(m.b.finishPos!)}.` });
    }
    const drop = moves[moves.length - 1];
    if (drop && drop.d <= -2) {
      out.push({ kind: 'result', boatIds: [drop.b.id], text: `${tag(drop.b)} dropped ${-drop.d} places after ${a.legs[0].to}: ${ord(drop.b.legs[0]!.rankAtEnd!)} → ${ord(drop.b.finishPos!)}.` });
    }
  }

  // Wind.
  if (wind.method === 'tacks') {
    const sw = wind.startWindow;
    const ests = [
      ...(sw ? [`${rDeg(sw.twdDeg)}° ${START_WIND_SPAN} after the gun`] : []),
      ...wind.estimates.map((e) => `${rDeg(e.twdDeg)}° on ${a.legs[e.legIndex].name}`),
    ].join(', ');
    let text = `Wind estimated from the fleet's tack headings: ${ests}.`;
    if (wind.model) {
      const d = Math.abs(wrap180(wind.model.dirAtGunDeg - wind.twdAtGunDeg));
      text += ` The ${wind.model.label} model had ${rDeg(wind.model.dirAtGunDeg)}° at the gun (${r0(d)}° apart).`;
    }
    out.push({ kind: 'wind', text });
  }
  return out;
}
