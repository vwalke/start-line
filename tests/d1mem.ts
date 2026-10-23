/**
 * An in-memory stand-in for a Workers D1 database, for the paywall tests. It loads the tables of
 * migrations/0001_paywall.sql (columns, NOT NULL, PRIMARY KEY and UNIQUE, single or composite) and
 * runs the small SQL subset functions/_authDb.ts keeps to: single-table SELECT / INSERT [OR IGNORE]
 * / UPDATE / DELETE, WHERE of ANDed comparisons (= != < > <= >=), IS [NOT] NULL and IN (…), one
 * ORDER BY column, LIMIT. Anything else throws, so a query outside the subset fails loudly here.
 */
import { readFileSync } from 'node:fs';
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
type Cond = { col: string; op: string; vals: Val[] };

const lit = (tok: string): Val => {
  const p = /^\$(\d+)$/.exec(tok);
  if (p) return { p: Number(p[1]) };
  if (/^'.*'$/.test(tok)) return { lit: tok.slice(1, -1) };
  if (/^-?\d+(\.\d+)?$/.test(tok)) return { lit: Number(tok) };
  throw new Error(`d1mem: unsupported value ${tok}`);
};

function parseWhere(w: string | undefined): Cond[] {
  if (!w) return [];
  return w.split(/\s+AND\s+/i).map((term) => {
    let m = /^(\w+) IS (NOT )?NULL$/i.exec(term.trim());
    if (m) return { col: m[1], op: m[2] ? 'notnull' : 'null', vals: [] };
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

  constructor(schemaSql = readFileSync(MIGRATION, 'utf8')) {
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
    m = /^INSERT (OR IGNORE )?INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i.exec(s);
    if (m) {
      const t = this.table(m[2]);
      const cols = m[3].split(',').map((c) => c.trim());
      const vals = m[4].split(',').map((v) => val(lit(v.trim())));
      const row: Row = Object.fromEntries(t.cols.map((c) => [c, null]));
      cols.forEach((c, i) => {
        if (!t.cols.includes(c)) throw new Error(`d1mem: no column ${c}`);
        row[c] = vals[i];
      });
      const bad = check(t, row, t.rows);
      if (bad) {
        if (m[1]) return { rows: [], changes: 0 };
        throw new Error(bad);
      }
      t.rows.push(row);
      return { rows: [], changes: 1 };
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
