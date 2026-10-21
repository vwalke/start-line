import { describe, expect, it } from 'vitest';
import { MS_TO_KN, PayloadError, decodePayload, decodePayloadRaw, encodePayload, encodePayloadRaw, gunzip, gzip } from '../src/data/vkx/compact';
import { parseVkx } from '../src/data/vkx/parse';
import { DIV, EVENT, RO, trimVkx } from './vkxHelpers';

const head = {
  event: EVENT,
  div: DIV,
  race: '7',
  gunMs: Date.parse('2026-09-11T12:05:01Z'),
  sn: RO.sn,
  sail: RO.sail,
  name: RO.name,
  rateHz: 10,
  timers: [{ t: Date.parse('2026-09-11T12:05:00Z'), type: 3, value: 0 }],
  pings: [{ t: Date.parse('2026-09-11T12:00:00Z'), end: 0, lat: 38.66, lon: -9.46 }],
  declinationRad: -0.0148,
  srcSha256: 'a'.repeat(64),
  srcBytes: 123,
};

const samplesOf = (n = 3000) => {
  const p = parseVkx(trimVkx()).pos;
  return {
    t: p.t.subarray(0, n),
    latE7: p.latE7.subarray(0, n),
    lonE7: p.lonE7.subarray(0, n),
    sog: p.sog.subarray(0, n),
    cog: p.cog.subarray(0, n),
    heading: p.heading.subarray(0, n),
    heel: p.heel.subarray(0, n),
    pitch: p.pitch.subarray(0, n),
  };
};

const angleDiff = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe('compact payload (RVKX v1)', () => {
  it('round-trips within the stated precision', async () => {
    const s = samplesOf();
    const gz = await encodePayload(head, s);
    const p = await decodePayload(gz);
    expect(p.header).toMatchObject({ ...head, format: 'recall-vkx', v: 1, n: 3000, t0: s.t[0], t1: s.t[2999] });
    expect(p.header.cols).toEqual(['t', 'lat', 'lon', 'sog', 'cog', 'hdg', 'heel', 'pitch']);
    for (let k = 0; k < 3000; k++) {
      expect(p.t[k]).toBe(s.t[k]);
      expect(Math.round(p.lat[k] * 1e7)).toBe(s.latE7[k]);
      expect(Math.round(p.lon[k] * 1e7)).toBe(s.lonE7[k]);
      expect(Math.abs(p.sog[k] / MS_TO_KN - s.sog[k])).toBeLessThanOrEqual(0.0051);
      expect(angleDiff(p.cog[k], s.cog[k])).toBeLessThanOrEqual(0.051);
      expect(angleDiff(p.heading![k], s.heading[k])).toBeLessThanOrEqual(0.051);
      expect(Math.abs(p.heel![k] - s.heel[k])).toBeLessThanOrEqual(0.051);
      expect(Math.abs(p.pitch![k] - s.pitch[k])).toBeLessThanOrEqual(0.051);
    }
  });

  it('is small: about a kilobyte per 10 Hz minute after gzip', async () => {
    const s = samplesOf(6000);
    const raw = encodePayloadRaw(head, s);
    const gz = await gzip(raw);
    expect(raw.length / 6000).toBeLessThan(12);
    expect(gz.length / 6000).toBeLessThan(8);
  });

  it('omits the orientation columns when the log has none', async () => {
    const s = samplesOf(100);
    const p = await decodePayload(await encodePayload(head, { ...s, heading: null, heel: null, pitch: null }));
    expect(p.header.cols).toEqual(['t', 'lat', 'lon', 'sog', 'cog']);
    expect(p.heading).toBeNull();
    expect(p.heel).toBeNull();
  });

  it('rejects malformed payloads', async () => {
    const raw = encodePayloadRaw(head, samplesOf(200));
    expect(() => decodePayloadRaw(raw.subarray(0, raw.length - 3))).toThrow(PayloadError);
    const bad = raw.slice();
    bad[0] = 0x58;
    expect(() => decodePayloadRaw(bad)).toThrow(/Not a Recall/);
    const v2 = raw.slice();
    v2[4] = 2;
    expect(() => decodePayloadRaw(v2)).toThrow(/version/);
    const extra = new Uint8Array(raw.length + 1);
    extra.set(raw);
    expect(() => decodePayloadRaw(extra)).toThrow(/Trailing/);
    await expect(decodePayload(raw)).rejects.toThrow(/not gzip/);
    await expect(gunzip(new Uint8Array([0x1f, 0x8b, 1, 2, 3]))).rejects.toThrow(PayloadError);
  });

  it('refuses to unpack past the size cap (zip bomb guard)', async () => {
    const gz = await gzip(new Uint8Array(5_000_000));
    expect(gz.length).toBeLessThan(20_000);
    await expect(gunzip(gz, 1_000_000)).rejects.toThrow(/too large/);
  });
});
