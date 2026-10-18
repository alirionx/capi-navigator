import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SESSION_COOKIE } from '../auth/session.service.js';
import { APP_CONFIG, loadConfig } from '../config/config.js';
import { ConfigModule } from '../config/config.module.js';
import { configureApp } from '../configure-app.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { KubeModule } from '../kube/kube.module.js';
import { StoreModule } from '../store/store.module.js';
import { StoreService } from '../store/store.service.js';
import { createFakeStore } from '../testing/fake-store.js';
import { HelmModule } from './helm.module.js';
import { HelmRepositoriesService } from './helm-repositories.service.js';

// The chart source talks to the internet; here it records what it gets.
const seen = vi.hoisted(() => ({ access: [] as unknown[] }));
vi.mock('./chart-source.js', () => ({
  ChartSource: class {
    async charts(access: unknown) {
      seen.access.push(access);
      return [{ name: 'podinfo', latestVersion: '6.15.0' }];
    }
    async versions() {
      return [{ version: '6.15.0' }];
    }
    async values() {
      return 'replicaCount: 1\n';
    }
    async test() {
      return { ok: true, message: 'ok' };
    }
  },
}));

const CSRF = { 'x-capi-navigator': '1' };
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

describe('Helm repositories API (FP8-F-02 to F-04)', () => {
  let app: NestExpressApplication;
  let fake: ReturnType<typeof createFakeStore>;
  let admin: string;
  let operator: string;
  let viewer: string;
  const http = () => request(app.getHttpServer());

  async function activate(username: string, initial: string): Promise<string> {
    const cookieOf = (res: request.Response) =>
      ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .find((c) => c.startsWith(SESSION_COOKIE))!
        .split(';')[0]!;
    const login = await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username, password: initial })
      .expect(200);
    const changed = await http()
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', cookieOf(login))
      .send({ currentPassword: initial, newPassword: `${initial}-new` })
      .expect(200);
    return cookieOf(changed);
  }

  beforeAll(async () => {
    fake = createFakeStore();
    const config = loadConfig({ INITIAL_ADMIN_PASSWORD: 'Admin-Pw-1', LOG_JSON: 'false' });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, KubeModule, StoreModule, AuditModule, AuthModule, HelmModule],
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
    admin = await activate('admin', 'Admin-Pw-1');
    for (const [username, role] of [
      ['olga', 'operator'],
      ['vera', 'viewer'],
    ]) {
      await http()
        .post('/api/users')
        .set(CSRF)
        .set('Cookie', admin)
        .send({ username, role, password: 'Some-Pw-123' })
        .expect(201);
    }
    operator = await activate('olga', 'Some-Pw-123');
    viewer = await activate('vera', 'Some-Pw-123');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('creates an OCI repository; credentials only in the Secret (hard rule 8)', async () => {
    const res = await http()
      .post('/api/helm-repositories')
      .set(CSRF)
      .set('Cookie', admin)
      .send({
        name: 'private',
        type: 'oci',
        url: 'oci://registry.example:5000/charts/',
        credentials: { username: 'robot', password: 'top-secret-pw' },
        caCertificate: PEM,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'private',
      url: 'oci://registry.example:5000/charts',
      hasCredentials: true,
      hasCaCertificate: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('top-secret-pw');
    expect(fake.secrets.get('helm-repository-private')).toEqual({
      username: 'robot',
      password: 'top-secret-pw',
      'ca.crt': PEM,
    });
    expect(JSON.stringify(fake.helmRepositories.get('private'))).not.toContain('top-secret-pw');
    expect(JSON.stringify(fake.auditEvents)).not.toContain('top-secret-pw');
    expect(fake.auditEvents.at(-1)!.spec.action).toBe('helm-repository.create');

    const list = await http().get('/api/helm-repositories').set('Cookie', viewer).expect(200);
    expect(JSON.stringify(list.body)).not.toContain('top-secret-pw');
  });

  it('builds the registry config for the Secret copies', async () => {
    const data = await app.get(HelmRepositoriesService).copyData('private');
    expect(JSON.parse(data!.configJson!)).toEqual({
      auths: { 'registry.example:5000': { auth: btoa('robot:top-secret-pw') } },
    });
    expect(data!.caCrt).toBe(PEM);
  });

  it('rejects credentials for HTTP repositories (CAAPH: OCI only)', async () => {
    await http()
      .post('/api/helm-repositories')
      .set(CSRF)
      .set('Cookie', admin)
      .send({
        name: 'web',
        type: 'http',
        url: 'https://charts.example',
        credentials: { username: 'a', password: 'b' },
      })
      .expect(400);
  });

  it('enforces the roles: viewers read, operators browse, admins manage (hard rule 9)', async () => {
    await http()
      .post('/api/helm-repositories')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ name: 'podinfo', type: 'http', url: 'https://stefanprodan.github.io/podinfo' })
      .expect(201);
    await http()
      .post('/api/helm-repositories')
      .set(CSRF)
      .set('Cookie', operator)
      .send({ name: 'x', type: 'http', url: 'https://x.example' })
      .expect(403);
    await http().get('/api/helm-repositories/podinfo/charts').set('Cookie', viewer).expect(403);
    const charts = await http()
      .get('/api/helm-repositories/podinfo/charts')
      .set('Cookie', operator)
      .expect(200);
    expect(charts.body[0].name).toBe('podinfo');
    const values = await http()
      .get('/api/helm-repositories/podinfo/values?chart=podinfo&version=6.15.0')
      .set('Cookie', operator)
      .expect(200);
    expect(values.body).toEqual({
      chart: 'podinfo',
      version: '6.15.0',
      values: 'replicaCount: 1\n',
    });
    await http()
      .delete('/api/helm-repositories/podinfo')
      .set(CSRF)
      .set('Cookie', operator)
      .expect(403);
  });

  it('passes the stored credentials to the chart source only in memory', async () => {
    seen.access.length = 0;
    await http().get('/api/helm-repositories/private/charts').set('Cookie', operator).expect(200);
    expect(seen.access[0]).toMatchObject({ username: 'robot', password: 'top-secret-pw', ca: PEM });
  });

  it('removes credentials on update and deletes the repository', async () => {
    const res = await http()
      .patch('/api/helm-repositories/private')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ credentials: null, caCertificate: null })
      .expect(200);
    expect(res.body).toMatchObject({ hasCredentials: false, hasCaCertificate: false });
    expect(fake.secrets.has('helm-repository-private')).toBe(false);
    expect(fake.helmRepositories.get('private')!.spec.credentialsRevision).toBe(1);
    await http()
      .delete('/api/helm-repositories/private')
      .set(CSRF)
      .set('Cookie', admin)
      .expect(204);
    await http().get('/api/helm-repositories/private').set('Cookie', viewer).expect(404);
  });
});
