import { Controller, Get, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditModule } from '../audit/audit.module.js';
import { APP_CONFIG, loadConfig } from '../config/config.js';
import { ConfigModule } from '../config/config.module.js';
import { configureApp } from '../configure-app.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { KubeModule } from '../kube/kube.module.js';
import { StoreModule } from '../store/store.module.js';
import { StoreService } from '../store/store.service.js';
import { createFakeStore } from '../testing/fake-store.js';
import { AuthModule } from './auth.module.js';
import { Roles } from './decorators.js';
import { SESSION_COOKIE } from './session.service.js';

const ADMIN_PW = 'Initial-Admin-Pw-1';
const CSRF = { 'x-capi-navigator': '1' };

/** Endpoints to check the fail-closed behaviour and the role levels of the guard. */
@Controller('api/test')
class TestController {
  @Get('no-rule')
  noRule() {
    return 'should never be reachable';
  }

  @Roles('operator')
  @Post('operator-action')
  operatorAction() {
    return { ok: true };
  }
}

describe('authentication and authorization over HTTP (FP-1)', () => {
  let app: NestExpressApplication;
  let fake: ReturnType<typeof createFakeStore>;
  const http = () => request(app.getHttpServer());

  function cookieFrom(res: request.Response): string {
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (!session) throw new Error('no session cookie');
    return session.split(';')[0]!;
  }

  async function login(username: string, password: string): Promise<string> {
    const res = await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username, password })
      .expect(200);
    return cookieFrom(res);
  }

  /** Logs in and completes the forced password change; returns the new session cookie. */
  async function loginAndActivate(username: string, initial: string, next: string) {
    const first = await login(username, initial);
    const res = await http()
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', first)
      .send({ currentPassword: initial, newPassword: next })
      .expect(200);
    return { cookie: cookieFrom(res), oldCookie: first };
  }

  let adminCookie: string;

  beforeAll(async () => {
    fake = createFakeStore();
    const config = loadConfig({
      INITIAL_ADMIN_PASSWORD: ADMIN_PW,
      LOGIN_RATE_LIMIT: '3',
      LOG_JSON: 'false',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, KubeModule, StoreModule, AuditModule, AuthModule],
      controllers: [TestController],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(StoreService)
      .useValue(fake.store)
      .overrideProvider(KubeClientFactory)
      .useValue({ homeCluster: () => ({ makeApiClient: () => ({}) }) })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app, config);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('creates the initial admin with a forced password change (FP1-F-02)', () => {
    const admin = fake.users.get('admin');
    expect(admin?.spec).toMatchObject({ role: 'admin', mustChangePassword: true });
    expect(fake.secrets.get('navigator-user-admin-password')?.hash).toMatch(/^\$argon2id\$/);
  });

  it('returns 401 for /api/* without a session, except health and login', async () => {
    await http().get('/api/users').expect(401);
    await http().get('/api/auth/me').expect(401);
    await http().post('/api/users').set(CSRF).send({}).expect(401);
  });

  it('denies endpoints without an access rule (fail closed)', async () => {
    await http().get('/api/test/no-rule').expect(403);
  });

  it('rejects mutating requests without the CSRF header or from another origin (NF-04)', async () => {
    await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: ADMIN_PW })
      .expect(403);
    await http()
      .post('/api/auth/login')
      .set(CSRF)
      .set('Origin', 'https://evil.example')
      .send({ username: 'admin', password: ADMIN_PW })
      .expect(403);
  });

  it('sets a content security policy (NF-04)', async () => {
    const res = await http().get('/api/auth/me');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('rejects wrong credentials without telling which part was wrong', async () => {
    const res = await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'admin', password: 'wrong-password' })
      .expect(401);
    expect(res.body.message).toBe('Wrong username or password');
    await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'nobody', password: 'wrong-password' })
      .expect(401);
  });

  it('issues an HttpOnly, Secure, SameSite=Strict cookie (FP1-F-03)', async () => {
    const res = await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'admin', password: ADMIN_PW })
      .expect(200);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join(';');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(res.body).toEqual({ username: 'admin', role: 'admin', mustChangePassword: true });
  });

  it('allows only /me and change-password until the password is changed (FP1-F-02)', async () => {
    const cookie = await login('admin', ADMIN_PW);
    await http().get('/api/auth/me').set('Cookie', cookie).expect(200);
    const res = await http().get('/api/users').set('Cookie', cookie).expect(403);
    expect(res.body.message).toBe('Password change required');
  });

  it('validates the new password with the shared schema', async () => {
    const cookie = await login('admin', ADMIN_PW);
    const res = await http()
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ currentPassword: ADMIN_PW, newPassword: 'short' })
      .expect(400);
    expect(res.body.fieldErrors.newPassword).toBeDefined();
  });

  it('changes the password and invalidates older sessions', async () => {
    const { cookie, oldCookie } = await loginAndActivate('admin', ADMIN_PW, 'Admin-New-Pw-123');
    adminCookie = cookie;
    await http().get('/api/users').set('Cookie', cookie).expect(200);
    await http().get('/api/auth/me').set('Cookie', oldCookie).expect(401);
  });

  it('lets the admin create a viewer and an operator (acceptance FP-1)', async () => {
    for (const [username, role] of [
      ['vera', 'viewer'],
      ['otto', 'operator'],
    ]) {
      const res = await http()
        .post('/api/users')
        .set(CSRF)
        .set('Cookie', adminCookie)
        .send({ username, role, password: 'Temp-Password-1' })
        .expect(201);
      expect(res.body).toMatchObject({ username, role, mustChangePassword: true });
    }
    const list = await http().get('/api/users').set('Cookie', adminCookie).expect(200);
    expect(list.body.map((u: { username: string }) => u.username)).toEqual(
      expect.arrayContaining(['admin', 'vera', 'otto']),
    );
  });

  it('never returns password data (NF-01)', async () => {
    const res = await http().get('/api/users').set('Cookie', adminCookie).expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|"hash"|"password"/i);
  });

  it('returns 403 to a viewer on mutating endpoints (acceptance FP-1)', async () => {
    const { cookie } = await loginAndActivate('vera', 'Temp-Password-1', 'Vera-Password-12');
    await http()
      .post('/api/users')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({ username: 'x-user', role: 'viewer', password: 'Temp-Password-1' })
      .expect(403);
    await http().post('/api/test/operator-action').set(CSRF).set('Cookie', cookie).expect(403);
    await http().get('/api/users').set('Cookie', cookie).expect(403);
  });

  it('lets an operator use operator endpoints but not admin endpoints', async () => {
    const { cookie } = await loginAndActivate('otto', 'Temp-Password-1', 'Otto-Password-12');
    await http().post('/api/test/operator-action').set(CSRF).set('Cookie', cookie).expect(201);
    await http().get('/api/users').set('Cookie', cookie).expect(403);
  });

  it('applies role changes immediately and ends existing sessions', async () => {
    const cookie = await login('otto', 'Otto-Password-12');
    await http()
      .patch('/api/users/otto')
      .set(CSRF)
      .set('Cookie', adminCookie)
      .send({ role: 'viewer' })
      .expect(200);
    await http().post('/api/test/operator-action').set(CSRF).set('Cookie', cookie).expect(401);
  });

  it('blocks disabled users', async () => {
    await http()
      .patch('/api/users/vera')
      .set(CSRF)
      .set('Cookie', adminCookie)
      .send({ disabled: true })
      .expect(200);
    await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'vera', password: 'Vera-Password-12' })
      .expect(401);
  });

  it('resets a password and forces a change at next login', async () => {
    await http()
      .post('/api/users/otto/reset-password')
      .set(CSRF)
      .set('Cookie', adminCookie)
      .send({ password: 'Reset-Password-1' })
      .expect(200);
    const res = await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'otto', password: 'Reset-Password-1' })
      .expect(200);
    expect(res.body.mustChangePassword).toBe(true);
  });

  it('protects against admin lock-out', async () => {
    await http().delete('/api/users/admin').set(CSRF).set('Cookie', adminCookie).expect(400);
    await http()
      .patch('/api/users/admin')
      .set(CSRF)
      .set('Cookie', adminCookie)
      .send({ role: 'viewer' })
      .expect(400);
  });

  it('deletes a user together with the password Secret', async () => {
    await http().delete('/api/users/vera').set(CSRF).set('Cookie', adminCookie).expect(204);
    expect(fake.users.has('vera')).toBe(false);
    expect(fake.secrets.has('navigator-user-vera-password')).toBe(false);
  });

  it('records every mutating action as an AuditEvent (FP1-F-06)', () => {
    const actions = fake.auditEvents.map((e) => `${e.spec.action}:${e.spec.outcome}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.login:failure',
        'auth.login:success',
        'auth.change-password:success',
        'auth.change-password:failure',
        'user.create:success',
        'user.update:success',
        'user.reset-password:success',
        'user.delete:success',
        'user.delete:failure',
      ]),
    );
    const create = fake.auditEvents.find((e) => e.spec.action === 'user.create');
    expect(create?.spec).toMatchObject({ actor: 'admin', target: { kind: 'NavigatorUser' } });
    expect(JSON.stringify(fake.auditEvents)).not.toContain('Temp-Password-1');
  });

  it('rate-limits failed logins (NF-04)', async () => {
    for (let i = 0; i < 3; i++) {
      await http()
        .post('/api/auth/login')
        .set(CSRF)
        .send({ username: 'otto', password: 'wrong-password' })
        .expect(401);
    }
    const res = await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'otto', password: 'Reset-Password-1' })
      .expect(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
