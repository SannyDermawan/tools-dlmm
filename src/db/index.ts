import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA synchronous = NORMAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    // Several processes share the file (live session, replay, dashboard): wait for the write lock
    // instead of failing. Long jobs release the lock regularly (see beginBatch / yieldBatch).
    this.raw.exec("PRAGMA busy_timeout = 60000;");
  }

  prepare(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.prepare(sql).run(...params);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  private depth = 0;
  private batchStarted = 0;

  /**
   * Batch mode for long jobs (replay, re-scoring): one transaction that is committed and reopened
   * by yieldBatch() every `maxMs`, so other processes never wait long for the write lock.
   */
  beginBatch() {
    if (this.depth > 0) return;
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    this.batchStarted = Date.now();
  }

  yieldBatch(maxMs = 250) {
    if (this.depth !== 1 || Date.now() - this.batchStarted < maxMs) return;
    this.raw.exec("COMMIT");
    this.raw.exec("BEGIN IMMEDIATE");
    this.batchStarted = Date.now();
  }

  endBatch() {
    if (this.depth !== 1) return;
    this.raw.exec("COMMIT");
    this.depth = 0;
  }

  /** Transaction; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  /** INSERT (OR IGNORE/REPLACE) many rows with the same column set, in one transaction. */
  insertMany(table: string, rows: Row[], mode: "" | "OR IGNORE" | "OR REPLACE" = ""): number {
    if (rows.length === 0) return 0;
    const cols = Object.keys(rows[0]);
    const sql = `INSERT ${mode} INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
    const stmt = this.prepare(sql);
    let n = 0;
    this.tx(() => {
      for (const r of rows) n += Number(stmt.run(...cols.map((c) => r[c] ?? null)).changes);
    });
    return n;
  }

  insert(table: string, row: Row, mode: "" | "OR IGNORE" | "OR REPLACE" = ""): void {
    const cols = Object.keys(row);
    this.run(
      `INSERT ${mode} INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      ...cols.map((c) => row[c] ?? null),
    );
  }

  close() {
    this.raw.close();
  }
}

export interface MigrationResult {
  applied: string[];
  current: string[];
}

export function migrate(db: Db, dir = MIGRATIONS_DIR): MigrationResult {
  db.raw.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const done = new Set(db.all<{ version: string }>("SELECT version FROM schema_migrations").map((r) => r.version));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    if (done.has(version)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    db.tx(() => {
      db.raw.exec(sql);
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", version, Date.now());
    });
    applied.push(version);
  }
  return { applied, current: files.map((f) => f.replace(/\.sql$/, "")) };
}

export function openDb(path: string): Db {
  const db = new Db(path);
  migrate(db);
  return db;
}
