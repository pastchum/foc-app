import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration for the User Service. Drives `db:generate` (diff the
 * schema into SQL), `db:studio` and `db:push` for local work against
 * `src/db/schema.ts`.
 *
 * Note: the authoritative migrations applied at boot live in
 * `src/db/migrations.ts` (forward-only TypeScript strings). They also carry the
 * `audit_records` append-only trigger, its plpgsql function and a `REVOKE` that
 * the Drizzle schema DSL cannot express, so they remain the source of truth for
 * what is applied; this schema stays in lockstep for the query builder and
 * tooling.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/postgres' },
});
