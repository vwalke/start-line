/**
 * The analysis pipeline: RaceData in, RaceAnalysis out. Ported from the
 * Python prototype (analyze.py): local ENU projection, bow-corrected DTL,
 * secs late from velocity toward the line, legs split at mark approaches,
 * TWD from steady upwind tack headings, VMG from displacement along the wind.
 */
import type { RaceData } from '../data/types';
import { pathDistance } from './distance';
import { buildFindings } from './findings';
import {
  MS_TO_KN,
  add,
  bearingVec,
  dot,
  gradientAt,
  interp,
  interpAngle,
  len,
  makeProjection,
  median,
  scale,
  sub,
  vecBearing,
  wrap180,
  type Vec,
} from './geo';
import { inferRoundings, splitLegs, type Waypoint } from './legs';
import { projectTrack, rangeIdx, type XYTrack } from './prepare';
import {
  START_TRAIL_MS,
  type BoatDrawing,
  type BoatResult,
  type LegDef,
  type LegKind,
  type LegResult,
  type LineInfo,
  type RaceAnalysis,
  type StartResult,
  type TrackSegment,
  type WindEstimate,
  type WindInfo,
} from './types';
import { assessStart, rankStarts, sampleGap } from './validity';
import { estimateTwd, makeTwdAt, steadyIndices } from './wind';

const centroid = (ps: Vec[]): Vec => scale(ps.reduce((a, b) => add(a, b), [0, 0] as Vec), 1 / ps.length);

function legKind(bearing: number, twd: number): LegKind {
  const d = Math.abs(wrap180(bearing - twd));
  return d < 60 ? 'upwind' : d > 120 ? 'downwind' : 'reach';
}

const KIND_NAME: Record<LegKind, string> = { upwind: 'Beat', downwind: 'Run', reach: 'Reach' };

export { START_TRAIL_MS };

export function analyzeRace(data: RaceData): RaceAnalysis {
  const warnings: string[] = [];
  const gun = data.gunMs;
  const sl = data.startLine;
  const proj = makeProjection({ lat: (sl.left.lat + sl.right.lat) / 2, lon: (sl.left.lon + sl.right.lon) / 2 });
  const L = proj.toXY(sl.left.lat, sl.left.lon);
  const R = proj.toXY(sl.right.lat, sl.right.lon);
  const lineVec = sub(R, L);
  const lineLen = Math.max(len(lineVec), 1e-9);
  const ldir = scale(lineVec, 1 / lineLen);
  const lineMid = centroid([L, R]);

  const tracks = new Map<string, XYTrack>(data.boats.map((b) => [b.id, projectTrack(b.track, proj)]));
  const finishLine = data.finishLine
    ? { left: proj.toXY(data.finishLine.left.lat, data.finishLine.left.lon), right: proj.toXY(data.finishLine.right.lat, data.finishLine.right.lon) }
    : null;

  // ---- waypoints & leg sequence
  const courseWps: Waypoint[] = data.course.map((m) => {
    const xy = m.positions.map((p) => proj.toXY(p.lat, p.lon));
    const wp: Waypoint = { name: m.name, key: m.id, xy };
    const tracks = m.tracks?.filter((tk) => tk.t.length > 1);
    if (tracks && tracks.length === m.positions.length) {
      const series = tracks.map((tk) => {
        const ps = tk.t.map((_, i) => proj.toXY(tk.lat[i], tk.lon[i]));
        return { t: tk.t, x: ps.map((p) => p[0]), y: ps.map((p) => p[1]) };
      });
      wp.at = (t) => series.map((s) => [interp(s.t, s.x, t), interp(s.t, s.y, t)] as Vec);
    }
    return wp;
  });
  const byKey = new Map(courseWps.map((w) => [w.key, w]));
  let wps = courseWps;
  let legSource: RaceAnalysis['legSource'] = courseWps.length ? 'course' : 'none';
  const finishers = data.boats.filter((b) => b.finishMs != null).sort((a, b) => a.finishMs! - b.finishMs!);
  if (courseWps.length) {
    const inferred = finishers
      .slice(0, 3)
      .map((b) => inferRoundings(tracks.get(b.id)!, gun, b.finishMs!, courseWps).join('|'));
    const courseSeq = courseWps.map((w) => w.key).join('|');
    if (inferred.length >= 2 && inferred.every((s) => s === inferred[0]) && inferred[0] && inferred[0] !== courseSeq) {
      wps = inferred[0].split('|').map((k) => byKey.get(k)!);
      legSource = 'tracks';
      warnings.push('Leg order inferred from the leaders’ tracks (it differs from the course list in the feed).');
    }
  }

  // Split once, then treat a course as shortened if most finishers never
  // completed it (keep the longest prefix that most of them did).
  const times = new Map<string, (number | null)[]>();
  for (const b of data.boats) times.set(b.id, splitLegs(tracks.get(b.id)!, gun, wps, b.finishMs));
  if (wps.length && finishers.length) {
    const nWp = wps.length;
    const completed = (tt: (number | null)[], k: number): boolean => {
      for (let i = 0; i <= k; i++) if (tt[i] == null) return false;
      return tt[tt.length - 1] != null;
    };
    const done = (k: number): number => finishers.filter((b) => completed(times.get(b.id)!, k)).length;
    const need = Math.ceil(0.6 * finishers.length);
    if (done(nWp) < need) {
      let k = nWp - 1;
      while (k > 0 && done(k) < need) k--;
      const dropped = wps.slice(k).map((w) => w.name);
      wps = wps.slice(0, k);
      for (const [id, tt] of times) times.set(id, k === nWp ? tt : [...tt.slice(0, k + 1), tt[tt.length - 1]]);
      warnings.push(
        `The fleet didn't sail the full course in the feed; treating it as shortened (skipping ${dropped.join(', ')}).`,
      );
    }
  }

  // Course side: toward the first mark, else where the fleet is a minute after the gun.
  let nrm: Vec = [-ldir[1], ldir[0]];
  const firstTarget = wps.length ? centroid(wps[0].xy) : null;
  if (firstTarget) {
    if (dot(sub(firstTarget, lineMid), nrm) < 0) nrm = scale(nrm, -1);
  } else {
    const side = median(
      [...tracks.values()].map((tr) => dot(sub([interp(tr.t, tr.x, gun + 60_000), interp(tr.t, tr.y, gun + 60_000)], L), nrm)),
    );
    if (side < 0) nrm = scale(nrm, -1);
  }

  // Leg geometry: waypoint centres, from the line to the finish.
  const finishPt = finishLine ? centroid([finishLine.left, finishLine.right]) : lineMid;
  const pts: Vec[] = [lineMid, ...wps.map((w) => centroid(w.xy)), finishPt];
  const legBearings = pts.slice(1).map((p, i) => vecBearing(sub(p, pts[i])));

  // Prior wind: first leg is nearly always a beat; else the model; else square to the line.
  const modelAt = (t: number): number | null => {
    const s = data.windModel?.samples;
    if (!s?.length) return null;
    const ts = s.map((x) => x.t);
    if (t < ts[0] - 3 * 3_600_000 || t > ts[ts.length - 1] + 3 * 3_600_000) return null;
    return interpAngle(ts, s.map((x) => x.dirDeg), t);
  };
  const modelGun = modelAt(gun);
  const prior = wps.length ? legBearings[0] : modelGun ?? vecBearing(nrm);
  let kinds = legBearings.map((b) => legKind(b, prior));

  const nLegs = wps.length + 1;

  // ---- wind from upwind tack headings
  const estimates: WindEstimate[] = [];
  for (let li = 0; li < nLegs; li++) {
    if (kinds[li] !== 'upwind') continue;
    const hs: number[] = [];
    const mids: number[] = [];
    for (const b of data.boats) {
      const tt = times.get(b.id)!;
      const a = tt[li];
      const e = tt[li + 1];
      if (a == null || e == null) continue;
      mids.push((a + e) / 2);
      const tr = tracks.get(b.id)!;
      for (const i of steadyIndices(tr, a, e)) hs.push(tr.heading[i]);
    }
    const est = estimateTwd(hs);
    if (est && mids.length) {
      estimates.push({ legIndex: li, tMs: mids.reduce((x, y) => x + y, 0) / mids.length, ...est, samples: hs.length });
    }
  }
  let method: WindInfo['method'] = 'tacks';
  let fallback = prior;
  if (!estimates.length) {
    if (modelGun != null) {
      method = 'model';
      fallback = modelGun;
      warnings.push('Not enough steady upwind sailing to estimate the wind; using the weather model direction.');
    } else {
      method = 'course';
      warnings.push('Not enough steady upwind sailing to estimate the wind; assuming the first leg is dead upwind.');
    }
  }
  const twdAt = makeTwdAt(estimates, fallback);
  const twdGun = twdAt(gun);
  kinds = legBearings.map((b) => legKind(b, twdGun));
  const counters: Record<LegKind, number> = { upwind: 0, downwind: 0, reach: 0 };
  const legs: LegDef[] = kinds.map((k, i) => ({
    index: i,
    kind: k,
    name: `${KIND_NAME[k]} ${++counters[k]}`,
    to: i < wps.length ? wps[i].name : 'Finish',
  }));

  // ---- line
  const w = bearingVec(twdGun);
  const uL = dot(L, w);
  const uR = dot(R, w);
  const favoredByM = Math.abs(uR - uL);
  const line: LineInfo = {
    left: L,
    right: R,
    lengthM: lineLen,
    bearingDeg: vecBearing(lineVec),
    favored: favoredByM < 2 ? 'square' : uL > uR ? 'left' : 'right',
    favoredByM,
  };

  // ---- per-boat metrics
  const sailOrder = [...data.boats].sort((a, b) => a.sail.localeCompare(b.sail, undefined, { numeric: true }));
  const finishOrder = finishers.map((b) => b.id);
  const results: BoatResult[] = [];
  const drawings: BoatDrawing[] = [];
  for (const b of data.boats) {
    const tr = tracks.get(b.id)!;
    const tt = times.get(b.id)!;
    let start: StartResult | null = null;
    let trail = { x: new Float32Array(0), y: new Float32Array(0) };
    let courseAtGun: number | null = null;
    let headingAtSample: number | null = null;
    if (tr.t.length > 1 && tr.t[0] <= gun && tr.t[tr.t.length - 1] >= gun) {
      // DTL, line position and the bow are sampled where the source takes its
      // start fix (RaceSense: ~0.9 s before the gun), so ours checks against the
      // device's dtlMm. Bow offset is applied along heading, as the device does.
      const off = data.dtlSampleOffsetMs ?? 0;
      const ts = tr.t[0] <= gun - off ? gun - off : gun;
      const p: Vec = [interp(tr.t, tr.x, ts), interp(tr.t, tr.y, ts)];
      headingAtSample = interpAngle(tr.t, tr.heading, ts);
      const hdg = interpAngle(tr.t, tr.heading, gun);
      const bow = add(p, scale(bearingVec(headingAtSample), b.bowOffsetM));
      const dtl = -dot(sub(bow, L), nrm);
      // Velocity toward the course side at the gun (numpy.gradient, then interpolated).
      // xs in ms → gradient is m/ms; ×1000 gives m/s. Only the samples around the
      // gun are read — do not copy the whole ~5 Hz series.
      const i = Math.max(0, Math.min(tr.t.length - 2, rangeIdx(tr.t, gun, gun)[0] - 1));
      const v = (k: number): Vec => [gradientAt(tr.t, tr.x, k) * 1000, gradientAt(tr.t, tr.y, k) * 1000];
      const f = tr.t[i + 1] === tr.t[i] ? 0 : (gun - tr.t[i]) / (tr.t[i + 1] - tr.t[i]);
      const vel = add(scale(v(i), 1 - f), scale(v(i + 1), f));
      const vperp = dot(vel, nrm);
      courseAtGun = len(vel) > 0.15 ? vecBearing(vel) : hdg;
      // The public track is lossy near the gun: judge the sample by the nearest real point
      // and by the hole it sits in (a neighbour within 2 s still interpolates across > 5 s).
      const gap = sampleGap(tr.t, ts);
      start = {
        dtlM: dtl,
        secsLate: dtl / Math.max(vperp, 0.3),
        vToLineMs: vperp,
        linePosPct: (100 * dot(sub(bow, L), ldir)) / lineLen,
        speedKn: interp(tr.t, tr.sog, gun),
        headingDeg: hdg,
        twaDeg: wrap180(twdGun - hdg),
        bow,
        ocs: !!b.ocs,
        rcDtlM: b.rc ? b.rc.dtlM : (b.rcDtlM ?? null),
        rcStatus: b.rc?.status ?? (b.rcDtlM != null ? 'ok' : 'none'),
        rcNote: b.rc?.note ?? null,
        dtlGapS: gap?.gapS ?? null,
        dtlNote: gap?.note ?? null,
        // Filled in once the fleet's speed floor is known.
        lateS: null,
        rank: null,
        over: false,
        startPlace: null,
        warn: null,
        ocsBlind: false,
      };
      // START_TRAIL_MS of the tracker up to the DTL sample, translated by that
      // sample's bow offset so the polyline ends exactly on the bow used for DTL.
      const [t0, t1] = rangeIdx(tr.t, gun - START_TRAIL_MS, ts);
      const dx = bow[0] - p[0];
      const dy = bow[1] - p[1];
      const needTip = t1 === t0 || tr.t[t1 - 1] < ts - 50;
      const n = t1 - t0 + (needTip ? 1 : 0);
      const xs = new Float32Array(n);
      const ys = new Float32Array(n);
      for (let k = 0; k < t1 - t0; k++) {
        xs[k] = tr.x[t0 + k] + dx;
        ys[k] = tr.y[t0 + k] + dy;
      }
      xs[n - 1] = bow[0];
      ys[n - 1] = bow[1];
      trail = { x: xs, y: ys };
    }

    const legResults: (LegResult | null)[] = [];
    for (let li = 0; li < nLegs; li++) {
      const a = tt[li];
      const e = tt[li + 1];
      if (a == null || e == null || e <= a) {
        legResults.push(null);
        continue;
      }
      const T = (e - a) / 1000;
      const twdl = twdAt((a + e) / 2);
      const disp: Vec = [interp(tr.t, tr.x, e) - interp(tr.t, tr.x, a), interp(tr.t, tr.y, e) - interp(tr.t, tr.y, a)];
      const vmg = (Math.abs(dot(disp, bearingVec(twdl))) / T) * MS_TO_KN;
      const [i0, i1] = rangeIdx(tr.t, a, e);
      let idx = T > 40 ? steadyIndices(tr, a, e) : [];
      if (!idx.length) idx = Array.from({ length: i1 - i0 }, (_, k) => i0 + k);
      const twa = median(idx.map((k) => Math.abs(wrap180(twdl - tr.heading[k]))));
      const dist = pathDistance(tr.t, tr.x, tr.y, a, e);
      // SOG is Dist (the interpolated path) ÷ time, in knots.
      legResults.push({ startMs: a, endMs: e, timeS: T, sogKn: dist.distNm / (T / 3600), vmgKn: vmg, twaDeg: twa, rankAtEnd: null, ...dist });
    }

    let raceTimeS: number | null = null;
    let sogAvgKn: number | null = null;
    let distNm: number | null = null;
    let distApprox = false;
    if (b.finishMs != null && b.finishMs > gun) {
      raceTimeS = (b.finishMs - gun) / 1000;
      // Gun → finish in one pass; equals the sum of the legs when every leg was split.
      const d = pathDistance(tr.t, tr.x, tr.y, gun, b.finishMs);
      distNm = d.distNm;
      distApprox = d.distGapS != null;
      sogAvgKn = d.distNm / (raceTimeS / 3600);
    }
    const pos = finishOrder.indexOf(b.id);
    results.push({
      id: b.id,
      sail: b.sail,
      name: b.name,
      colorSlot: sailOrder.indexOf(b),
      finishPos: pos >= 0 ? pos + 1 : null,
      finishMs: b.finishMs,
      raceTimeS,
      sogAvgKn,
      distNm,
      distApprox,
      start,
      legs: legResults,
    });

    const segments: TrackSegment[] = [];
    for (let li = 0; li < nLegs; li++) {
      const a = tt[li];
      const e = tt[li + 1] ?? (li === nLegs - 1 && tt[li] != null ? tr.t[tr.t.length - 1] : null);
      if (a == null || e == null) continue;
      const [i0, i1] = rangeIdx(tr.t, a, e);
      const xs: number[] = [];
      const ys: number[] = [];
      let last = -Infinity;
      for (let k = i0; k < i1; k++) {
        if (tr.t[k] - last < 1000 && k !== i1 - 1) continue;
        last = tr.t[k];
        xs.push(tr.x[k]);
        ys.push(tr.y[k]);
      }
      segments.push({ leg: li, x: Float32Array.from(xs), y: Float32Array.from(ys) });
    }
    drawings.push({
      id: b.id,
      trail,
      bow: start?.bow ?? null,
      headingAtGun: start?.headingDeg ?? null,
      headingAtSample,
      courseAtGun,
      segments,
    });
  }

  // A boat stalled or reaching along the line at the gun has ~0 speed toward it;
  // judge its lateness against half the fleet's typical approach speed instead.
  const approach = results.filter((r) => r.start && r.start.vToLineMs > 0).map((r) => r.start!.vToLineMs);
  const vFloor = Math.max(0.3, approach.length ? 0.5 * median(approach) : 0.3);
  for (const r of results) {
    if (!r.start) continue;
    r.start.secsLate = r.start.dtlM / Math.max(r.start.vToLineMs, vFloor);
    Object.assign(r.start, assessStart(r.start));
  }
  rankStarts(results);

  // Rank at each mark.
  for (let li = 0; li < nLegs; li++) {
    const done = results.filter((r) => r.legs[li]).sort((a, b) => a.legs[li]!.endMs - b.legs[li]!.endMs);
    done.forEach((r, k) => (r.legs[li]!.rankAtEnd = k + 1));
  }
  results.sort((a, b) => (a.finishPos ?? 1e9) - (b.finishPos ?? 1e9) || a.colorSlot - b.colorSlot);

  const wind: WindInfo = {
    method,
    estimates,
    twdAtGunDeg: twdGun,
    model: modelGun != null && data.windModel ? { label: data.windModel.label, dirAtGunDeg: modelGun } : null,
  };
  // Draw each rounding where the mark was when the fleet rounded it (it may have been moved since).
  const drawnMarks: { name: string; xy: Vec[] }[] = [];
  wps.forEach((wp, i) => {
    const ts = data.boats.map((b) => times.get(b.id)![i + 1]).filter((t): t is number => t != null);
    const xy = wp.at && ts.length ? wp.at(median(ts)) : wp.xy;
    const same = drawnMarks.find((m) => m.name === wp.name && m.xy.every((p, k) => xy[k] && len(sub(p, xy[k])) < 15));
    if (!same) drawnMarks.push({ name: wp.name, xy });
  });
  if (!wps.length) for (const wp of courseWps) drawnMarks.push({ name: wp.name, xy: wp.xy });
  const moved = drawnMarks.filter((m, i) => drawnMarks.findIndex((o) => o.name === m.name) !== i).map((m) => m.name);
  if (moved.length) warnings.push(`${[...new Set(moved)].join(', ')} moved during the race; legs use the mark's position at the time.`);

  // The Vakaros DTL is the primary figure; ours is a check. Flag it when they clearly disagree.
  const rcDiff = results
    .filter((r) => r.start?.rcDtlM != null && r.start.dtlGapS == null)
    .map((r) => Math.abs(r.start!.rcDtlM! - r.start!.dtlM));
  if (rcDiff.length >= 3 && median(rcDiff) > 3) {
    warnings.push(`Vakaros DTL differs from the GPS tracks by a median ${Math.round(median(rcDiff))} m for this start; treat the DTL columns with caution.`);
  }

  const analysis: RaceAnalysis = {
    meta: {
      eventName: data.eventName,
      division: data.division,
      boatClass: data.boatClass,
      raceNumber: data.raceNumber,
      gunMs: gun,
      tzOffsetMs: data.tzOffsetMs,
      sourceLabel: data.source.label,
      sourceKind: data.source.kind,
      eventId: data.source.eventId,
    },
    line,
    finishLine,
    marks: drawnMarks,
    legs,
    legSource,
    wind,
    boats: results,
    drawings,
    findings: [],
    warnings,
  };
  analysis.findings = buildFindings(analysis);
  return analysis;
}
