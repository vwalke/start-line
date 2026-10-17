import { describe, expect, it } from 'vitest';
import {
  ALLOWED,
  buildQuery,
  buildTelemetryQuery,
  endpointPath,
  looksLikeJson,
  parseRoute,
  telemetryTtl,
  ttlFor,
} from '../functions/_lib';

describe('Pages Function proxy allowlist', () => {
  it('accepts landing, regatta, wind and telemetry/event/:id', () => {
    expect(Object.keys(ALLOWED).sort()).toEqual(['landing', 'regatta', 'wind']);
    expect(endpointPath(['landing'])).toBe('landing');
    expect(parseRoute('landing')).toEqual({ kind: 'racesense', path: 'landing' });
    expect(parseRoute('telemetry/event/fDHdPcEOM6mcMRkdXNnj')).toEqual({
      kind: 'telemetry',
      eventId: 'fDHdPcEOM6mcMRkdXNnj',
    });
    expect(parseRoute('telemetry/event/../x').kind).toBe('error');
    expect(parseRoute('secret').kind).toBe('error');
    expect(buildQuery('secret', new URLSearchParams()).ok).toBe(false);
  });

  it('drops unknown query params and requires the known ones', () => {
    const landing = buildQuery('landing', new URLSearchParams('extra=1'));
    expect(landing.ok).toBe(true);
    if (landing.ok) expect(landing.qs.toString()).toBe('');

    const badEvent = buildQuery('regatta', new URLSearchParams('event=../x'));
    expect(badEvent.ok).toBe(false);

    const goodEvent = buildQuery('regatta', new URLSearchParams('event=fDHdPcEOM6mcMRkdXNnj&extra=1'));
    expect(goodEvent.ok).toBe(true);
    if (goodEvent.ok) expect([...goodEvent.qs.keys()]).toEqual(['event']);

    const wind = buildQuery(
      'wind',
      new URLSearchParams('v=3&lat=52.3453&lon=5.0768&start=2026-10-17&end=2026-10-17&hack=1'),
    );
    expect(wind.ok).toBe(true);
    if (wind.ok) expect([...wind.qs.keys()]).toEqual(['v', 'lat', 'lon', 'start', 'end']);

    expect(buildQuery('wind', new URLSearchParams('lat=91&lon=0&start=2026-10-17&end=2026-10-17')).ok).toBe(false);
    expect(buildQuery('wind', new URLSearchParams('lat=52&lon=5')).ok).toBe(false);
  });

  it('validates the telemetry window and drops extra params', () => {
    const ok = buildTelemetryQuery(
      new URLSearchParams('after=1792237111000&before=1792238500000&limit=100000&division=J70&hack=1'),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect([...ok.qs.keys()]).toEqual(['after', 'before', 'limit', 'division']);

    expect(buildTelemetryQuery(new URLSearchParams('after=1&before=2')).ok).toBe(false);
    expect(buildTelemetryQuery(new URLSearchParams('after=1792237111000&before=1792237111000')).ok).toBe(false);
    expect(buildTelemetryQuery(new URLSearchParams('after=1792237111000&before=1792337111000')).ok).toBe(false);
    expect(buildTelemetryQuery(new URLSearchParams('after=1792237111000&before=1792238500000&limit=0')).ok).toBe(false);
    expect(buildTelemetryQuery(new URLSearchParams('after=1792237111000&before=1792238500000&division=../x')).ok).toBe(
      false,
    );
    const past = new URLSearchParams(`after=1000000000000&before=${Date.now() - 3 * 86_400_000}`);
    expect(telemetryTtl(past)).toBe(7 * 86_400);
    expect(telemetryTtl(new URLSearchParams(`after=1&before=${Date.now()}`))).toBe(60);
  });

  it('uses a long TTL for a finished event and a past wind day', () => {
    expect(ttlFor('landing', new URLSearchParams(), '{}')).toBe(600);
    const ended = JSON.stringify({ revisions: [{ doc: { endDate: Date.now() - 3 * 86_400_000 } }] });
    expect(ttlFor('regatta', new URLSearchParams('event=abcde'), ended)).toBe(7 * 86_400);
    expect(ttlFor('regatta', new URLSearchParams('event=abcde'), '{"nope":true}')).toBe(120);
    expect(ttlFor('wind', new URLSearchParams('end=2020-01-01'), '{}')).toBe(30 * 86_400);
    expect(looksLikeJson('{"ok":true}')).toBe(true);
    expect(looksLikeJson('<html>nope</html>')).toBe(false);
  });
});
