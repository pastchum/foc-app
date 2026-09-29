import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiException } from '@foc/platform';
import { hashPassword } from '../auth/passwords.js';
import { sessionsRepository as sessions } from '../auth/sessions.repository.js';
import { newOpaqueToken, sha256Hex } from '../auth/tokens.js';
import { DB, type Database } from '../db/db.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { isAllowedDomain, normalizeEmail } from './email.js';
import { usersRepository as repo, type AccountStatus, type Role } from './users.repository.js';
import { validationFailed } from './validation.js';

export const USER_SETTINGS = Symbol('USER_SETTINGS');

export interface UserSettings {
  allowedEmailDomains: readonly string[];
  activationTokenTtlHours: number;
}

export interface IdentityLookup {
  userId: string;
  exists: boolean;
  status?: AccountStatus;
  roles?: Role[];
  displayName?: string;
}

export type IntrospectionResult =
  | { active: false }
  | {
      active: true;
      userId: string;
      status: AccountStatus;
      roles: Role[];
      displayName: string;
    };

export interface PermissionsLookup {
  userId: string;
  status: AccountStatus;
  isAdmin: boolean;
  canPlaceOrders: boolean;
  canAcceptOrders: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(USER_SETTINGS) private readonly settings: UserSettings,
  ) {}

  /** US-FR1.1.1 — reject off-domain and duplicate emails without creating an account. */
  async register(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<{ userId: string; status: 'PENDING_ACTIVATION' }> {
    const email = normalizeEmail(input.email);
    if (!isAllowedDomain(email, this.settings.allowedEmailDomains)) {
      throw validationFailed([
        {
          field: 'email',
          code: 'EMAIL_DOMAIN_NOT_ALLOWED',
          message: 'Use your NUS email address.',
        },
      ]);
    }

    // Hashed before the transaction: Argon2id is deliberately slow and must not hold a DB connection.
    const passwordHash = await hashPassword(input.password);
    const userId = randomUUID();
    const token = newOpaqueToken();

    const created = await this.db.transaction(async (tx) => {
      const inserted = await repo.insertUser(tx, {
        id: userId,
        email,
        passwordHash,
        displayName: input.displayName,
      });
      if (!inserted) return false;
      await repo.insertActivationToken(tx, {
        id: randomUUID(),
        userId,
        tokenHash: sha256Hex(token),
        ttlHours: this.settings.activationTokenTtlHours,
      });
      return true;
    });

    if (!created) {
      throw new ApiException(
        409,
        'EMAIL_ALREADY_REGISTERED',
        'An account with this email already exists.',
      );
    }

    // After commit: a mail failure must not roll back an account that already exists.
    await this.mailer.sendActivation({ to: email, userId, token });
    return { userId, status: 'PENDING_ACTIVATION' };
  }

  /**
   * US-FR4.1.1 — single-use, expiring, replay-idempotent. The first success
   * activates the account and writes exactly one `UserActivated` to the outbox
   * in the same transaction; a replay changes nothing and emits nothing.
   */
  async activate(
    token: string,
    correlationId: string,
  ): Promise<{ userId: string; status: 'ACTIVE'; alreadyActivated: boolean }> {
    const tokenHash = sha256Hex(token);

    return this.db.transaction(async (tx) => {
      const userId = await repo.consumeActivationToken(tx, tokenHash);

      if (userId) {
        const activated = await repo.markActivated(tx, userId);
        // Not pending any more (e.g. suspended before it activated). Throwing rolls the
        // transaction back, so the token is not left consumed by a failed activation.
        if (!activated) throw invalidToken();
        await repo.insertOutboxEvent(tx, {
          id: randomUUID(),
          eventType: 'UserActivated',
          aggregateId: userId,
          payload: { userId },
          correlationId,
        });
        return { userId, status: 'ACTIVE' as const, alreadyActivated: false };
      }

      const known = await repo.findActivationToken(tx, tokenHash);
      if (!known) throw invalidToken();
      if (known.consumed) {
        if (await repo.isActivated(tx, known.userId)) {
          return { userId: known.userId, status: 'ACTIVE' as const, alreadyActivated: true };
        }
        throw invalidToken();
      }
      throw new ApiException(410, 'ACTIVATION_TOKEN_EXPIRED', 'This activation link has expired.');
    });
  }

  /** US-FR4.1.2 — existence, status, roles and display name only. */
  async lookup(userId: string): Promise<IdentityLookup> {
    const row = await repo.findIdentity(this.db, userId);
    if (!row) return { userId, exists: false };
    return { userId, exists: true, ...row };
  }

  /**
   * Introspection for other services' auth middleware: is this session still live, and who is
   * behind it? One call answers both, so a service does not need a second lookup per request.
   * `active` is false — with nothing else revealed — when the session is revoked, expired,
   * unknown, or does not belong to `userId`. A live session for a suspended or pending
   * account is still `active`, with its `status`, so the caller can answer 403 rather than 401.
   */
  async introspect(sessionId: string, userId: string): Promise<IntrospectionResult> {
    const session = await sessions.liveness(this.db, sessionId, userId);
    if (!session?.live) return { active: false };
    const identity = await repo.findIdentity(this.db, userId);
    if (!identity) return { active: false };
    return {
      active: true,
      userId,
      status: identity.status,
      roles: identity.roles,
      displayName: identity.displayName,
    };
  }

  /** US-FR4.1.3 — a suspended or pending admin has no effective permissions. */
  async permissions(userId: string): Promise<PermissionsLookup> {
    const row = await repo.findIdentity(this.db, userId);
    if (!row) throw new ApiException(404, 'NOT_FOUND', 'User not found.');
    const active = row.status === 'ACTIVE';
    return {
      userId,
      status: row.status,
      isAdmin: active && row.roles.includes('ADMIN'),
      canPlaceOrders: active,
      canAcceptOrders: active,
    };
  }
}

function invalidToken(): ApiException {
  return new ApiException(404, 'ACTIVATION_TOKEN_INVALID', 'This activation link is not valid.');
}
