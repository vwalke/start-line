/** Plain-English findings from a finished analysis. Short, specific, hedged where the wind is estimated. */
import { compassRound, median, wrap180 } from './geo';
import { biasAngle, lineBias } from './line';
import type { BoatResult, Finding, RaceAnalysis, StartResult } from './types';

/** Findings about the start (the line and the starts), shown under the start chart, and the rest (legs, results, wind), shown with the race. */
export function splitFindings(findings: Finding[]): { start: Finding[]; race: Finding[] } {
  const isStart = (f: Finding): boolean => f.kind === 'start' || f.kind === 'line';
  return { start: findings.filter(isStart), race: findings.filter((f) => !isStart(f)) };
}

/** The DTL to show and rank by (see `StartResult.rank`): Vakaros when valid, else ours when valid, else null. */
export const primaryDtlM = (s: StartResult): number | null => s.rank?.m ?? null;

const tag = (b: BoatResult): string => (b.name && b.name !== `#${b.sail}` ? `#${b.sail} (${b.name})` : `#${b.sail}`);
const r0 = (x: number): string => Math.round(x).toString();
const rDeg = (x: number): string => compassRound(x).toString();
const r1 = (x: number): string => x.toFixed(1);
const ord = (n: number): string => n + (['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? 'th');

function joinTags(bs: BoatResult[]): string {
  const t = bs.map(tag);
  return t.length <= 1 ? t.join('') : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`;
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
    let text = `The ${end} end was favoured by ${r0(deg)}° ≈ ${r0(line.favoredByM)} m against the ${est} wind of ${rDeg(wind.twdAtGunDeg)}°.`;
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
  const by = (b: BoatResult): string => (b.start!.rank!.source === 'ours' ? ' by our track check' : '');
  const late = (s: StartResult, approx = false): string => (s.lateS == null ? '' : `, ${approx ? '≈' + r0(s.lateS) : r1(s.lateS)} s late`);
  const over = started.filter((b) => b.start!.over);
  const clean = started.filter((b) => b.start!.startPlace != null).sort((x, y) => x.start!.startPlace! - y.start!.startPlace!);
  if (clean.length) {
    const best = clean[0];
    const tied = clean.filter((b) => dtl(b) - dtl(best) < 1);
    const s = best.start!;
    let text = `Best start: ${joinTags(tied)} — ${r1(dtl(best))} m back${by(best)}${late(s)}, at ${r1(s.speedKn)} kn.`;
    const fin = tied.filter((b) => b.finishPos != null).map((b) => `${tag(b)} finished ${ord(b.finishPos!)}`);
    if (fin.length) text += ` ${fin.join('; ')}.`;
    out.push({ kind: 'start', text, boatIds: tied.map((b) => b.id) });
    if (clean.length >= 3) {
      const worst = clean[clean.length - 1];
      const w = worst.start!;
      let wt = `Furthest back: ${tag(worst)} — ${r1(dtl(worst))} m${by(worst)}${late(w, true)}`;
      if (Math.abs(w.twaDeg) > 42) wt += `, sailing low (TWA ${r0(Math.abs(w.twaDeg))}°)`;
      else if (w.speedKn < median(started.map((b) => b.start!.speedKn)) - 1) wt += `, slow at ${r1(w.speedKn)} kn`;
      out.push({ kind: 'start', text: wt + '.', boatIds: [worst.id] });
    }
  }
  for (const b of over) {
    const s = b.start!;
    out.push({
      kind: 'start',
      boatIds: [b.id],
      text: s.ocs
        ? `${tag(b)} was flagged OCS by race control.`
        : `${tag(b)}'s bow was ${r1(-dtl(b))} m over the line at the gun ${s.rank!.source === 'ours' ? 'by our estimate' : 'by the Vakaros DTL'} (not flagged OCS — GPS and bow offset are approximate).`,
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
      text:
        s.dtlGapS != null
          ? `${tag(b)}: ${rc} and our track has a ${r0(s.dtlGapS)} s gap at the gun; it may have been over (${pos} by interpolation), but neither figure is reliable.`
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
    const ests = wind.estimates.map((e) => `${rDeg(e.twdDeg)}° on ${a.legs[e.legIndex].name}`).join(', ');
    let text = `Wind estimated from the fleet's tack headings: ${ests}.`;
    if (wind.model) {
      const d = Math.abs(wrap180(wind.model.dirAtGunDeg - wind.twdAtGunDeg));
      text += ` The ${wind.model.label} model had ${rDeg(wind.model.dirAtGunDeg)}° at the gun (${r0(d)}° apart).`;
    }
    out.push({ kind: 'wind', text });
  }
  return out;
}
