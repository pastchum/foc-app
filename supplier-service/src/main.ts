import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger, PgDb, PinoLoggerService, runMigrations, startService } from '@foc/platform';
import { DB, type Database } from './db/db.js';
import { migrations } from './db/migrations.js';
import { loadSeedSuppliers } from './admin/seed-data.js';
import { seedSuppliers } from './admin/seed.js';

async function main(): Promise<void> {
  // Imported dynamically so a configuration error surfaces as the clean message
  // below, rather than as an uncaught exception during module resolution.
  const { env, SERVICE_NAME } = await import('./config.js');
  const { AppModule } = await import('./app.module.js');

  const logger = new PinoLoggerService(createLogger(SERVICE_NAME, env.LOG_LEVEL));
  const app = await NestFactory.create(AppModule, { logger });

  // Schema first, then traffic: a request must never reach a database that is
  // behind. Migrations are multi-statement DDL, which needs the raw `pg` port
  // (Drizzle's query path runs one statement per call); the pool is closed once
  // they are applied. Application queries go through the Drizzle DB provider.
  const migrator = new PgDb(env.DATABASE_URL);
  const applied = await runMigrations(migrator, migrations);
  await migrator.close();
  if (applied.length > 0) logger.log(`Applied migrations: ${applied.join(', ')}`);

  // Idempotent: safe to run on every boot, never overwrites an admin's edits.
  const suppliers = await loadSeedSuppliers();
  const seeded = await seedSuppliers(app.get<Database>(DB), suppliers);
  logger.log(
    `Supplier seed: ${seeded.created.length} created, ${seeded.skipped.length} already present.`,
  );

  await startService(app, {
    serviceName: SERVICE_NAME,
    port: env.PORT,
    corsOrigins: env.CORS_ORIGINS,
  });
}

main().catch((err: unknown) => {
  // Configuration errors happen before a logger exists, so this must use console.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
