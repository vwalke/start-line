import { describe, expect, it } from 'vitest';
import { ROW_SIZE, VkxError, logSummary, looksLikeVkx, nominalRateHz, parseVkx } from '../src/data/vkx/parse';
import { R8_GUN, RO, Z, fullVkx, hasFullSample, trimVkx, vkxFeed } from './vkxHelpers';

describe('.vkx parser (trimmed fixture)', () => {
  it('reads every row type of the trimmed log', () => {
    const log = parseVkx(trimVkx());
    expect(log.stop).toBeNull();
    expect(log.parsedBytes).toBe(log.bytes);
    expect(log.version).toBe(5);
    expect(log.newerVersion).toBe(false);
    expect(log.config).toEqual({ bodyFixed: true, rateHz: 10 });
    expect(log.counts).toEqual({ '0x02': 8310, '0x03': 13, '0x04': 10, '0x05': 471, '0x07': 13, '0x08': 1, '0xfe': 192, '0xff': 193 });
    // Two repeated timestamps are dropped.
    expect(log.pos.n).toBe(8308);
    expect(log.pos.t[0]).toBe(Date.parse('2026-09-11T12:01:00.079Z'));
    expect(log.pos.t[log.pos.n - 1]).toBe(Date.parse('2026-09-11T13:57:59.968Z'));
    expect(logSummary(log).rateHz).toBe(10);
    expect(nominalRateHz(log.pos.t)).toBe(10);
  });

  it('decodes the timer events (two race starts), line pings and declination', () => {
    const log = parseVkx(trimVkx());
    const starts = log.timers.filter((e) => e.name === 'RACE_START').map((e) => e.t);
    expect(starts).toEqual([Z('12:05:00'), R8_GUN]);
    expect(log.timers.map((e) => e.name)).toEqual(['RACE_END', 'RESET', 'START', 'RACE_START', 'RACE_END', 'RESET', 'START', 'RACE_START', 'RACE_END', 'RESET']);
    expect(log.timers.find((e) => e.name === 'START')!.value).toBe(1985);
    expect(log.pings).toHaveLength(471);
    expect(log.pings.filter((p) => p.end === 0)).toHaveLength(277);
    for (const p of log.pings) {
      expect(p.lat).toBeCloseTo(38.66, 1);
      expect(p.lon).toBeCloseTo(-9.46, 1);
    }
    expect(log.declination).toHaveLength(13);
    expect(log.declination[0].rad).toBeCloseTo(-0.01479, 5);
  });

  it('turns the quaternion into heading, heel and trim as the feed has them', () => {
    // Every USA 833 feed row inside the trimmed windows vs the log's nearest earlier fix.
    const log = parseVkx(trimVkx());
    const p = vkxFeed();
    const f = (n: string): number => p.Fields!.indexOf(n);
    const d: { h: number[]; r: number[]; p: number[] } = { h: [], r: [], p: [] };
    for (const r of p.Rows!) {
      const ts = Number(r[f('ts')]);
      if (Number(r[f('sn')]) !== RO.sn || ts < log.pos.t[0] || ts > log.pos.t[log.pos.n - 1]) continue;
      let k = log.pos.t.findIndex((t) => t > ts);
      if (k <= 0 || log.pos.t[k] - log.pos.t[k - 1] > 500) continue;
      k -= 1;
      d.h.push(Math.abs(((log.pos.heading[k] - Number(r[f('heading')]) + 540) % 360) - 180));
      d.r.push(Math.abs(log.pos.heel[k] - Number(r[f('roll')])));
      d.p.push(Math.abs(log.pos.pitch[k] - Number(r[f('pitch')])));
    }
    const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];
    expect(d.h.length).toBeGreaterThan(100);
    expect(med(d.h)).toBeLessThan(2);
    expect(med(d.r)).toBeLessThan(1.5);
    expect(med(d.p)).toBeLessThan(1.5);
    for (let i = 0; i < log.pos.n; i += 97) {
      expect(log.pos.heading[i]).toBeGreaterThanOrEqual(0);
      expect(log.pos.heading[i]).toBeLessThan(360);
      expect(log.pos.cog[i]).toBeGreaterThanOrEqual(0);
      expect(log.pos.cog[i]).toBeLessThan(360);
    }
  });

  it('stops safely at a truncated row, keeping what it read', () => {
    const ab = trimVkx();
    const cut = ab.slice(0, ab.byteLength - 20);
    const log = parseVkx(cut);
    expect(log.stop?.reason).toBe('truncated');
    expect(log.stop!.message).toMatch(/truncated/);
    expect(log.pos.n).toBeGreaterThan(8000);
    expect(log.parsedBytes).toBeLessThan(cut.byteLength);
  });

  it('stops at an unknown row type and says where', () => {
    const b = new Uint8Array(trimVkx().slice(0));
    // Row boundaries: walk the size table to ~byte 2000, then plant an unknown key.
    let i = 0;
    while (i < 2000) i += 1 + ROW_SIZE[b[i]];
    b[i] = 0x99;
    const log = parseVkx(b.buffer);
    expect(log.stop).toMatchObject({ reason: 'unknown-key', offset: i, key: 0x99 });
    expect(log.stop!.message).toMatch(/0x99/);
    expect(log.pos.n).toBeGreaterThan(10);
  });

  it('rejects files that are not .vkx, quickly', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer;
    expect(looksLikeVkx(png)).toBe(false);
    expect(() => parseVkx(png)).toThrow(VkxError);
    expect(() => parseVkx(new TextEncoder().encode('lat,lon\n1,2\n').buffer as ArrayBuffer)).toThrow(/Not a Vakaros/);
    expect(() => parseVkx(new ArrayBuffer(0))).toThrow(VkxError);
    // A page header alone: a .vkx, but no positions.
    const head = new Uint8Array(trimVkx().slice(0, 8 + 14));
    try {
      parseVkx(head.buffer);
      expect.unreachable();
    } catch (e) {
      expect((e as VkxError).code).toBe('empty');
    }
  });
});

describe.skipIf(!hasFullSample)('.vkx parser (full 10 MB sample)', () => {
  it('parses the whole day in well under a second', () => {
    const ab = fullVkx();
    parseVkx(ab); // warm up
    const t0 = performance.now();
    const log = parseVkx(ab);
    const ms = performance.now() - t0;
    console.log(`[vkx] parsed ${(ab.byteLength / 1e6).toFixed(1)} MB, ${log.pos.n} positions in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(500);
    expect(log.stop).toBeNull();
    expect(log.counts['0x02']).toBe(231_466);
    expect(log.pos.n).toBe(231_429);
    expect(log.timers).toHaveLength(10);
    expect(log.pings).toHaveLength(2_796);
    expect(log.declination).toHaveLength(392);
    expect(log.pos.t[0]).toBe(1_789_120_493_048); // 05:54:53 EDT
    expect(log.pos.t[log.pos.n - 1]).toBe(1_789_143_801_436); // 12:23:21 EDT
  });
});
