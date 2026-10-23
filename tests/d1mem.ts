/**
 * An in-memory stand-in for a Workers D1 database, for the paywall tests. It loads the tables of
 * every migration in migrations/, in order (columns, NOT NULL, PRIMARY KEY and UNIQUE, single or
 * composite; ALTER TABLE … ADD COLUMN; CREATE UNIQUE INDEX) and runs the small SQL subset
 * functions/_authDb.ts keeps to: single-table SELECT / INSERT [OR IGNORE] / UPDATE / DELETE, WHERE
 * of ANDed comparisons (= != < > <= >=), IS [NOT] NULL and IN (…), one ORDER BY column, LIMIT; and
 * the one upsert of the sign-in rate limits (INSERT … ON CONFLICT (key) DO UPDATE SET … RETURNING,
 * with column, excluded.column, integer, `+` and CASE WHEN a = b THEN x ELSE y END expressions).
 * Anything else throws, so a query outside the subset fails loudly here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { D1Like, D1StatementLike } from '../functions/_authDb';

type Row = Record<string, unknown>;

interface Table {
  cols: string[];
  notNull: Set<string>;
  unique: string[][];
  rows: Row[];
}

export const MIGRATION = fileURLToPath(new URL('../migrations/0001_paywall.sql', import.meta.url));
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Every migration's SQL, in file order (as `wrangler d1 migrations apply` runs them). */
export const allMigrations = (): string =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(`${MIGRATIONS_DIR}${f}`, 'utf8'))
    .join('\n');

/** Split on commas outside parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseSchema(sql: string): Map<string, Table> {
  const tables = new Map<string, Table>();
  const clean = sql.replace(/--[^\n]*/g, '');
  for (const stmt of clean.split(';')) {
    const alter = /^ALTER TABLE (\w+) ADD COLUMN (\w+)([\s\S]*)$/i.exec(stmt.trim());
    if (alter) {
      const t = tables.get(alter[1]);
      if (!t) throw new Error(`d1mem: ALTER of unknown table ${alter[1]}`);
      if (/NOT NULL|UNIQUE|PRIMARY/i.test(alter[3])) throw new Error(`d1mem: unsupported ADD COLUMN ${stmt.trim()}`);
      t.cols.push(alter[2]);
      for (const r of t.rows) r[alter[2]] = null;
      continue;
    }
    const idx = /^CREATE UNIQUE INDEX \w+ ON (\w+) \(([^)]+)\)$/i.exec(stmt.trim());
    if (idx) {
      tables.get(idx[1])?.unique.push(idx[2].split(',').map((c) => c.trim()));
      continue;
    }
    const m = /CREATE TABLE (\w+) \(([\s\S]*)\)\s*$/i.exec(stmt.trim());
    if (!m) continue;
    const t: Table = { cols: [], notNull: new Set(), unique: [], rows: [] };
    for (const part of splitTop(m[2])) {
      const key = /^(PRIMARY KEY|UNIQUE)\s*\(([^)]+)\)/i.exec(part);
      if (key) {
        const cols = key[2].split(',').map((c) => c.trim());
        t.unique.push(cols);
        if (/PRIMARY/i.test(key[1])) cols.forEach((c) => t.notNull.add(c));
        continue;
      }
      const [name] = part.split(/\s+/);
      t.cols.push(name);
      if (/PRIMARY KEY/i.test(part)) {
        t.unique.push([name]);
        t.notNull.add(name);
      } else if (/\bUNIQUE\b/i.test(part)) t.unique.push([name]);
      if (/NOT NULL/i.test(part)) t.notNull.add(name);
    }
    tables.set(m[1], t);
  }
  return tables;
}

type Val = { p: number } | { lit: unknown };
type Cond = { col: string; op: string; vals: Val[]; sub?: { col: string; table: string; where: Cond[] } };

const lit = (tok: string): Val => {
  const p = /^\$(\d+)$/.exec(tok);
  if (p) return { p: Number(p[1]) };
  if (/^'.*'$/.test(tok)) return { lit: tok.slice(1, -1).replace(/''/g, "'") };
  if (/^NULL$/i.test(tok)) return { lit: null };
  if (/^-?\d+(\.\d+)?$/.test(tok)) return { lit: Number(tok) };
  throw new Error(`d1mem: unsupported value ${tok}`);
};

function parseWhere(w: string | undefined): Cond[] {
  if (!w) return [];
  return w.split(/\s+AND\s+/i).map((term) => {
    let m = /^(\w+) IS (NOT )?NULL$/i.exec(term.trim());
    if (m) return { col: m[1], op: m[2] ? 'notnull' : 'null', vals: [] };
    // A one-condition subquery (scripts/sessions.mjs): col IN (SELECT col FROM table WHERE col = value).
    m = /^(\w+) IN \(SELECT (\w+) FROM (\w+) WHERE (\w+ = \S+)\)$/i.exec(term.trim());
    if (m) return { col: m[1], op: 'insel', vals: [], sub: { col: m[2], table: m[3], where: parseWhere(m[4]) } };
    m = /^(\w+) IN \(([^)]*)\)$/i.exec(term.trim());
    if (m) return { col: m[1], op: 'in', vals: m[2].split(',').map((x) => lit(x.trim())) };
    m = /^(\w+) (=|!=|<=|>=|<|>) (\S+)$/.exec(term.trim());
    if (m) return { col: m[1], op: m[2], vals: [lit(m[3])] };
    throw new Error(`d1mem: unsupported condition ${term}`);
  });
}

export class MemD1 implements D1Like {
  readonly tables: Map<string, Table>;
  /** Every statement run, in order (for assertions). */
  readonly log: string[] = [];
  fail = false;

  constructor(schemaSql = allMigrations()) {
    this.tables = parseSchema(schemaSql);
  }

  rows(table: string): Row[] {
    return this.table(table).rows.map((r) => ({ ...r }));
  }

  private table(name: string): Table {
    const t = this.tables.get(name);
    if (!t) throw new Error(`d1mem: no such table ${name}`);
    return t;
  }

  prepare(sql: string): D1StatementLike {
    let params: unknown[] = [];
    const exec = (): { rows: Row[]; changes: number } => this.exec(sql, params);
    const stmt: D1StatementLike = {
      bind: (...v: unknown[]) => {
        params = v;
        return stmt;
      },
      first: async <T>() => (exec().rows[0] as T | undefined) ?? null,
      all: async <T>() => ({ results: exec().rows as T[] }),
      run: async () => ({ meta: { changes: exec().changes } }),
    };
    return stmt;
  }

  private exec(sql: string, params: unknown[]): { rows: Row[]; changes: number } {
    if (this.fail) throw new Error('D1 unavailable');
    this.log.push(sql);
    let n = 0;
    const s = sql.replace(/\s+/g, ' ').trim().replace(/\?/g, () => `$${n++}`);
    if (n !== params.length) throw new Error(`d1mem: ${n} placeholders, ${params.length} bound: ${sql}`);
    const val = (v: Val): unknown => {
      if ('lit' in v) return v.lit;
      const x = params[v.p];
      if (x === undefined) throw new Error('d1mem: undefined bound (D1 rejects it)');
      return x;
    };
    const match = (t: Table, conds: Cond[]) => (r: Row): boolean =>
      conds.every((c) => {
        if (!t.cols.includes(c.col)) throw new Error(`d1mem: no column ${c.col}`);
        const a = r[c.col];
        if (c.op === 'null') return a == null;
        if (c.op === 'notnull') return a != null;
        if (a == null) return false;
        if (c.op === 'in') return c.vals.map(val).includes(a);
        if (c.op === 'insel') {
          const st = this.table(c.sub!.table);
          if (!st.cols.includes(c.sub!.col)) throw new Error(`d1mem: no column ${c.sub!.col}`);
          return st.rows.filter(match(st, c.sub!.where)).some((r) => r[c.sub!.col] === a);
        }
        const b = val(c.vals[0]);
        if (b == null) return false;
        const x = a as number;
        const y = b as number;
        return c.op === '=' ? a === b : c.op === '!=' ? a !== b : c.op === '<' ? x < y : c.op === '>' ? x > y : c.op === '<=' ? x <= y : x >= y;
      });
    const check = (t: Table, row: Row, others: Row[]): string | null => {
      for (const c of t.notNull) if (row[c] == null) return `NOT NULL constraint failed: ${c}`;
      for (const u of t.unique) {
        if (u.some((c) => row[c] == null)) continue;
        if (others.some((o) => u.every((c) => o[c] === row[c]))) return `UNIQUE constraint failed: ${u.join(', ')}`;
      }
      return null;
    };

    let m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY (\w+)(?: (ASC|DESC))?)?(?: LIMIT (\d+))?$/i.exec(s);
    if (m) {
      const t = this.table(m[2]);
      const cols = m[1] === '*' ? t.cols : m[1].split(',').map((c) => c.trim());
      for (const c of cols) if (!t.cols.includes(c)) throw new Error(`d1mem: no column ${c}`);
      let rows = t.rows.filter(match(t, parseWhere(m[3])));
      if (m[4]) {
        const k = m[4];
        const dir = (m[5] ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
        rows = [...rows].sort((a, b) => ((a[k] as number) < (b[k] as number) ? -dir : (a[k] as number) > (b[k] as number) ? dir : 0));
      }
      if (m[6]) rows = rows.slice(0, Number(m[6]));
      return { rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))), changes: 0 };
    }
    const insert = (t: Table, cols: string[], vals: unknown[], orIgnore: boolean): number => {
      const row: Row = Object.fromEntries(t.cols.map((c) => [c, null]));
      cols.forEach((c, i) => {
        if (!t.cols.includes(c)) throw new Error(`d1mem: no column ${c}`);
        row[c] = vals[i];
      });
      const bad = check(t, row, t.rows);
      if (bad) {
        if (orIgnore) return 0;
        throw new Error(bad);
      }
      t.rows.push(row);
      return 1;
    };
    // The rate-limit upsert: SET expressions see the existing row (unqualified) and the new one (excluded.*), all at once.
    m = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\) ON CONFLICT \((\w+)\) DO UPDATE SET (.+?) RETURNING (\w+)$/i.exec(s);
    if (m) {
      const t = this.table(m[1]);
      const cols = m[2].split(',').map((c) => c.trim());
      const vals = m[3].split(',').map((v) => val(lit(v.trim())));
      const fresh: Row = Object.fromEntries(t.cols.map((c) => [c, null]));
      cols.forEach((c, i) => {
        if (!t.cols.includes(c)) throw new Error(`d1mem: no column ${c}`);
        fresh[c] = vals[i];
      });
      const key = m[4];
      if (!t.unique.some((u) => u.length === 1 && u[0] === key)) throw new Error(`d1mem: no unique key on ${key}`);
      const ret = m[6];
      if (!t.cols.includes(ret)) throw new Error(`d1mem: no column ${ret}`);
      const old = t.rows.find((r) => r[key] === fresh[key]);
      if (!old) {
        insert(t, cols, vals, false);
        return { rows: [{ [ret]: fresh[ret] }], changes: 1 };
      }
      const expr = (e: string): unknown => {
        const x = e.trim();
        const c = /^CASE WHEN (\S+) = (\S+) THEN (.+?) ELSE (.+?) END$/i.exec(x);
        if (c) return expr(c[1]) === expr(c[2]) ? expr(c[3]) : expr(c[4]);
        const plus = /^(\S+) \+ (\S+)$/.exec(x);
        if (plus) return (expr(plus[1]) as number) + (expr(plus[2]) as number);
        const ex = /^excluded\.(\w+)$/i.exec(x);
        if (ex && t.cols.includes(ex[1])) return fresh[ex[1]];
        if (/^\w+$/.test(x) && t.cols.includes(x)) return old[x];
        return val(lit(x));
      };
      const next = { ...old };
      for (const a of splitTop(m[5])) {
        const x = /^(\w+) = (.+)$/.exec(a);
        if (!x || !t.cols.includes(x[1])) throw new Error(`d1mem: unsupported SET ${a}`);
        next[x[1]] = expr(x[2]);
      }
      const bad = check(t, next, t.rows.filter((o) => o !== old));
      if (bad) throw new Error(bad);
      Object.assign(old, next);
      return { rows: [{ [ret]: old[ret] }], changes: 1 };
    }
    m = /^INSERT (OR IGNORE )?INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i.exec(s);
    if (m) {
      const vals = m[4].split(',').map((v) => val(lit(v.trim())));
      return { rows: [], changes: insert(this.table(m[2]), m[3].split(',').map((c) => c.trim()), vals, !!m[1]) };
    }
    // INSERT … SELECT from one table: each selected item a column of it or a literal (scripts/grant-gift.mjs).
    m = /^INSERT (OR IGNORE )?INTO (\w+) \(([^)]+)\) SELECT (.+?) FROM (\w+)(?: WHERE (.+))?$/i.exec(s);
    if (m) {
      const t = this.table(m[2]);
      const src = this.table(m[5]);
      const items = m[4].split(',').map((x) => x.trim());
      let changes = 0;
      for (const r of src.rows.filter(match(src, parseWhere(m[6])))) {
        const vals = items.map((x) => (/^\w+$/.test(x) && src.cols.includes(x) ? r[x] : val(lit(x))));
        changes += insert(t, m[3].split(',').map((c) => c.trim()), vals, !!m[1]);
      }
      return { rows: [], changes };
    }
    m = /^UPDATE (\w+) SET (.+?) WHERE (.+)$/i.exec(s);
    if (m) {
      const t = this.table(m[1]);
      const sets = splitTop(m[2]).map((a) => {
        const x = /^(\w+) = (\S+)$/.exec(a);
        if (!x || !t.cols.includes(x[1])) throw new Error(`d1mem: unsupported SET ${a}`);
        return { col: x[1], v: lit(x[2]) };
      });
      const hit = t.rows.filter(match(t, parseWhere(m[3])));
      for (const r of hit) {
        const next = { ...r };
        for (const st of sets) next[st.col] = val(st.v);
        const bad = check(t, next, t.rows.filter((o) => o !== r));
        if (bad) throw new Error(bad);
        Object.assign(r, next);
      }
      return { rows: [], changes: hit.length };
    }
    m = /^DELETE FROM (\w+) WHERE (.+)$/i.exec(s);
    if (m) {
      const t = this.table(m[1]);
      const keep = t.rows.filter((r) => !match(t, parseWhere(m![2]))(r));
      const changes = t.rows.length - keep.length;
      t.rows = keep;
      return { rows: [], changes };
    }
    throw new Error(`d1mem: unsupported statement ${sql}`);
  }
}
