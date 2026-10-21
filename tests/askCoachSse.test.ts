import { describe, expect, it } from 'vitest';
import { createSseParser, readSse, sseFrame, type SseEvent } from '../src/data/askCoach/sse';

const parse = (chunks: string[]): SseEvent[] => {
  const out: SseEvent[] = [];
  const p = createSseParser((e) => out.push(e));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
};

/** A byte stream that delivers `text` in pieces of `size` bytes (cutting UTF-8 code points too). */
function byteStream(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

describe('SSE parser', () => {
  const wire = 'event: delta\ndata: {"text":"Hi"}\n\n: a comment\nevent: done\ndata: {"a":1}\ndata: {"b":2}\nid: 7\n\n';

  it('parses events, joins multi-line data, skips comments', () => {
    expect(parse([wire])).toEqual([
      { event: 'delta', data: '{"text":"Hi"}' },
      { event: 'done', data: '{"a":1}\n{"b":2}', id: '7' },
    ]);
  });

  it('gives the same events however the text is cut (every split point)', () => {
    const whole = parse([wire]);
    for (let i = 0; i <= wire.length; i++) expect(parse([wire.slice(0, i), wire.slice(i)])).toEqual(whole);
    expect(parse(wire.split(''))).toEqual(whole);
  });

  it('handles CRLF and CR line ends, split between CR and LF', () => {
    const crlf = 'data: one\r\n\r\ndata: two\r\rdata: three\n\n';
    const want = [{ event: 'message', data: 'one' }, { event: 'message', data: 'two' }, { event: 'message', data: 'three' }];
    expect(parse([crlf])).toEqual(want);
    expect(parse(['data: one\r', '\n\r', '\ndata: two\r\rdata: three\n\n'])).toEqual(want);
  });

  it('field rules: no space after the colon, a bare field, no data → no event, unknown fields ignored', () => {
    expect(parse(['data:x\ndata\nretry: 10\nfoo: bar\n\n'])).toEqual([{ event: 'message', data: 'x\n' }]);
    expect(parse(['event: ping\n\n'])).toEqual([]);
  });

  it('a final event without its blank line is still dispatched at end()', () => {
    expect(parse(['event: done\ndata: {}'])).toEqual([{ event: 'done', data: '{}' }]);
  });

  it('reads a byte stream cut mid code point', async () => {
    const text = sseFrame('delta', { text: 'Gybe → 3° ✓ "quoted"\nline' }) + sseFrame('done', { ok: true });
    const out: SseEvent[] = [];
    await readSse(byteStream(text, 3), (e) => out.push(e));
    expect(out.map((e) => e.event)).toEqual(['delta', 'done']);
    expect(JSON.parse(out[0].data)).toEqual({ text: 'Gybe → 3° ✓ "quoted"\nline' });
  });

  it('sseFrame never lets data end the event early', () => {
    const f = sseFrame('delta', { text: 'a\n\nevent: error\ndata: x' });
    expect(parse([f])).toEqual([{ event: 'delta', data: JSON.stringify({ text: 'a\n\nevent: error\ndata: x' }) }]);
  });
});
