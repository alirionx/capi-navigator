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
import { Requires } from './decorators.js';
import { SESSION_COOKIE } from './session.service.js';

const ADMIN_PW = 'Initial-Admin-Pw-1';
const CSRF = { 'x-capi-navigator': '1' };
const C = '/api/test/connections';

/** Endpoints shaped like the real ones: namespace in the route or, for creation, in the body. */
@Controller('api/test/connections/:connection')
class ScopedController {
  @Requires('clusters.change')
  @Post('clusters/:namespace/:name/scale')
  scale() {
    return { ok: true };
  }

  @Requires('clusters.create', { namespaceFromBody: 'spec.namespace' })
  @Post('clusters')
  create() {
    return { ok: true };
  }

  @Requires('clusters.kubeconfig')
  @Get('clusters/:namespace/:name/kubeconfig')
  kubeconfig() {
    return { ok: true };
  }
}

describe('custom roles and scoped assignments over HTTP (FP-19)', () => {
  let app: NestExpressApplication;
  let fake: ReturnType<typeof createFakeStore>;
  let admin: string;
  const http = () => request(app.getHttpServer());

  const cookieFrom = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
      .split(';')[0]!;

  /** Signs in and completes the forced password change. */
  async function activate(username: string, initial: string): Promise<string> {
    const first = await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username, password: initial })
      .expect(200);
    const res = await http()
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', cookieFrom(first))
      .send({ currentPassword: initial, newPassword: `${initial}-new` })
      .expect(200);
    return cookieFrom(res);
  }

  const send = (method: 'post' | 'patch' | 'delete', path: string, cookie: string, body?: object) =>
    http()[method](path).set(CSRF).set('Cookie', cookie).send(body);

  async function createUser(username: string, bindings: object[]): Promise<string> {
    await send('post', '/api/users', admin, {
      username,
      bindings,
      password: 'Temp-Password-1',
    }).expect(201);
    return activate(username, 'Temp-Password-1');
  }

  beforeAll(async () => {
    fake = createFakeStore();
    const config = loadConfig({ INITIAL_ADMIN_PASSWORD: ADMIN_PW, LOG_JSON: 'false' });
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
    admin = await activate('admin', ADMIN_PW);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists the built-in roles and creates a custom role (FP19-F-01, FP19-F-02)', async () => {
    const created = await send('post', '/api/roles', admin, {
      name: 'day2',
      displayName: 'Day-2 only',
      permissions: ['clusters.change'],
    }).expect(201);
    expect(created.body).toMatchObject({
      name: 'day2',
      permissions: ['view', 'clusters.change'],
      builtin: false,
      users: [],
    });
    const list = await http().get('/api/roles').set('Cookie', admin).expect(200);
    expect(list.body.map((r: { name: string }) => r.name)).toEqual([
      'viewer',
      'operator',
      'admin',
      'day2',
    ]);
    expect(list.body[2]).toMatchObject({ builtin: true, users: ['admin'] });
  });

  it('refuses changing, deleting or shadowing built-in roles', async () => {
    await send('post', '/api/roles', admin, {
      name: 'admin',
      displayName: 'x',
      permissions: [],
    }).expect(400);
    await send('patch', '/api/roles/operator', admin, {
      displayName: 'x',
      permissions: [],
    }).expect(400);
    await send('delete', '/api/roles/viewer', admin).expect(400);
  });

  it('limits a custom role to its permissions, also for direct API calls (acceptance)', async () => {
    const dora = await createUser('dora', [{ role: 'day2' }]);
    await send('post', `${C}/home/clusters/team-a/demo/scale`, dora).expect(201);
    await send('post', `${C}/home/clusters`, dora, { spec: { namespace: 'team-a' } }).expect(403);
    await http().get(`${C}/home/clusters/team-a/demo/kubeconfig`).set('Cookie', dora).expect(403);
    const me = await http().get('/api/auth/me').set('Cookie', dora).expect(200);
    expect(me.body.bindings).toEqual([{ role: 'day2', permissions: ['view', 'clusters.change'] }]);
  });

  it('limits an assignment to a connection and namespaces (acceptance)', async () => {
    const tina = await createUser('tina', [
      { role: 'operator', connections: ['home'], namespaces: ['team-a'] },
    ]);
    await send('post', `${C}/home/clusters/team-a/demo/scale`, tina).expect(201);
    await send('post', `${C}/home/clusters/team-b/demo/scale`, tina).expect(403);
    await send('post', `${C}/aws/clusters/team-a/demo/scale`, tina).expect(403);
    await send('post', `${C}/home/clusters`, tina, { spec: { namespace: 'team-a' } }).expect(201);
    const denied = await send('post', `${C}/home/clusters`, tina, {
      spec: { namespace: 'team-b' },
    }).expect(403);
    expect(denied.body.message).toBe(
      'This action requires the permission clusters.create in namespace team-b',
    );
    // A missing or forged namespace never counts as "any namespace".
    await send('post', `${C}/home/clusters`, tina, { spec: {} }).expect(403);
    await send('post', `${C}/home/clusters`, tina, { spec: { namespace: ['team-a'] } }).expect(403);
    await http().get('/api/users').set('Cookie', tina).expect(403);
  });

  it('refuses platform permissions in limited assignments (FP19-F-03)', async () => {
    const res = await send('post', '/api/users', admin, {
      username: 'lima',
      bindings: [{ role: 'admin', namespaces: ['team-a'] }],
      password: 'Temp-Password-1',
    }).expect(400);
    expect(res.body.message).toMatch(/can only be assigned without limits/);
    await send('post', '/api/users', admin, {
      username: 'nora',
      bindings: [{ role: 'no-such-role' }],
      password: 'Temp-Password-1',
    }).expect(400);
  });

  it('applies role changes on the next request, without signing in again (FP19-F-06)', async () => {
    const dora = cookieFrom(
      await http()
        .post('/api/auth/login')
        .set(CSRF)
        .send({ username: 'dora', password: 'Temp-Password-1-new' })
        .expect(200),
    );
    await send('post', `${C}/home/clusters/team-a/demo/scale`, dora).expect(201);
    await send('patch', '/api/roles/day2', admin, {
      displayName: 'Day-2 only',
      permissions: ['clusters.kubeconfig'],
    }).expect(200);
    await send('post', `${C}/home/clusters/team-a/demo/scale`, dora).expect(403);
    await http().get(`${C}/home/clusters/team-a/demo/kubeconfig`).set('Cookie', dora).expect(200);
  });

  it('refuses deleting an assigned role and names its users (FP19-F-08)', async () => {
    const res = await send('delete', '/api/roles/day2', admin).expect(409);
    expect(res.body.message).toBe('Role "day2" is still assigned to dora');
    await send('patch', '/api/users/dora', admin, { bindings: [] }).expect(200);
    await send('delete', '/api/roles/day2', admin).expect(204);
  });

  it('does not bring back a legacy role when all assignments are removed (FP19-F-07)', async () => {
    fake.users.set('leo', {
      apiVersion: 'navigator.capi-navigator.io/v1alpha1',
      kind: 'NavigatorUser',
      metadata: { name: 'leo', resourceVersion: '1' },
      spec: { role: 'operator', disabled: false, mustChangePassword: false, sessionGeneration: 0 },
    });
    const before = await http().get('/api/users/leo').set('Cookie', admin).expect(200);
    expect(before.body).toMatchObject({ role: 'operator', bindings: [{ role: 'operator' }] });
    await send('patch', '/api/users/leo', admin, { bindings: [] }).expect(200);
    const after = await http().get('/api/users/leo').set('Cookie', admin).expect(200);
    expect(after.body).toMatchObject({ role: 'viewer', bindings: [] });
  });

  it('keeps at least one unlimited user manager (FP19-F-08)', async () => {
    await send('post', '/api/roles', admin, {
      name: 'usermgr',
      displayName: 'User manager',
      permissions: ['users.manage'],
    }).expect(201);
    const uma = await createUser('uma', [{ role: 'usermgr' }]);
    // uma may take the admin role away, because uma still manages users.
    await send('patch', '/api/users/admin', uma, { role: 'viewer' }).expect(200);
    const res = await send('patch', '/api/roles/usermgr', uma, {
      displayName: 'User manager',
      permissions: [],
    }).expect(400);
    expect(res.body.message).toMatch(/no user could manage users anymore/);
    await send('patch', '/api/users/uma', uma, { bindings: [] }).expect(400);
  });

  it('records role changes as AuditEvents (FP19-F-11)', () => {
    const actions = fake.auditEvents.map((e) => `${e.spec.action}:${e.spec.outcome}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        'role.create:success',
        'role.update:success',
        'role.update:failure',
        'role.delete:success',
        'role.delete:failure',
        'user.update:success',
      ]),
    );
    const created = fake.auditEvents.find((e) => e.spec.action === 'role.create');
    expect(created?.spec).toMatchObject({
      actor: 'admin',
      target: { kind: 'NavigatorRole', name: 'day2' },
    });
  });
});
