import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/db.js';
import { refreshSessions, users } from '../db/schema.js';
import type { AccountStatus } from '../users/users.repository.js';

export interface LockedSession {
  id: string;
  familyId: string;
  userId: string;
  expired: boolean;
  rotated: boolean;
  revoked: boolean;
  userStatus: AccountStatus;
}

/** All SQL for refresh sessions. Every function takes a {@link Database} so callers control the transaction. */
export const sessionsRepository = {
  async insert(
    db: Database,
    s: { id: string; familyId: string; userId: string; tokenHash: string; ttlDays: number },
  ): Promise<void> {
    await db.insert(refreshSessions).values({
      id: s.id,
      familyId: s.familyId,
      userId: s.userId,
      tokenHash: s.tokenHash,
      expiresAt: sql`now() + make_interval(days => ${s.ttlDays})`,
    });
  },

  /**
   * Reads a session by token hash and locks its row for the transaction, so two
   * simultaneous refreshes with the same token are serialised: the second sees
   * the first's rotation and is treated as reuse.
   */
  async lockByHash(db: Database, tokenHash: string): Promise<LockedSession | null> {
    const rows = await db
      .select({
        id: refreshSessions.id,
        familyId: refreshSessions.familyId,
        userId: refreshSessions.userId,
        expired: sql<boolean>`${refreshSessions.expiresAt} <= now()`,
        rotated: sql<boolean>`${refreshSessions.rotatedAt} IS NOT NULL`,
        revoked: sql<boolean>`${refreshSessions.revokedAt} IS NOT NULL`,
        status: users.status,
      })
      .from(refreshSessions)
      .innerJoin(users, eq(users.id, refreshSessions.userId))
      .where(eq(refreshSessions.tokenHash, tokenHash))
      .for('update', { of: refreshSessions });
    const r = rows[0];
    return r
      ? {
          id: r.id,
          familyId: r.familyId,
          userId: r.userId,
          expired: r.expired,
          rotated: r.rotated,
          revoked: r.revoked,
          userStatus: r.status,
        }
      : null;
  },

  async markRotated(db: Database, id: string): Promise<void> {
    await db
      .update(refreshSessions)
      .set({ rotatedAt: sql`now()` })
      .where(eq(refreshSessions.id, id));
  },

  async revokeFamily(db: Database, familyId: string): Promise<void> {
    await db
      .update(refreshSessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshSessions.familyId, familyId), isNull(refreshSessions.revokedAt)));
  },

  /** Revokes the whole family the given token belongs to. Idempotent; unknown tokens do nothing. */
  async revokeFamilyByTokenHash(db: Database, tokenHash: string): Promise<void> {
    await db
      .update(refreshSessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          isNull(refreshSessions.revokedAt),
          eq(
            refreshSessions.familyId,
            sql`(SELECT family_id FROM refresh_sessions WHERE token_hash = ${tokenHash})`,
          ),
        ),
      );
  },

  /** Used when an account is suspended: every session it owns dies at once. */
  async revokeAllForUser(db: Database, userId: string): Promise<void> {
    await db
      .update(refreshSessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)));
  },

  /** For the access-token guard: is this session still usable, and what state is its account in? */
  async liveness(
    db: Database,
    sessionId: string,
    userId: string,
  ): Promise<{ live: boolean; status: AccountStatus } | null> {
    const rows = await db
      .select({
        live: sql<boolean>`(${refreshSessions.revokedAt} IS NULL AND ${refreshSessions.expiresAt} > now())`,
        status: users.status,
      })
      .from(refreshSessions)
      .innerJoin(users, eq(users.id, refreshSessions.userId))
      .where(and(eq(refreshSessions.id, sessionId), eq(refreshSessions.userId, userId)));
    return rows[0] ?? null;
  },
};
