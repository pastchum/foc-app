import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Database } from '../db/db.js';
import { activationTokens, outboxEvents, profiles, userRoles, users } from '../db/schema.js';

export type AccountStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED';
export type Role = 'STUDENT' | 'ADMIN';

export interface NewUser {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
}

export interface IdentityRow {
  status: AccountStatus;
  roles: Role[];
  displayName: string;
}

/** Postgres error code for a unique-constraint violation, shared by `pg` and PGlite. */
const UNIQUE_VIOLATION = '23505';

/** The unique index behind the case-insensitive email rule (`users (lower(email))`). */
export const EMAIL_UNIQUE_INDEX = 'users_email_lower_key';

/**
 * True when `err` is a unique-constraint violation (optionally on a named
 * constraint). Drizzle wraps the driver error, carrying `code`/`constraint` on
 * `.cause`; check both so it is recognised either way. Targeting the email index
 * lets a genuine primary-key collision surface instead of being mistaken for a
 * duplicate email.
 */
export const isUniqueViolation = (err: unknown, constraint?: string): boolean => {
  const driver = (err as { cause?: unknown })?.cause ?? err;
  const e = driver as { code?: string; constraint?: string } | null;
  if (!e || e.code !== UNIQUE_VIOLATION) return false;
  return constraint ? e.constraint === constraint : true;
};

/** A user's roles as a sorted array, correlated to the outer `users` row. */
const rolesOf = sql<
  Role[]
>`array(SELECT r.role FROM user_roles r WHERE r.user_id = ${users.id} ORDER BY r.role)`;

/** Profile columns a self-service update may set, in a fixed camelCase list. */
const PROFILE_KEYS = [
  'displayName',
  'faculty',
  'avatarRef',
  'contactPreference',
  'preferredMode',
] as const;

/**
 * All SQL for the identity tables, expressed through Drizzle. Every function
 * takes a {@link Database} — the top-level instance or a transaction handle — so
 * the service can run several of them in one transaction.
 */
export const usersRepository = {
  /** Inserts the user, or returns false if the email is taken (unique index, race-safe). */
  async insertUser(db: Database, user: NewUser): Promise<boolean> {
    // Only a duplicate email is a "false" — any other violation (e.g. a
    // primary-key collision) must surface, so target the email index rather than
    // swallowing every conflict.
    try {
      await db.insert(users).values({
        id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
        status: 'PENDING_ACTIVATION',
      });
    } catch (err) {
      if (isUniqueViolation(err, EMAIL_UNIQUE_INDEX)) return false;
      throw err;
    }
    await db.insert(userRoles).values({ userId: user.id, role: 'STUDENT' });
    await db.insert(profiles).values({ userId: user.id, displayName: user.displayName });
    return true;
  },

  async insertActivationToken(
    db: Database,
    t: { id: string; userId: string; tokenHash: string; ttlHours: number },
  ): Promise<void> {
    await db.insert(activationTokens).values({
      id: t.id,
      userId: t.userId,
      tokenHash: t.tokenHash,
      expiresAt: sql`now() + make_interval(hours => ${t.ttlHours})`,
    });
  },

  /**
   * Atomically claims a live token. The conditional UPDATE is the single-use
   * guarantee: two concurrent callers cannot both get a row back.
   */
  async consumeActivationToken(db: Database, tokenHash: string): Promise<string | null> {
    const rows = await db
      .update(activationTokens)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(activationTokens.tokenHash, tokenHash),
          isNull(activationTokens.consumedAt),
          gt(activationTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({ userId: activationTokens.userId });
    return rows[0]?.userId ?? null;
  },

  async findActivationToken(
    db: Database,
    tokenHash: string,
  ): Promise<{ userId: string; consumed: boolean } | null> {
    const rows = await db
      .select({ userId: activationTokens.userId, consumedAt: activationTokens.consumedAt })
      .from(activationTokens)
      .where(eq(activationTokens.tokenHash, tokenHash));
    const row = rows[0];
    return row ? { userId: row.userId, consumed: row.consumedAt !== null } : null;
  },

  /** Flips PENDING_ACTIVATION → ACTIVE once. Returns false if the account was not pending. */
  async markActivated(db: Database, userId: string): Promise<boolean> {
    const rows = await db
      .update(users)
      .set({ status: 'ACTIVE', activatedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(users.id, userId), eq(users.status, 'PENDING_ACTIVATION')))
      .returning({ id: users.id });
    return rows.length > 0;
  },

  async isActivated(db: Database, userId: string): Promise<boolean> {
    const rows = await db
      .select({ one: sql`1` })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.status, 'ACTIVE'),
          sql`${users.activatedAt} IS NOT NULL`,
        ),
      );
    return rows.length > 0;
  },

  async insertOutboxEvent(
    db: Database,
    e: {
      id: string;
      eventType: string;
      aggregateId: string;
      payload: unknown;
      correlationId: string;
    },
  ): Promise<void> {
    await db.insert(outboxEvents).values({
      id: e.id,
      eventType: e.eventType,
      aggregateId: e.aggregateId,
      payload: e.payload,
      correlationId: e.correlationId,
    });
  },

  /** Login lookup. The only place a password hash is read, and it never leaves the auth service. */
  async findCredentials(
    db: Database,
    normalizedEmail: string,
  ): Promise<{
    id: string;
    passwordHash: string;
    status: AccountStatus;
    displayName: string;
    roles: Role[];
  } | null> {
    const rows = await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        status: users.status,
        displayName: sql<string>`coalesce(${profiles.displayName}, '')`,
        roles: rolesOf,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(sql`lower(${users.email}) = lower(${normalizedEmail})`);
    return rows[0] ?? null;
  },

  /** The caller's own account for `GET /users/me`. */
  async findMe(db: Database, userId: string) {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        createdAt: users.createdAt,
        displayName: profiles.displayName,
        faculty: profiles.faculty,
        avatarRef: profiles.avatarRef,
        contactPreference: profiles.contactPreference,
        preferredMode: profiles.preferredMode,
        roles: rolesOf,
      })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, userId));
    return rows[0] ?? null;
  },

  /** Applies only the fields present. Column names come from a fixed map, never from input. */
  async updateProfile(
    db: Database,
    userId: string,
    changes: Partial<{
      displayName: string;
      faculty: string | null;
      avatarRef: string | null;
      contactPreference: string;
      preferredMode: string;
    }>,
  ): Promise<void> {
    const set: PgUpdateSetSource<typeof profiles> = {};
    for (const key of PROFILE_KEYS) {
      if (changes[key] !== undefined) (set as Record<string, unknown>)[key] = changes[key];
    }
    if (Object.keys(set).length === 0) return;
    await db.update(profiles).set(set).where(eq(profiles.userId, userId));
  },

  /** Deliberately selects only what the least-data lookup may return — never a hash or token. */
  async findIdentity(db: Database, userId: string): Promise<IdentityRow | null> {
    const rows = await db
      .select({
        status: users.status,
        displayName: sql<string>`coalesce(${profiles.displayName}, '')`,
        roles: rolesOf,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, userId));
    const row = rows[0];
    return row ? { status: row.status, roles: row.roles, displayName: row.displayName } : null;
  },
};
