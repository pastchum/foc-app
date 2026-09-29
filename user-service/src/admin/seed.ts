import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/passwords.js';
import type { Database } from '../db/db.js';
import { isAllowedDomain, normalizeEmail } from '../users/email.js';
import { usersRepository } from '../users/users.repository.js';
import { adminRepository } from './admin.repository.js';

export interface SeedResult {
  created: string[];
  skipped: string[];
}

/**
 * Creates the bootstrap administrators (US-FR3.1.3). Run at boot, idempotent, and
 * the only way an administrator comes into being without another administrator.
 *
 * An address that already has an account is skipped, never promoted: silently
 * escalating an existing student because of a config line would be a privilege
 * grant nobody approved. Each account gets its own salt. The password is a
 * bootstrap secret and is never logged.
 */
export async function seedAdmins(
  db: Database,
  config: { emails?: string[]; password?: string; allowedDomains: readonly string[] },
): Promise<SeedResult> {
  const result: SeedResult = { created: [], skipped: [] };
  const emails = config.emails ?? [];
  if (emails.length === 0) return result;
  if (!config.password) {
    throw new Error('ADMIN_SEED_EMAILS is set but ADMIN_SEED_PASSWORD is not.');
  }

  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (!isAllowedDomain(email, config.allowedDomains)) {
      throw new Error(
        `ADMIN_SEED_EMAILS contains an address outside ALLOWED_EMAIL_DOMAINS: ${email}`,
      );
    }
    const passwordHash = await hashPassword(config.password);
    const id = randomUUID();
    const created = await db.transaction(async (tx) => {
      const inserted = await adminRepository.insertSeededAdmin(tx, {
        id,
        email,
        passwordHash,
        displayName: 'Administrator',
      });
      if (inserted) {
        // A seeded admin is a student too, so Credit Service must issue a wallet like any other.
        await usersRepository.insertOutboxEvent(tx, {
          id: randomUUID(),
          eventType: 'UserActivated',
          aggregateId: id,
          payload: { userId: id },
          correlationId: 'seed',
        });
      }
      return inserted;
    });
    (created ? result.created : result.skipped).push(email);
  }
  return result;
}
