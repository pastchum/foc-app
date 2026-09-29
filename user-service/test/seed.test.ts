import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdmins } from '../src/admin/seed.js';
import { createTestApp, type TestApp } from './helpers/app.js';
import { activeStudent, http, login, PASSWORD, TRUNCATE_ALL } from './helpers/actors.js';

let t: TestApp;
const domains = ['u.nus.edu'];

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.exec(TRUNCATE_ALL);
});

describe('seedAdmins (US-FR3.1.3)', () => {
  it('creates active, seeded administrators who can log in, with hashed passwords', async () => {
    const r = await seedAdmins(t.orm, {
      emails: ['Root@U.NUS.edu'],
      password: PASSWORD,
      allowedDomains: domains,
    });
    expect(r).toEqual({ created: ['root@u.nus.edu'], skipped: [] });

    const u = (await t.db.query('SELECT * FROM users')).rows[0]!;
    expect(u).toMatchObject({ status: 'ACTIVE', is_seeded_admin: true });
    expect(String(u.password_hash)).toMatch(/^\$argon2id\$/);
    expect((await t.db.query('SELECT role FROM user_roles ORDER BY role')).rows).toEqual([
      { role: 'ADMIN' },
      { role: 'STUDENT' },
    ]);

    const admin = await login(t, 'root@u.nus.edu');
    await http(t)
      .get('/admin/users')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
  });

  it('is idempotent across restarts', async () => {
    const cfg = { emails: ['root@u.nus.edu'], password: PASSWORD, allowedDomains: domains };
    await seedAdmins(t.orm, cfg);
    const again = await seedAdmins(t.orm, cfg);
    expect(again).toEqual({ created: [], skipped: ['root@u.nus.edu'] });
    expect((await t.db.query('SELECT 1 FROM users')).rows).toHaveLength(1);
  });

  it('issues a wallet event for the seeded admin like any other student', async () => {
    await seedAdmins(t.orm, {
      emails: ['root@u.nus.edu'],
      password: PASSWORD,
      allowedDomains: domains,
    });
    const ev = (await t.db.query("SELECT * FROM outbox_events WHERE event_type = 'UserActivated'"))
      .rows;
    expect(ev).toHaveLength(1);
  });

  it('never promotes an address that already has an ordinary account', async () => {
    await activeStudent(t, 'alex@u.nus.edu');
    const r = await seedAdmins(t.orm, {
      emails: ['alex@u.nus.edu'],
      password: PASSWORD,
      allowedDomains: domains,
    });
    expect(r.skipped).toEqual(['alex@u.nus.edu']);
    expect((await t.db.query("SELECT 1 FROM user_roles WHERE role = 'ADMIN'")).rows).toHaveLength(
      0,
    );
  });

  it('fails loudly on a misconfiguration', async () => {
    await expect(
      seedAdmins(t.orm, { emails: ['a@gmail.com'], password: PASSWORD, allowedDomains: domains }),
    ).rejects.toThrow(/outside ALLOWED_EMAIL_DOMAINS/);
    await expect(
      seedAdmins(t.orm, { emails: ['a@u.nus.edu'], allowedDomains: domains }),
    ).rejects.toThrow(/ADMIN_SEED_PASSWORD/);
    expect(await seedAdmins(t.orm, { allowedDomains: domains })).toEqual({
      created: [],
      skipped: [],
    });
    expect((await t.db.query('SELECT 1 FROM users')).rows).toHaveLength(0);
  });
});
