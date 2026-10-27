import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DB, TYPES, formatShow, listSql, parseArgs, rowsOf, showSql, sinceMs, wranglerArgs } from '../scripts/feedback.mjs';
import { FEEDBACK_TYPES } from '../functions/_feedback';

const SCRIPT = fileURLToPath(new URL('../scripts/feedback.mjs', import.meta.url));
/** The script itself (only ever with --print or --help here: nothing reaches wrangler). */
const cli = (...argv: string[]): { status: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const ID = '79733007-b065-4920-b85d-51fc2d817d9a';

describe('scripts/feedback.mjs', () => {
  it('parses list and show strictly', () => {
    expect(TYPES).toEqual([...FEEDBACK_TYPES]);
    expect(parseArgs(['list'])).toEqual({ cmd: 'list', limit: 50, since: null, type: null, db: DEFAULT_DB, target: 'remote', print: false });
    expect(parseArgs(['list', '--limit', '5', '--since', '2026-10-01', '--type', 'bug', '--local', '--print'])).toEqual({
      cmd: 'list',
      limit: 5,
      since: Date.parse('2026-10-01T00:00:00Z'),
      type: 'bug',
      db: DEFAULT_DB,
      target: 'local',
      print: true,
    });
    expect(parseArgs(['show', ID])).toMatchObject({ cmd: 'show', id: ID });
    expect(parseArgs(['--help'])).toEqual({ cmd: 'help' });
    const bad: string[][] = [
      [],
      ['delete', ID],
      ['list', '--limit', '0'],
      ['list', '--limit', '1001'],
      ['list', '--limit', '5; DROP TABLE feedback'],
      ['list', '--since', '2026-13-01'],
      ['list', '--since', "2026-10-01' OR 1=1"],
      ['list', '--type', 'rant'],
      ['list', 'extra'],
      ['show'],
      ['show', "x' OR '1'='1"],
      ['show', ID, '--type', 'bug'],
      ['show', ID, ID],
      ['list', '--remote', '--local'],
      ['list', '--db', 'x; rm -rf /'],
      ['list', '--force'],
    ];
    for (const argv of bad) expect(() => parseArgs(argv), argv.join(' ')).toThrow();
    expect(() => sinceMs('2026-02-30')).toThrow();
  });

  it('builds the SQL and the wrangler arguments (with --json, no shell)', () => {
    expect(listSql({})).toMatch(/FROM feedback ORDER BY created_at DESC LIMIT 50;$/);
    expect(listSql({ limit: 5, since: 1_000, type: 'data' })).toMatch(/WHERE created_at >= 1000 AND type = 'data' ORDER BY created_at DESC LIMIT 5;$/);
    expect(() => listSql({ type: "bug' --" })).toThrow();
    expect(showSql({ id: ID })).toBe(`SELECT * FROM feedback WHERE id = '${ID}';`);
    expect(() => showSql({ id: 'nope' })).toThrow();
    expect(wranglerArgs({ db: 'recall-auth', target: 'remote' }, 'SELECT 1;')).toEqual(['wrangler', 'd1', 'execute', 'recall-auth', '--remote', '--json', '--command', 'SELECT 1;']);
  });

  it('shows one submission with its context laid out', () => {
    const rows = rowsOf(
      JSON.stringify([
        {
          results: [
            {
              id: ID,
              created_at: Date.parse('2026-10-27T10:00:00Z'),
              type: 'bug',
              message: 'The map froze.\nTwice.',
              email: 'a@example.com',
              user_id: null,
              url: 'https://recall.walkeforward.com/regattas?event=E1',
              app_commit: 'abc1234',
              user_agent: 'Mozilla/5.0',
              context_json: JSON.stringify({
                where: { eventId: 'E1', tab: 'race', boats: ['USA 833'] },
                device: { viewport: '390×844' },
                theme: { resolved: 'dark', source: 'chosen' },
                data: { loaded: true, boatCount: 18 },
                problems: [{ at: '2026-10-27T09:59:00Z', kind: 'api', text: 'GET /api/regatta?event → 502' }],
                timeOnPageS: 61,
              }),
              image_key: `feedback/${ID}/image.webp`,
              image_type: 'image/webp',
              image_bytes: 1234,
              email_error: 'owner@example.com: down',
            },
          ],
          success: true,
        },
      ]),
    );
    const out = formatShow(rows[0]);
    expect(out).toContain('a@example.com (signed out)');
    expect(out).toContain('  The map froze.\n  Twice.');
    expect(out).toMatch(/boats\s+\["USA 833"\]/);
    expect(out).toMatch(/theme\s+dark, chosen/);
    expect(out).toContain('GET /api/regatta?event → 502');
    expect(out).toContain(`feedback/${ID}/image.webp (image/webp, 1234 bytes)`);
    expect(out).toMatch(/email error\s+owner@example.com: down/);
    expect(formatShow(undefined)).toBe('No feedback with that id.');
  });

  it('runs as the admin would, printing the SQL only', () => {
    const r = cli('list', '--type', 'idea', '--print');
    expect(r.status).toBe(0);
    expect(r.out).toContain("type = 'idea'");
    expect(r.err).toContain('List feedback on recall-auth (remote)');
    expect(cli('show', 'nope').status).toBe(2);
    expect(cli('--help').out).toContain('Usage:');
  });
});
