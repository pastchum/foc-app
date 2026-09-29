import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration for the Supplier Service. Drives `db:generate`
 * (diff the schema into SQL), `db:studio` and `db:push` for local work against
 * `src/db/schema.ts`.
 *
 * Note: the authoritative migrations applied at boot live in
 * `src/db/migrations.ts` (forward-only TypeScript strings). This schema is kept
 * in lockstep with them and is the single source of truth for the Drizzle query
 * builder and drizzle-kit tooling.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/postgres' },
});
