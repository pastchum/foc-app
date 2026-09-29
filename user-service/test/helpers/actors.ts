import request from 'supertest';
import { seedAdmins } from '../../src/admin/seed.js';
import type { TestApp } from './app.js';
import { validRegistration } from './app.js';

export const PASSWORD = validRegistration().password;
export const ORIGIN = 'http://localhost:3000';

export interface Actor {
  id: string;
  email: string;
  accessToken: string;
  cookie: string;
}

export const http = (t: TestApp) => request(t.app.getHttpServer());

export async function login(t: TestApp, email: string, password = PASSWORD): Promise<Actor> {
  const res = await http(t)
    .post('/auth/login')
    .set('Origin', ORIGIN)
    .send({ email, password })
    .expect(200);
  const cookie = ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((c) => c.startsWith('foc_refresh='))!
    .split(';')[0]!;
  return { id: res.body.user.id, email, accessToken: res.body.accessToken, cookie };
}

/** Registers, activates and logs in an ordinary student. */
export async function activeStudent(t: TestApp, email: string): Promise<Actor> {
  await http(t).post('/auth/register').send(validRegistration(email)).expect(201);
  await http(t)
    .post('/auth/activate')
    .send({ token: t.mailbox.latestFor(email)!.token })
    .expect(200);
  return login(t, email);
}

/** Creates a seeded administrator through the real seeding path, then logs in. */
export async function seededAdmin(t: TestApp, email: string): Promise<Actor> {
  await seedAdmins(t.orm, { emails: [email], password: PASSWORD, allowedDomains: ['u.nus.edu'] });
  return login(t, email);
}

export const bearer = (a: Pick<Actor, 'accessToken'>) => `Bearer ${a.accessToken}`;

export const TRUNCATE_ALL =
  'TRUNCATE outbox_events, audit_records, activation_tokens, refresh_sessions, profiles, user_roles, users RESTART IDENTITY CASCADE';
