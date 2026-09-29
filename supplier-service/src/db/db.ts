import type { DrizzleDatabase } from '@foc/platform';
import type * as schema from './schema.js';

/**
 * The Drizzle handle the service codes against. `Database` covers both the
 * top-level instance (over `pg` in production, PGlite in tests) and a
 * transaction handle, so a repository function can run standalone or inside
 * `db.transaction(...)`. Raw multi-statement migrations still use the `Db` port
 * from `@foc/platform`; everything else is Drizzle.
 */
export type Database = DrizzleDatabase<typeof schema>;

/**
 * Nest DI token for the {@link Database}. Kept in the service layer (a Nest
 * concern, not shared runtime): the service binds it to a `pg`-backed Drizzle
 * instance in production and overrides it with a PGlite-backed one in tests.
 */
export const DB = Symbol('DB');
