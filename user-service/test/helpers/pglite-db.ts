import { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable, Row } from '@foc/platform';

/**
 * The raw {@link Db} port over PGlite (PostgreSQL compiled to WASM), so the
 * suite exercises actual constraints, unique indexes and transactions without a
 * database server or Docker. Used for two things: running the real migrations
 * (multi-statement DDL) and letting tests assert on stored rows directly. The
 * service's own queries run through a Drizzle instance built over the same
 * {@link client} — see the test app helper.
 */
export class PgliteDb implements Db {
  private constructor(readonly client: PGlite) {}

  static async create(): Promise<PgliteDb> {
    return new PgliteDb(await PGlite.create());
  }

  async query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const res = await this.client.query<T>(sql, params);
    return { rows: res.rows };
  }

  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.client.transaction(async (t) =>
      fn({
        query: async <R extends Row = Row>(sql: string, params?: unknown[]) => {
          const res = await t.query<R>(sql, params);
          return { rows: res.rows };
        },
        exec: async (sql) => {
          await t.exec(sql);
        },
      }),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
