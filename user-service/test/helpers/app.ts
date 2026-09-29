import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/pglite';
import type { DestinationStream } from 'pino';
import { ErrorEnvelopeFilter, PlatformModule, runMigrations, type Db } from '@foc/platform';
import { RATE_LIMITERS, RateLimiter, type AuthRateLimiters } from '../../src/auth/rate-limiter.js';
import { DB, type Database } from '../../src/db/db.js';
import * as schema from '../../src/db/schema.js';
import { migrations } from '../../src/db/migrations.js';
import { DevMailbox } from '../../src/mail/dev-mailbox.js';
import { UsersModule } from '../../src/users/users.module.js';
import { PgliteDb } from './pglite-db.js';

export const SERVICE_KEY = 'test-internal-key-0123456789';

export interface TestApp {
  app: INestApplication;
  /** Raw port over PGlite — for direct SQL assertions and truncation. */
  db: Db;
  /** The Drizzle handle the service queries through — for tests that drive a repository or seed directly. */
  orm: Database;
  mailbox: DevMailbox;
  close(): Promise<void>;
}

/** Boots the real modules against an in-memory PostgreSQL with migrations applied. */
export async function createTestApp(
  options: {
    logLevel?: string;
    logDestination?: DestinationStream;
    rateLimiters?: AuthRateLimiters;
  } = {},
): Promise<TestApp> {
  // Raw port: runs the migrations and backs `t.db` for direct row assertions.
  const db = await PgliteDb.create();
  await runMigrations(db, migrations);
  // What the service actually queries through — Drizzle over the same PGlite.
  const drizzleDb = drizzle(db.client, { schema });

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot({
        serviceName: 'user-service',
        version: 'test',
        logLevel: options.logLevel ?? 'silent',
        logDestination: options.logDestination,
      }),
      UsersModule.forRoot(),
    ],
  })
    .overrideProvider(DB)
    .useValue(drizzleDb)
    // Generous by default: the suite shares one client IP and registers far more than a person would.
    .overrideProvider(RATE_LIMITERS)
    .useValue(options.rateLimiters ?? openLimiters())
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  // Listen once so concurrent supertest requests share one server instead of racing to start it.
  await app.listen(0);

  return {
    app,
    db,
    orm: drizzleDb,
    mailbox: app.get(DevMailbox),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export const validRegistration = (email = 'e0123456@u.nus.edu') => ({
  email,
  password: 'correct-horse-battery-staple',
  displayName: 'Alex Tan',
});

export const openLimiters = (): AuthRateLimiters => ({
  loginPerEmail: new RateLimiter(1_000_000, 60_000),
  loginPerIp: new RateLimiter(1_000_000, 60_000),
  registerPerIp: new RateLimiter(1_000_000, 60_000),
});
