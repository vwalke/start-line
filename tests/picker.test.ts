import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePickerParams } from '../src/ui/params';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const html = read('index.html');

describe('demo mode is gone', () => {
  it('has no demo link in the page', () => {
    expect(html).not.toContain('?demo');
    expect(html).not.toContain('mode-link');
    expect(html).not.toContain('Demo (offline)');
  });

  it('does not bundle the fixture or keep a fixture path in the app and worker', () => {
    const app = read('src/ui/app.ts');
    const worker = read('src/worker.ts');
    for (const src of [app, worker]) {
      expect(src).not.toContain('tests/fixtures');
      expect(src).not.toContain('loadDemo');
      expect(src).not.toMatch(/type:\s*'fixture'/);
      expect(src).not.toContain("'fixture'");
    }
    expect(app).not.toContain("params.get('demo')");
  });
});

describe('event search markup', () => {
  const input = /<input[^>]*id="event-search"[^>]*>/.exec(html)?.[0] ?? '';

  it('has a labelled search box before the Event select', () => {
    expect(input).not.toBe('');
    expect(html).toMatch(/<label>Search <input[^>]*id="event-search"/);
    expect(html.indexOf('id="event-search"')).toBeLessThan(html.indexOf('id="event"'));
    for (const attr of [
      'type="search"',
      'placeholder="Event, venue, class or date"',
      'autocomplete="off"',
      'spellcheck="false"',
      'aria-controls="event"',
      'aria-describedby="event-count"',
      'disabled',
    ]) {
      expect(input).toContain(attr);
    }
  });

  it('has a polite live match count', () => {
    expect(html).toMatch(/<span[^>]*id="event-count"[^>]*aria-live="polite"/);
  });
});

describe('parsePickerParams', () => {
  it('reads event, division and race', () => {
    expect(parsePickerParams('?event=X&div=J70&race=8')).toEqual({ eventId: 'X', want: { division: 'J70', raceNumber: 8 } });
    expect(parsePickerParams('')).toEqual({ eventId: '' });
    expect(parsePickerParams('?event=X&div=J70')).toEqual({ eventId: 'X' });
    expect(parsePickerParams('?event=X&div=J70&race=abc')).toEqual({ eventId: 'X' });
  });

  it('ignores ?demo= from old links', () => {
    expect(parsePickerParams('?demo=1')).toEqual(parsePickerParams(''));
    expect(parsePickerParams('?demo=0')).toEqual(parsePickerParams(''));
    expect(parsePickerParams('?demo=0&event=X&div=J70&race=8')).toEqual(parsePickerParams('?event=X&div=J70&race=8'));
    expect(parsePickerParams('?event=X&demo=1&div=J70&race=8')).toEqual(parsePickerParams('?event=X&div=J70&race=8'));
  });
});
