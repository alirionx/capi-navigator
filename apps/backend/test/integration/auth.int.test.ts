// Integration test against the local kind cluster (NF-16). Run with `pnpm test:int`.
// Uses its own throwaway namespace, so the data of `pnpm dev` stays untouched.
import { randomBytes } from 'node:crypto';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { SESSION_COOKIE } from '../../src/auth/session.service.js';
import { APP_CONFIG, loadConfig } from '../../src/config/config.js';
import { configureApp } from '../../src/configure-app.js';
import { StoreService } from '../../src/store/store.service.js';

const NAMESPACE = `capi-navigator-it-${randomBytes(3).toString('hex')}`;
const ADMIN_PW = 'It-Initial-Admin-1';
const CSRF = { 'x-capi-navigator': '1' };

if (!process.env.KUBECONFIG?.endsWith('kind-capi-navigator.yaml')) {
  throw new Error(
    'Refusing to run: KUBECONFIG must point to the local kind cluster (pnpm test:int)',
  );
}

async function startApp(): Promise<NestExpressApplication> {
  const config = loadConfig({
    ...process.env,
    NAVIGATOR_NAMESPACE: NAMESPACE,
    INITIAL_ADMIN_PASSWORD: ADMIN_PW,
    LOG_JSON: 'false',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  configureApp(app, config);
  await app.init();
  return app;
}

function sessionCookie(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) throw new Error('no session cookie');
  return cookie.split(';')[0]!;
}

describe('FP-1 acceptance against kind', () => {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);
  let app: NestExpressApplication;
  let adminCookie: string;

  beforeAll(async () => {
    await core.createNamespace({ body: { metadata: { name: NAMESPACE } } });
    app = await startApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await core.deleteNamespace({ name: NAMESPACE }).catch(() => undefined);
  });

  it('the initial admin can log in, change the password and create a viewer and an operator', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'admin', password: ADMIN_PW })
      .expect(200);
    expect(first.body.mustChangePassword).toBe(true);

    const changed = await request(app.getHttpServer())
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', sessionCookie(first))
      .send({ currentPassword: ADMIN_PW, newPassword: 'It-Admin-Changed-1' })
      .expect(200);
    adminCookie = sessionCookie(changed);

    for (const [username, role] of [
      ['it-viewer', 'viewer'],
      ['it-operator', 'operator'],
    ]) {
      await request(app.getHttpServer())
        .post('/api/users')
        .set(CSRF)
        .set('Cookie', adminCookie)
        .send({ username, role, password: 'It-Temp-Password-1' })
        .expect(201);
    }
  });

  it('stores users only as NavigatorUser resources and Secrets in the home cluster', async () => {
    const store = app.get(StoreService);
    const { items } = await store.users.list();
    expect(items.map((u) => u.metadata.name).sort()).toEqual(['admin', 'it-operator', 'it-viewer']);
    const secrets = await core.listNamespacedSecret({ namespace: NAMESPACE });
    const names = secrets.items.map((s) => s.metadata?.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'capi-navigator-session-key',
        'navigator-user-admin-password',
        'navigator-user-it-viewer-password',
      ]),
    );
  });

  it('keeps users and sessions after a backend restart', async () => {
    await app.close();
    app = await startApp();
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(me.body).toEqual({ username: 'admin', role: 'admin', mustChangePassword: false });
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'it-viewer', password: 'It-Temp-Password-1' })
      .expect(200);
  }, 60_000);

  it('returns 401 without a session and 403 for a viewer on mutating endpoints', async () => {
    await request(app.getHttpServer()).get('/api/users').expect(401);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'it-viewer', password: 'It-Temp-Password-1' })
      .expect(200);
    const changed = await request(app.getHttpServer())
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', sessionCookie(login))
      .send({ currentPassword: 'It-Temp-Password-1', newPassword: 'It-Viewer-Password-1' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/users')
      .set(CSRF)
      .set('Cookie', sessionCookie(changed))
      .send({ username: 'nope', role: 'viewer', password: 'It-Temp-Password-1' })
      .expect(403);
  });

  it('wrote an AuditEvent for every mutating action', async () => {
    const store = app.get(StoreService);
    const { items } = await store.auditEvents.list();
    const actions = items.map((e) => `${e.spec.actor}:${e.spec.action}:${e.spec.outcome}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        'admin:auth.login:success',
        'admin:auth.change-password:success',
        'admin:user.create:success',
        'it-viewer:auth.login:success',
        'it-viewer:auth.change-password:success',
      ]),
    );
    expect(actions.filter((a) => a === 'admin:user.create:success')).toHaveLength(2);
  });
});
