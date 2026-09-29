import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiException } from '@foc/platform';
import { DB, type Database } from '../db/db.js';
import { JWT, type JwtService } from './jwt.service.js';
import { sessionsRepository as sessions } from './sessions.repository.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
}
export type AuthedRequest = Request & { auth: AuthContext };

const unauthenticated = () => new ApiException(401, 'UNAUTHENTICATED', 'Authentication required.');

/**
 * Authenticates a user request: a valid signed access token, whose session is
 * still live in the database. The database check is what makes logout and
 * suspension take effect at once instead of when the 15-minute token expires.
 * The caller's role and status are read from the database, never from the token.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(JWT) private readonly jwt: JwtService,
    @Inject(DB) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const match = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!match?.[1]) throw unauthenticated();

    let claims;
    try {
      claims = await this.jwt.verify(match[1]);
    } catch {
      throw unauthenticated(); // bad signature, wrong algorithm, expired, or malformed
    }

    const state = await sessions.liveness(this.db, claims.sid, claims.sub);
    if (!state?.live) throw unauthenticated();
    if (state.status === 'SUSPENDED') {
      throw new ApiException(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
    }
    if (state.status !== 'ACTIVE') {
      throw new ApiException(403, 'ACCOUNT_NOT_ACTIVATED', 'Activate your account first.');
    }

    req.auth = { userId: claims.sub, sessionId: claims.sid };
    return true;
  }
}
