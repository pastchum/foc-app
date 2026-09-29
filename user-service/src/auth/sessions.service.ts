import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiException } from '@foc/platform';
import { DB, type Database } from '../db/db.js';
import { normalizeEmail } from '../users/email.js';
import {
  usersRepository as users,
  type AccountStatus,
  type Role,
} from '../users/users.repository.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { ACCESS_TOKEN_TTL_SECONDS, JWT, type JwtService } from './jwt.service.js';
import { REFRESH_TTL_DAYS } from './cookies.js';
import { sessionsRepository as sessions } from './sessions.repository.js';
import { newOpaqueToken, sha256Hex } from './tokens.js';

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: { id: string; displayName: string; roles: Role[]; status: AccountStatus };
}

const codeForStatus = (status: AccountStatus) =>
  status === 'SUSPENDED'
    ? new ApiException(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.')
    : new ApiException(
        403,
        'ACCOUNT_NOT_ACTIVATED',
        'Activate your account from the email we sent.',
      );

@Injectable()
export class SessionsService {
  /** Hashed once, so an unknown email costs the same Argon2 work as a wrong password. */
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(JWT) private readonly jwt: JwtService,
  ) {}

  /** US-FR1.1.2 — only valid credentials on an ACTIVE account get tokens. */
  async login(rawEmail: string, password: string): Promise<IssuedSession> {
    const user = await users.findCredentials(this.db, normalizeEmail(rawEmail));

    this.dummyHash ??= hashPassword('not-a-real-password');
    // Verify against a dummy hash when the email is unknown so response time does not reveal it.
    const valid = await verifyPassword(user?.passwordHash ?? (await this.dummyHash), password);
    if (!user || !valid) {
      throw new ApiException(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    // Status is revealed only after the password proves the caller owns the account.
    if (user.status !== 'ACTIVE') throw codeForStatus(user.status);

    const sessionId = randomUUID();
    const refreshToken = newOpaqueToken();
    await sessions.insert(this.db, {
      id: sessionId,
      familyId: randomUUID(),
      userId: user.id,
      tokenHash: sha256Hex(refreshToken),
      ttlDays: REFRESH_TTL_DAYS,
    });
    return this.respond(user.id, sessionId, refreshToken, {
      id: user.id,
      displayName: user.displayName,
      roles: user.roles,
      status: user.status,
    });
  }

  /**
   * Rotates the refresh token. Each use invalidates the presented token and
   * issues a new one in the same family. Presenting a token that was already
   * rotated means it was copied: the whole family is revoked.
   */
  async refresh(refreshToken: string | undefined): Promise<IssuedSession> {
    if (!refreshToken) throw invalid();
    const hash = sha256Hex(refreshToken);
    const nextToken = newOpaqueToken();
    const nextId = randomUUID();

    // Outcomes are returned, not thrown, from inside the transaction: a throw would
    // roll back the family revocation that reuse detection exists to perform.
    const outcome = await this.db.transaction(async (tx) => {
      const row = await sessions.lockByHash(tx, hash);
      if (!row) return { kind: 'invalid' as const };
      if (row.rotated) {
        await sessions.revokeFamily(tx, row.familyId);
        return { kind: 'reused' as const };
      }
      if (row.revoked || row.expired) return { kind: 'invalid' as const };
      if (row.userStatus !== 'ACTIVE') {
        await sessions.revokeFamily(tx, row.familyId);
        return { kind: 'inactive' as const, status: row.userStatus };
      }
      await sessions.markRotated(tx, row.id);
      await sessions.insert(tx, {
        id: nextId,
        familyId: row.familyId,
        userId: row.userId,
        tokenHash: sha256Hex(nextToken),
        ttlDays: REFRESH_TTL_DAYS,
      });
      return { kind: 'ok' as const, userId: row.userId };
    });

    switch (outcome.kind) {
      case 'invalid':
        throw invalid();
      case 'reused':
        throw new ApiException(401, 'REFRESH_TOKEN_REUSED', 'Session revoked. Log in again.');
      case 'inactive':
        throw codeForStatus(outcome.status);
      case 'ok': {
        const identity = await users.findIdentity(this.db, outcome.userId);
        if (!identity) throw invalid();
        return this.respond(outcome.userId, nextId, nextToken, {
          id: outcome.userId,
          displayName: identity.displayName,
          roles: identity.roles,
          status: identity.status,
        });
      }
    }
  }

  /** Revokes the caller's whole session family. Idempotent: an unknown or absent token is a no-op. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await sessions.revokeFamilyByTokenHash(this.db, sha256Hex(refreshToken));
  }

  private async respond(
    userId: string,
    sessionId: string,
    refreshToken: string,
    user: IssuedSession['user'],
  ): Promise<IssuedSession> {
    return {
      accessToken: await this.jwt.sign({ sub: userId, sid: sessionId }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user,
    };
  }
}

function invalid(): ApiException {
  return new ApiException(401, 'REFRESH_TOKEN_INVALID', 'Session expired. Log in again.');
}
