import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/db.js';
import { auditRecords, profiles, userRoles, users } from '../db/schema.js';
import {
  EMAIL_UNIQUE_INDEX,
  isUniqueViolation,
  type AccountStatus,
  type Role,
} from '../users/users.repository.js';

export type AuditAction = 'SUSPEND' | 'REACTIVATE' | 'ROLE_GRANT' | 'ROLE_REVOKE';

export interface LockedUser {
  id: string;
  status: AccountStatus;
  isSeededAdmin: boolean;
  roles: Role[];
}

/** A user's roles as a sorted array, correlated to the outer `users` row. */
const rolesOf = sql<
  Role[]
>`array(SELECT r.role FROM user_roles r WHERE r.user_id = ${users.id} ORDER BY r.role)`;

/** Escapes LIKE wildcards so a search for `50%` matches the text, not everything. */
const likePrefix = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`).toLowerCase() + '%';

/**
 * The projection every admin read of a user shares — never a password hash.
 * `coalesce`s cover the LEFT JOIN missing a profile row.
 */
const adminUserColumns = {
  id: users.id,
  email: users.email,
  status: users.status,
  isSeededAdmin: users.isSeededAdmin,
  createdAt: users.createdAt,
  activatedAt: users.activatedAt,
  displayName: sql<string>`coalesce(${profiles.displayName}, '')`,
  faculty: profiles.faculty,
  avatarRef: profiles.avatarRef,
  contactPreference: sql<string>`coalesce(${profiles.contactPreference}, 'IN_APP')`,
  preferredMode: sql<string>`coalesce(${profiles.preferredMode}, 'REQUESTER')`,
  roles: rolesOf,
};

/** SQL for administration. Every function takes a {@link Database} so a whole action shares one transaction. */
export const adminRepository = {
  /**
   * Locks every ADMIN role row. Taken first by anything that could reduce the
   * number of administrators, so two simultaneous demotions are serialised and
   * cannot both pass the "at least one admin" check.
   */
  async lockAdminIds(db: Database): Promise<string[]> {
    const rows = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.role, 'ADMIN'))
      .orderBy(userRoles.userId)
      .for('update');
    return rows.map((r) => r.userId);
  },

  async lockUser(db: Database, userId: string): Promise<LockedUser | null> {
    const rows = await db
      .select({
        id: users.id,
        status: users.status,
        isSeededAdmin: users.isSeededAdmin,
        roles: rolesOf,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    return rows[0] ?? null;
  },

  async isSeededAdmin(db: Database, userId: string): Promise<boolean> {
    const rows = await db
      .select({ isSeededAdmin: users.isSeededAdmin })
      .from(users)
      .where(eq(users.id, userId));
    return rows[0]?.isSeededAdmin === true;
  },

  async setStatus(db: Database, userId: string, status: AccountStatus): Promise<void> {
    await db
      .update(users)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(users.id, userId));
  },

  async grantAdmin(db: Database, userId: string, grantedBy: string): Promise<void> {
    await db
      .insert(userRoles)
      .values({ userId, role: 'ADMIN', grantedBy })
      .onConflictDoNothing({ target: [userRoles.userId, userRoles.role] });
  },

  async revokeAdmin(db: Database, userId: string): Promise<void> {
    await db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.role, 'ADMIN')));
  },

  async insertAudit(
    db: Database,
    a: {
      id: string;
      actorId: string;
      targetUserId: string;
      action: AuditAction;
      reason: string;
      correlationId: string;
    },
  ): Promise<void> {
    await db.insert(auditRecords).values({
      id: a.id,
      actorId: a.actorId,
      targetUserId: a.targetUserId,
      action: a.action,
      reason: a.reason,
      correlationId: a.correlationId,
    });
  },

  /** Ordinary users are never returned with a hash; this view is the only place an admin reads an account. */
  async findAdminUser(db: Database, userId: string): Promise<AdminUserRow | null> {
    const rows = await db
      .select(adminUserColumns)
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, userId));
    return rows[0] ?? null;
  },

  async listUsers(
    db: Database,
    f: { page: number; pageSize: number; status?: string; role?: string; q?: string },
  ): Promise<{ rows: AdminUserRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (f.status) conditions.push(eq(users.status, f.status as AccountStatus));
    if (f.role) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = ${users.id} AND r.role = ${f.role})`,
      );
    }
    if (f.q) {
      const like = likePrefix(f.q);
      conditions.push(
        sql`(lower(${users.email}) LIKE ${like} ESCAPE '\' OR lower(${profiles.displayName}) LIKE ${like} ESCAPE '\')`,
      );
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const totalRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(where);
    const rows = await db
      .select(adminUserColumns)
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(where)
      .orderBy(users.createdAt, users.id)
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    return { rows, total: totalRows[0]?.n ?? 0 };
  },

  async listAudit(
    db: Database,
    f: { page: number; pageSize: number; targetUserId?: string },
  ): Promise<{ rows: AuditRow[]; total: number }> {
    const where = f.targetUserId ? eq(auditRecords.targetUserId, f.targetUserId) : undefined;

    const totalRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditRecords)
      .where(where);
    const rows = await db
      .select({
        id: auditRecords.id,
        actorId: auditRecords.actorId,
        targetUserId: auditRecords.targetUserId,
        action: auditRecords.action,
        reason: auditRecords.reason,
        occurredAt: auditRecords.occurredAt,
        correlationId: auditRecords.correlationId,
      })
      .from(auditRecords)
      .where(where)
      .orderBy(sql`${auditRecords.occurredAt} DESC`, auditRecords.id)
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    return { rows, total: totalRows[0]?.n ?? 0 };
  },

  /** Boot-time bootstrap. Returns false if the address already has an account (never escalated). */
  async insertSeededAdmin(
    db: Database,
    u: { id: string; email: string; passwordHash: string; displayName: string },
  ): Promise<boolean> {
    // An address that already has an account is skipped, never escalated; any
    // other violation must surface (see insertUser).
    try {
      await db.insert(users).values({
        id: u.id,
        email: u.email,
        passwordHash: u.passwordHash,
        status: 'ACTIVE',
        isSeededAdmin: true,
        activatedAt: sql`now()`,
      });
    } catch (err) {
      if (isUniqueViolation(err, EMAIL_UNIQUE_INDEX)) return false;
      throw err;
    }
    await db.insert(userRoles).values([
      { userId: u.id, role: 'STUDENT' },
      { userId: u.id, role: 'ADMIN' },
    ]);
    await db.insert(profiles).values({ userId: u.id, displayName: u.displayName });
    return true;
  },
};

export interface AdminUserRow {
  id: string;
  email: string;
  status: AccountStatus;
  isSeededAdmin: boolean;
  createdAt: Date;
  activatedAt: Date | null;
  displayName: string;
  faculty: string | null;
  avatarRef: string | null;
  contactPreference: string;
  preferredMode: string;
  roles: Role[];
}

export interface AuditRow {
  id: string;
  actorId: string;
  targetUserId: string;
  action: AuditAction;
  reason: string;
  occurredAt: Date;
  correlationId: string;
}
