import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TZ, dayRange, formatReport, main, parseArgs, query, reportSql, summarize, yesterday } from '../scripts/usage-report.mjs';
import { trackPoints } from '../functions/_track';

const SCRIPT = fileURLToPath(new URL('../scripts/usage-report.mjs', import.meta.url));
const cli = (argv: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

describe('scripts/usage-report.mjs', () => {
  it('days run midnight to midnight in the zone, across clock changes', () => {
    expect(dayRange('2026-10-28', 'America/New_York')).toEqual({ from: '2026-10-28 04:00:00', to: '2026-10-29 04:00:00' });
    expect(dayRange('2026-11-01', 'America/New_York')).toEqual({ from: '2026-11-01 04:00:00', to: '2026-11-02 05:00:00' });
    expect(dayRange('2026-03-08', 'America/New_York')).toEqual({ from: '2026-03-08 05:00:00', to: '2026-03-09 04:00:00' });
    expect(dayRange('2026-10-28', 'UTC')).toEqual({ from: '2026-10-28 00:00:00', to: '2026-10-29 00:00:00' });
    // 01:30 UTC on the 29th is still the 28th in New York.
    expect(yesterday(Date.parse('2026-10-29T01:30:00Z'), 'America/New_York')).toBe('2026-10-27');
    expect(yesterday(Date.parse('2026-10-29T01:30:00Z'), 'UTC')).toBe('2026-10-28');
  });

  it('parses its arguments strictly', () => {
    expect(parseArgs([])).toEqual({ day: null, tz: DEFAULT_TZ, dataset: 'recall_events', sql: false, help: false });
    expect(parseArgs(['--day', '2026-10-28', '--tz', 'UTC', '--sql'])).toMatchObject({ day: '2026-10-28', tz: 'UTC', sql: true });
    for (const bad of [['--day', '2026-02-30'], ['--day', "2026-10-28'; DROP"], ['--tz', 'Mars/Olympus'], ['--dataset', 'x; DELETE'], ['--wat'], ['--day']]) expect(() => parseArgs(bad), bad.join(' ')).toThrow();
  });

  it('builds read-only SQL over the documented columns, counting with _sample_interval', () => {
    const sql = reportSql({ day: '2026-10-28' });
    expect(Object.keys(sql).sort()).toEqual(['events', 'races', 'regattas', 'sessions', 'signedIn']);
    for (const q of Object.values(sql)) {
      expect(q).toMatch(/^SELECT /);
      expect(q).not.toMatch(/\b(INSERT|DELETE|DROP|ALTER|CREATE)\b/i);
      expect(q).toContain('FROM recall_events');
      expect(q).toContain("timestamp >= toDateTime('2026-10-28 04:00:00') AND timestamp < toDateTime('2026-10-29 04:00:00')");
      expect(q).toContain('SUM(_sample_interval)');
      expect(q).toMatch(/FORMAT JSON$/);
    }
    expect(sql.sessions).toContain('index1 AS session, blob1 AS event, blob6 AS device, blob7 AS referrer');
    expect(sql.races).toContain("blob1 = 'race_open'");
    expect(sql.races).toContain('blob3 AS event_id, blob4 AS race');
    expect(sql.regattas).toContain("blob1 = 'regatta_open'");
    expect(sql.signedIn).toContain('blob5 AS signed_in');
    expect(sql.events).toContain('blob9 AS detail');
  });

  it('reads the columns where the endpoint writes them', () => {
    const [p] = trackPoints({ sid: '0f8fad5b-d9cb-469f-a165-70867728950e', dev: 'tablet', th: 'dark', auth: 'no', ev: [{ n: 'race_open', p: '/regattas/start', e: 'e1', r: 'A|2', d: 'locked', f: 'news.ycombinator.com', s: 1, t: 0 }] })!;
    const blob = (i: number) => p.blobs[i - 1];
    expect([blob(1), blob(2), blob(3), blob(4), blob(5), blob(6), blob(7), blob(8), blob(9)]).toEqual(['race_open', '/regattas/start', 'e1', 'A|2', 'no', 'tablet', 'news.ycombinator.com', 'dark', 'locked']);
  });

  it('sessions, bounces, the funnel, devices and referrers', () => {
    const s = summarize([
      { session: 'a', event: 'landing_view', device: 'mobile', referrer: 'www.google.com', n: 1 },
      { session: 'a', event: 'race_open', device: 'mobile', referrer: '', n: 2 },
      { session: 'a', event: 'signin_start', device: 'mobile', referrer: '', n: 1 },
      { session: 'a', event: 'signin_done', device: 'mobile', referrer: '', n: 1 },
      { session: 'b', event: 'landing_view', device: 'desktop', referrer: '', n: 1 },
      { session: 'c', event: 'race_open', device: 'desktop', referrer: 'www.google.com', n: '3' },
      { session: 'c', event: 'signin_start', device: 'desktop', referrer: '', n: 1 },
    ]);
    expect(s).toMatchObject({ sessions: 3, bounced: 1 });
    expect(s.bounceRate).toBeCloseTo(1 / 3);
    expect(s.funnel).toEqual([
      { step: 'landing_view', sessions: 2, any: 2 },
      { step: 'race_open', sessions: 1, any: 2 },
      { step: 'signin_start', sessions: 1, any: 2 },
      { step: 'signin_done', sessions: 1, any: 1 },
    ]);
    expect(s.devices).toEqual([
      ['desktop', 2],
      ['mobile', 1],
    ]);
    expect(s.referrers).toEqual([['www.google.com', 2]]);
    const text = formatReport({ day: '2026-10-28', tz: DEFAULT_TZ, summary: s, events: [{ event: 'tab', detail: 'coach', n: 4 }], races: [{ event_id: 'e1', race: 'A|2', n: 5 }], regattas: [{ event_id: 'e1', n: 2 }], signedIn: [{ signed_in: 'no', n: 7 }] });
    expect(text).toContain('Sessions: 3');
    expect(text).toContain('Bounce rate: 33.3%');
    expect(text).toContain('e1 · A race 2');
    expect(text).toContain('tab · coach');
    expect(summarize([])).toMatchObject({ sessions: 0, bounceRate: 0 });
  });

  it('--sql prints the queries and calls nothing; without credentials it says what to set', () => {
    const r = cli(['--sql', '--day', '2026-10-28']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('FROM recall_events');
    expect(r.out).toContain('-- sessions');
    const none = cli(['--day', '2026-10-28']);
    expect(none.status).toBe(1);
    expect(none.err).toContain('CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN');
  });

  it('calls the SQL API with the token in the header only, and never prints it', async () => {
    const token = 'tok_secret_123';
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ meta: [], data: [{ session: 'a', event: 'app_open', device: 'desktop', referrer: '', n: 1 }], rows: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await main(['--day', '2026-10-28'], { CF_ACCOUNT_ID: 'acc123', CF_ANALYTICS_TOKEN: token }, { log: (s) => lines.push(s), fetchImpl });
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(c.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql');
      expect(c.init.method).toBe('POST');
      expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
      expect(String(c.init.body)).toMatch(/^SELECT /);
      expect(String(c.init.body)).not.toContain(token);
    }
    expect(lines.join('\n')).not.toContain(token);
    expect(lines.join('\n')).toContain('Sessions: 1');
    const failing = (async () => new Response('{"errors":[{"message":"Authentication error"}]}', { status: 403 })) as unknown as typeof fetch;
    await expect(query('SELECT 1', { accountId: 'a', token, fetchImpl: failing })).rejects.toThrow(/403/);
    await expect(query('SELECT 1', { accountId: 'a', token, fetchImpl: failing })).rejects.not.toThrow(token);
  });
});
