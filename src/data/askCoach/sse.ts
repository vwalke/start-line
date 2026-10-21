/**
 * A small Server-Sent Events parser (the WHATWG event-stream format), pure: feed it text as it
 * arrives, in chunks cut anywhere (mid-line, mid-CRLF), and it calls back once per complete
 * event. Used by the browser for Ask Coach's stream and by the Pages Function for Anthropic's.
 *
 * Lines: `field: value` (one leading space dropped), `field` alone (empty value), `:comment`
 * (ignored). `data` lines join with "\n"; a blank line dispatches; an event with no data is
 * dropped; `event` defaults to "message". CR, LF and CRLF all end a line.
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export interface SseParser {
  /** Feed the next chunk of text. */
  push(chunk: string): void;
  /** The stream ended: a last event without its blank line is still dispatched (a truncated stream's final event). */
  end(): void;
}

export function createSseParser(onEvent: (e: SseEvent) => void): SseParser {
  let buf = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;
  // A chunk that ended in CR: a LF opening the next one belongs to that line break.
  let skipLf = false;

  const dispatch = (): void => {
    if (data.length) onEvent({ event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) });
    event = '';
    data = [];
  };

  const line = (l: string): void => {
    if (l === '') return dispatch();
    if (l.startsWith(':')) return;
    const c = l.indexOf(':');
    const field = c < 0 ? l : l.slice(0, c);
    let value = c < 0 ? '' : l.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
    // retry and unknown fields: ignored.
  };

  return {
    push(chunk) {
      let s = chunk;
      if (skipLf && s.startsWith('\n')) s = s.slice(1);
      skipLf = false;
      buf += s;
      for (;;) {
        const i = buf.search(/[\r\n]/);
        if (i < 0) break;
        const crlf = buf[i] === '\r' && buf[i + 1] === '\n';
        if (buf[i] === '\r' && i === buf.length - 1) skipLf = true;
        line(buf.slice(0, i));
        buf = buf.slice(i + (crlf ? 2 : 1));
      }
    },
    end() {
      if (buf) line(buf);
      buf = '';
      dispatch();
    },
  };
}

/** Read a byte stream to its end through the parser (UTF-8, split code points kept whole). */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (e: SseEvent) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const p = createSseParser(onEvent);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      p.push(dec.decode(value, { stream: true }));
    }
    p.push(dec.decode());
    p.end();
  } finally {
    reader.releaseLock();
  }
}

/** One event in the wire format (data split on line breaks so it can't end the event early). */
export const sseFrame = (event: string, data: unknown): string =>
  `event: ${event}\n${JSON.stringify(data)
    .split(/\r\n|\r|\n/)
    .map((l) => `data: ${l}`)
    .join('\n')}\n\n`;
