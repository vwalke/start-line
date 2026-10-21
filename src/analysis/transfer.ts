/** What the worker moves (not copies) to the page with an analysis: its drawn tracks' typed-array buffers. */
import type { RaceAnalysis } from './types';

/** Each drawn track's typed-array buffers, once each (analyze.ts gives every array its own). */
export function drawingBuffers(a: RaceAnalysis): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const d of [...a.drawings, ...a.excluded.map((e) => e.drawing)]) {
    for (const tk of [d.trail, ...d.segments]) for (const arr of [tk.x, tk.y, tk.t, tk.sog]) out.add(arr.buffer as ArrayBuffer);
    for (const s of d.segments) if (s.roll) out.add(s.roll.buffer as ArrayBuffer);
    if (d.pre) for (const arr of [d.pre.x, d.pre.y, d.pre.t, d.pre.sog, d.pre.roll]) if (arr) out.add(arr.buffer as ArrayBuffer);
    out.add(d.startSog.t.buffer as ArrayBuffer);
    out.add(d.startSog.sog.buffer as ArrayBuffer);
  }
  return [...out];
}
