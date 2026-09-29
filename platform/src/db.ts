import pg from 'pg';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/**
 * The Drizzle handle a service's repositories code against. It is deliberately
 * widened over {@link PgQueryResultHKT} (rather than a driver-specific result
 * type) so that *both* the top-level database and a transaction handle — over
 * `pg` in production or PGlite in tests — satisfy it. A repository function
 * typed to this can therefore run standalone or inside `db.transaction(...)`
 * against either driver.
 */
export type DrizzleDatabase<TSchema extends Record<string, unknown> = Record<string, never>> =
  PgDatabase<PgQueryResultHKT, TSchema, ExtractTablesWithRelations<TSchema>>;

/**
 * A `pg` connection pool with the idle-error listener attached (see {@link PgDb}
 * for why). Shared so the same pool is used whether a caller wants the raw
 * {@link Db} port (migrations) or a Drizzle instance built over it (queries).
 */
export function createPgPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });

  // node-postgres emits 'error' on the pool when an *idle* client's connection
  // drops out from under us (Postgres restart, network blip). That event fires
  // outside any query's promise, so with no listener it is an unhandled
  // EventEmitter error and Node exits the whole process. Log and swallow it:
  // the broken client is discarded automatically, and the next query
  // transparently opens a fresh connection. This runs with no request context
  // and no logger injected, so — like the pre-logger startup path in main.ts —
  // console is the available sink.
  pool.on('error', (err) => {
    console.error(
      `Idle Postgres client error (connection dropped, will reconnect): ${err.message}`,
    );
  });
  return pool;
}

/**
 * The narrow database port used for migrations (multi-statement DDL, which the
 * extended-protocol query path Drizzle uses cannot run) and, in tests, for raw
 * assertions. Production uses `pg` (see {@link PgDb}); tests run the same SQL on
 * PGlite, which is real PostgreSQL compiled to WASM, so no server is needed to
 * run the suite. Application queries go through Drizzle, not this port.
 */
export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs several statements with no parameters (used by migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Runs `fn` in one transaction: commits if it resolves, rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** PostgreSQL implementation of {@link Db}. The pool connects lazily, on first query. */
export class PgDb implements Db {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPgPool(connectionString);
  }

  async query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Queryable = {
      query: async <R extends Row = Row>(sql: string, params?: unknown[]) => {
        const res = await client.query(sql, params);
        return { rows: res.rows as R[] };
      },
      exec: async (sql) => {
        await client.query(sql);
      },
    };
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * One forward-only migration. Kept as a TypeScript string rather than a .sql
 * file so `tsc` carries it into `dist/` with no copy step. The actual list of
 * migrations is service-specific (each service owns its schema); pass it to
 * {@link runMigrations}.
 */
export interface Migration {
  id: string;
  sql: string;
}

/**
 * Applies every migration in `list` not yet recorded, in order, each in its own
 * transaction. Returns the ids applied. Forward-only: there is no down step.
 */
export async function runMigrations(db: Db, list: Migration[]): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
  const done = new Set(rows.map((r) => r.id));
  const applied: string[] = [];

  for (const migration of list) {
    if (done.has(migration.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
    });
    applied.push(migration.id);
  }
  return applied;
}
