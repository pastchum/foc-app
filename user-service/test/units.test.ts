import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { newOpaqueToken, sha256Hex } from '../src/auth/tokens.js';
import { runMigrations } from '@foc/platform';
import { migrations } from '../src/db/migrations.js';
import * as schema from '../src/db/schema.js';
import { isAllowedDomain, normalizeEmail } from '../src/users/email.js';
import { usersRepository } from '../src/users/users.repository.js';
import { PgliteDb } from './helpers/pglite-db.js';

describe('email', () => {
  it('normalises case, whitespace and unicode form', () => {
    expect(normalizeEmail('  Alex@U.NUS.edu ')).toBe('alex@u.nus.edu');
    expect(normalizeEmail('ａlex@u.nus.edu')).toBe('alex@u.nus.edu'); // full-width 'a'
  });

  it('allows only exact domains', () => {
    const allowed = ['u.nus.edu', 'nus.edu.sg'];
    expect(isAllowedDomain('a@u.nus.edu', allowed)).toBe(true);
    expect(isAllowedDomain('a@nus.edu.sg', allowed)).toBe(true);
    expect(isAllowedDomain('a@gmail.com', allowed)).toBe(false);
    expect(isAllowedDomain('a@sub.u.nus.edu', allowed)).toBe(false);
    expect(isAllowedDomain('a@u.nus.edu.evil.com', allowed)).toBe(false);
    expect(isAllowedDomain('u.nus.edu', allowed)).toBe(false);
    expect(isAllowedDomain('@u.nus.edu', allowed)).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes with Argon2id, verifies, and salts uniquely', async () => {
    const a = await hashPassword('correct-horse-battery-staple');
    const b = await hashPassword('correct-horse-battery-staple');
    expect(a).toMatch(/^\$argon2id\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'correct-horse-battery-staple')).toBe(true);
    expect(await verifyPassword(a, 'wrong-password-entirely')).toBe(false);
  });

  it('never authenticates against a malformed stored hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('tokens', () => {
  it('generates distinct 256-bit tokens and hashes them deterministically', () => {
    const a = newOpaqueToken();
    expect(a).not.toBe(newOpaqueToken());
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(sha256Hex(a)).toBe(sha256Hex(a));
    expect(sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('migrations', () => {
  let db: PgliteDb;
  afterAll(async () => db?.close());

  it('apply once and are a no-op the second time', async () => {
    db = await PgliteDb.create();
    expect(await runMigrations(db, migrations)).toEqual([
      '001_identity',
      '002_refresh_sessions',
      '003_audit_records',
    ]);
    expect(await runMigrations(db, migrations)).toEqual([]);
  });

  it('enforce the schema constraints in the database itself', async () => {
    await db.query(
      `INSERT INTO users (id, email, password_hash, status)
       VALUES ('00000000-0000-4000-8000-000000000001', 'A@u.nus.edu', 'h', 'ACTIVE')`,
    );
    // unique on lower(email) even when a writer bypasses the service's normalisation
    await expect(
      db.query(
        `INSERT INTO users (id, email, password_hash, status)
         VALUES ('00000000-0000-4000-8000-000000000002', 'a@U.NUS.EDU', 'h', 'ACTIVE')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO users (id, email, password_hash, status)
         VALUES ('00000000-0000-4000-8000-000000000003', 'b@u.nus.edu', 'h', 'BANNED')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO user_roles (user_id, role) VALUES ('00000000-0000-4000-8000-000000000001', 'COURIER')`,
      ),
    ).rejects.toThrow();
  });
});

describe('insertUser conflict handling', () => {
  it('skips only a duplicate email; any other constraint violation still surfaces', async () => {
    const raw = await PgliteDb.create();
    await runMigrations(raw, migrations);
    const db = drizzle(raw.client, { schema });
    const base = { passwordHash: 'h', displayName: 'A' };
    const id1 = '00000000-0000-4000-8000-0000000000a1';

    expect(await usersRepository.insertUser(db, { ...base, id: id1, email: 'a@u.nus.edu' })).toBe(
      true,
    );
    // duplicate email (different case, different id) is skipped, not an error
    expect(
      await usersRepository.insertUser(db, {
        ...base,
        id: '00000000-0000-4000-8000-0000000000a2',
        email: 'A@U.NUS.EDU',
      }),
    ).toBe(false);
    // a primary-key collision is a real error and must not be swallowed as "duplicate email".
    // Drizzle wraps the driver error, so the "duplicate key" text is on the cause.
    const err = await usersRepository
      .insertUser(db, { ...base, id: id1, email: 'other@u.nus.edu' })
      .then(() => null)
      .catch((e: { cause?: { message?: string }; message?: string }) => e);
    expect(err).not.toBeNull();
    expect(err?.cause?.message ?? err?.message).toMatch(/duplicate key/);
    await raw.close();
  });
});
