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
import { Audit, Requires } from './decorators.js';
import { SESSION_COOKIE } from './session.service.js';
import { sha256, TokensService } from './tokens.service.js';

const ADMIN_PW = 'Initial-Admin-Pw-1';
const CSRF = { 'x-capi-navigator': '1' };
const C = '/api/test/connections';

@Controller('api/test/connections/:connection')
class ScopedController {
  @Requires('clusters.change')
  @Post('clusters/:namespace/:name/scale')
  @Audit({ action: 'test.scale' })
  scale() {
    return { ok: true };
  }

  @Requires('view')
  @Get('clusters')
  list() {
    return [];
  }
}

describe('API tokens of technical users over HTTP (FP-22, ADR-0017)', () => {
  let app: NestExpressApplication;
  let fake: ReturnType<typeof createFakeStore>;
  let admin: string;
  let token: string;
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  const cookieFrom = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
      .split(';')[0]!;

  beforeAll(async () => {
    fake = createFakeStore();
    const config = loadConfig({
      INITIAL_ADMIN_PASSWORD: ADMIN_PW,
      LOG_JSON: 'false',
      LOGIN_RATE_LIMIT: '5',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, KubeModule, StoreModule, AuditModule, AuthModule],
      controllers: [ScopedController],
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
    const first = await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'admin', password: ADMIN_PW })
      .expect(200);
    const changed = await http()
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', cookieFrom(first))
      .send({ currentPassword: ADMIN_PW, newPassword: 'Admin-New-Pw-12' })
      .expect(200);
    admin = cookieFrom(changed);
  });

  afterAll(async () => {
    await app?.close();
  });

  const asAdmin = (method: 'post' | 'patch' | 'delete', path: string, body?: object) =>
    http()[method](path).set(CSRF).set('Cookie', admin).send(body);

  it('creates technical users without password; they cannot sign in (FP22-F-01)', async () => {
    const res = await asAdmin('post', '/api/users', {
      username: 'ci-deploy',
      apiOnly: true,
      bindings: [{ role: 'operator', connections: ['home'], namespaces: ['team-a'] }],
    }).expect(201);
    expect(res.body).toMatchObject({ apiOnly: true, mustChangePassword: false });
    expect(fake.secrets.has('navigator-user-ci-deploy-password')).toBe(false);
    await asAdmin('post', '/api/users', {
      username: 'ci-other',
      apiOnly: true,
      bindings: [{ role: 'viewer' }],
      password: 'Some-Password-1',
    }).expect(400);
    await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'ci-deploy', password: 'anything-goes' })
      .expect(401);
    await asAdmin('post', '/api/users/ci-deploy/reset-password', {
      password: 'Some-Password-1',
    }).expect(400);
  });

  it('shows the token once and stores only its hash (FP22-F-02, FP22-F-03)', async () => {
    const res = await asAdmin('post', '/api/users/ci-deploy/tokens', {
      name: 'pipeline',
      description: 'GitLab CI',
    }).expect(201);
    token = res.body.token as string;
    expect(token).toMatch(/^capin_[A-Za-z0-9_-]{43}$/);
    expect(res.body).toMatchObject({ name: 'pipeline', createdBy: 'admin', expired: false });
    const days = (Date.parse(res.body.expiresAt as string) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(90);

    const list = await http().get('/api/users/ci-deploy/tokens').set('Cookie', admin).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(JSON.stringify(list.body)).not.toContain(sha256(token));
    const stored = [...fake.tokens.values()][0]!;
    expect(stored.spec.sha256).toBe(sha256(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    await asAdmin('post', '/api/users/ci-deploy/tokens', { name: 'pipeline' }).expect(409);
    await asAdmin('post', '/api/users/admin/tokens', { name: 'x' }).expect(400);
    await asAdmin('post', '/api/users/ci-deploy/tokens', {
      name: 'too-long',
      expiresInDays: 400,
    }).expect(400);
  });

  it('acts with the role assignments of its user, without CSRF header (FP22-F-04)', async () => {
    const me = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    expect(me.body).toMatchObject({ username: 'ci-deploy' });
    await http().get(`${C}/aws/clusters`).set(bearer(token)).expect(200);
    await http().post(`${C}/home/clusters/team-a/demo/scale`).set(bearer(token)).expect(201);
    await http().post(`${C}/home/clusters/team-b/demo/scale`).set(bearer(token)).expect(403);
    // The cookie path still needs the CSRF header.
    await http().post(`${C}/home/clusters/team-a/demo/scale`).set('Cookie', admin).expect(403);
  });

  it('records the token in the audit log, never its value (FP22-F-07)', () => {
    const scale = fake.auditEvents.find(
      (e) => e.spec.action === 'test.scale' && e.spec.outcome === 'success',
    );
    expect(scale?.spec).toMatchObject({ actor: 'ci-deploy', token: 'pipeline' });
    expect(fake.auditEvents.map((e) => e.spec.action)).toContain('token.create');
    expect(JSON.stringify(fake.auditEvents)).not.toContain(token);
  });

  it('never manages users, roles or tokens with a token (FP22-F-05)', async () => {
    await asAdmin('post', '/api/users', {
      username: 'ci-admin',
      apiOnly: true,
      bindings: [{ role: 'admin' }],
    }).expect(201);
    const adminToken = (
      await asAdmin('post', '/api/users/ci-admin/tokens', { name: 'all' }).expect(201)
    ).body.token as string;
    const res = await http().get('/api/users').set(bearer(adminToken)).expect(403);
    expect(res.body.message).toBe('API tokens cannot manage users, roles or tokens');
    await http().get('/api/roles').set(bearer(adminToken)).expect(403);
    await http()
      .post('/api/users/ci-admin/tokens')
      .set(bearer(adminToken))
      .send({ name: 'more' })
      .expect(403);
  });

  it('uses only the token when both a token and a cookie are sent', async () => {
    await http().get('/api/auth/me').set('Cookie', admin).set(bearer('capin_invalid')).expect(401);
    // Other schemes (e.g. Basic auth added by an ingress) leave the session working.
    await http()
      .get('/api/auth/me')
      .set('Cookie', admin)
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(200);
  });

  it('refuses tokens of disabled users, expired and revoked tokens (FP22-F-04)', async () => {
    await asAdmin('patch', '/api/users/ci-deploy', { disabled: true }).expect(200);
    await http().get('/api/auth/me').set(bearer(token)).expect(401);
    await asAdmin('patch', '/api/users/ci-deploy', { disabled: false }).expect(200);
    await http().get('/api/auth/me').set(bearer(token)).expect(200);

    const tokens = app.get(TokensService);
    tokens.now = () => Date.now() + 91 * 86_400_000;
    try {
      await http().get('/api/auth/me').set(bearer(token)).expect(401);
    } finally {
      tokens.now = Date.now;
    }

    const id = [...fake.tokens.values()].find((t) => t.spec.name === 'pipeline')!.metadata.name;
    await asAdmin('delete', `/api/users/ci-deploy/tokens/${id}`).expect(204);
    const res = await http().get('/api/auth/me').set(bearer(token)).expect(401);
    expect(res.body.message).toBe('Invalid, expired or revoked API token');
  });

  it('records the last use at most hourly (FP22-F-09)', async () => {
    const t = (await asAdmin('post', '/api/users/ci-admin/tokens', { name: 'used' }).expect(201))
      .body.token as string;
    await http().get('/api/auth/me').set(bearer(t)).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const used = [...fake.tokens.values()].find((x) => x.spec.name === 'used')!;
    const first = used.status?.lastUsedAt;
    expect(first).toBeDefined();
    await http().get('/api/auth/me').set(bearer(t)).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...fake.tokens.values()].find((x) => x.spec.name === 'used')!.status?.lastUsedAt).toBe(
      first,
    );
  });

  it('removes the tokens with their user', async () => {
    await asAdmin('delete', '/api/users/ci-admin').expect(204);
    expect([...fake.tokens.values()].some((t) => t.spec.user === 'ci-admin')).toBe(false);
  });

  it('slows down repeated failed token attempts, never valid tokens (FP22-F-06)', async () => {
    const valid = (
      await asAdmin('post', '/api/users/ci-deploy/tokens', { name: 'after-failures' }).expect(201)
    ).body.token as string;
    let status = 0;
    for (let i = 0; i < 10 && status !== 429; i++) {
      status = (await http().get('/api/auth/me').set(bearer('capin_wrong'))).status;
    }
    expect(status).toBe(429);
    const res = await http().get('/api/auth/me').set(bearer('capin_wrong')).expect(429);
    expect(res.headers['retry-after']).toBeDefined();
    // A valid token from the same client is never locked out.
    await http().get('/api/auth/me').set(bearer(valid)).expect(200);
  });
});
