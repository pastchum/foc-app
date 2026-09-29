import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger, PgDb, PinoLoggerService, runMigrations, startService } from '@foc/platform';
import { DB, type Database } from './db/db.js';
import { migrations } from './db/migrations.js';
import { seedAdmins } from './admin/seed.js';

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

  const seeded = await seedAdmins(app.get<Database>(DB), {
    emails: env.ADMIN_SEED_EMAILS,
    password: env.ADMIN_SEED_PASSWORD,
    allowedDomains: env.ALLOWED_EMAIL_DOMAINS,
  });
  if (seeded.created.length > 0) logger.log(`Seeded administrators: ${seeded.created.join(', ')}`);
  if (seeded.skipped.length > 0) {
    logger.warn(
      `Seed skipped (account already exists, not promoted): ${seeded.skipped.join(', ')}`,
    );
  }
  if (!env.ADMIN_SEED_EMAILS?.length) logger.warn('No seeded administrators configured.');

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
