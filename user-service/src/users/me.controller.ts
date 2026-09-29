import { Body, Controller, Get, Inject, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiException } from '@foc/platform';
import { AccessTokenGuard, type AuthedRequest } from '../auth/access-token.guard.js';
import { DB, type Database } from '../db/db.js';
import { usersRepository } from './users.repository.js';
import { parseOrThrow, profileUpdateSchema } from './validation.js';

@Controller('users/me')
@UseGuards(AccessTokenGuard)
export class MeController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  me(@Req() req: AuthedRequest) {
    return this.load(req.auth.userId);
  }

  /**
   * US-FR3.1.1 — a student edits only their own profile fields. The caller is
   * the token's subject, never a path or body value, and the schema is closed:
   * `id`, `email`, `roles`, `status` or any unknown field is rejected outright,
   * with nothing changed, as `FIELD_NOT_EDITABLE`.
   */
  @Patch()
  async update(@Body() body: unknown, @Req() req: AuthedRequest) {
    const changes = parseOrThrow(profileUpdateSchema, body, 'FIELD_NOT_EDITABLE');
    await usersRepository.updateProfile(this.db, req.auth.userId, changes);
    return this.load(req.auth.userId);
  }

  private async load(userId: string) {
    const u = await usersRepository.findMe(this.db, userId);
    if (!u) throw new ApiException(401, 'UNAUTHENTICATED', 'Authentication required.');
    return {
      id: u.id,
      email: u.email,
      roles: u.roles,
      status: u.status,
      profile: {
        displayName: u.displayName,
        faculty: u.faculty,
        avatarRef: u.avatarRef,
        contactPreference: u.contactPreference,
        preferredMode: u.preferredMode,
      },
      createdAt: new Date(u.createdAt).toISOString(),
    };
  }
}
