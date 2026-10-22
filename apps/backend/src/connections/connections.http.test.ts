import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { ConnectionsModule } from './connections.module.js';

// The real connection test needs a cluster; here it returns a fixed result per server.
const testConnection = vi.hoisted(() => vi.fn());
vi.mock('./connection-tester.js', () => ({ testConnection }));

const CSRF = { 'x-capi-navigator': '1' };
const KUBECONFIG = `
apiVersion: v1
kind: Config
current-context: dev
clusters:
  - name: dev
    cluster: { server: 'https://dev.example:6443', certificate-authority-data: Q0E= }
  - name: prod
    cluster: { server: 'https://prod.example:6443' }
users:
  - name: dev
    user: { token: dev-secret-token }
  - name: prod
    user: { token: prod-secret-token }
contexts:
  - name: dev
    context: { cluster: dev, user: dev }
  - name: prod
    context: { cluster: prod, user: prod }
`;

describe('connections API (FP-2)', () => {
  let app: NestExpressApplication;
  let fake: ReturnType<typeof createFakeStore>;
  let admin: string;
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
      imports: [ConfigModule, KubeModule, StoreModule, AuditModule, AuthModule, ConnectionsModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(StoreService)
      .useValue(fake.store)
      .overrideProvider(KubeClientFactory)
      .useValue({
        homeCluster: () => ({
          makeApiClient: () => ({}),
          getCurrentCluster: () => ({ server: 'https://home.example:6443' }),
        }),
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app, config);
    await app.init();
    admin = await activate('admin', 'Admin-Pw-1');
    await http()
      .post('/api/users')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ username: 'vera', role: 'viewer', password: 'Viewer-Pw-1' })
      .expect(201);
    viewer = await activate('vera', 'Viewer-Pw-1');
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    testConnection.mockReset();
    testConnection.mockImplementation(async (kc: { getCurrentCluster(): { server: string } }) => ({
      phase: 'Reachable',
      kubernetesVersion: 'v1.34.0',
      lastCheckedAt: '2026-10-17T00:00:00.000Z',
      details: `tested ${kc.getCurrentCluster().server}`,
    }));
  });

  it('lists kubeconfig contexts without credentials', async () => {
    const res = await http()
      .post('/api/connections/kubeconfig-contexts')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ kubeconfig: KUBECONFIG })
      .expect(200);
    expect(res.body.contexts.map((c: { name: string }) => c.name)).toEqual(['dev', 'prod']);
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
  });

  it('creates a kubeconfig connection, stores only the chosen context and tests it', async () => {
    const res = await http()
      .post('/api/connections')
      .set(CSRF)
      .set('Cookie', admin)
      .send({
        name: 'prod',
        displayName: 'Production',
        credentials: { authType: 'kubeconfig', kubeconfig: KUBECONFIG, context: 'prod' },
      })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'prod',
      displayName: 'Production',
      authType: 'kubeconfig',
      server: 'https://prod.example:6443',
      context: 'prod',
      status: { phase: 'Reachable', details: 'tested https://prod.example:6443' },
    });
    const stored = fake.secrets.get('management-cluster-prod-credentials')!.kubeconfig!;
    expect(stored).toContain('prod-secret-token');
    expect(stored).not.toContain('dev-secret-token');
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
  });

  it('creates a token connection', async () => {
    const res = await http()
      .post('/api/connections')
      .set(CSRF)
      .set('Cookie', admin)
      .send({
        name: 'token-conn',
        credentials: {
          authType: 'token',
          server: 'https://token.example:6443',
          token: 'abc-secret',
          caCert: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----',
        },
      })
      .expect(201);
    expect(res.body).toMatchObject({ authType: 'token', server: 'https://token.example:6443' });
    expect(fake.secrets.get('management-cluster-token-conn-credentials')?.kubeconfig).toContain(
      'certificate-authority-data',
    );
  });

  it('validates input with the shared schema', async () => {
    const res = await http()
      .post('/api/connections')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ name: 'x', credentials: { authType: 'token', server: 'http://insecure', token: '' } })
      .expect(400);
    expect(Object.keys(res.body.fieldErrors)).toEqual(
      expect.arrayContaining(['name', 'credentials.server', 'credentials.token']),
    );
  });

  it('rejects exec-based kubeconfigs with a hint (FP-2 decision)', async () => {
    const res = await http()
      .post('/api/connections')
      .set(CSRF)
      .set('Cookie', admin)
      .send({
        name: 'eks',
        credentials: {
          authType: 'kubeconfig',
          kubeconfig: KUBECONFIG.replace(
            '{ token: dev-secret-token }',
            '{ exec: { command: aws } }',
          ),
        },
      })
      .expect(400);
    expect(res.body.message).toMatch(/exec plugin/);
    expect(res.body.hint).toMatch(/token/i);
    expect(fake.connections.has('eks')).toBe(false);
  });

  it('allows the home cluster only once (FP2-F-03)', async () => {
    const res = await http()
      .post('/api/connections')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ name: 'home', credentials: { authType: 'in-cluster' } })
      .expect(201);
    expect(res.body).toMatchObject({ authType: 'in-cluster', server: 'https://home.example:6443' });
    await http()
      .post('/api/connections')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ name: 'home2', credentials: { authType: 'in-cluster' } })
      .expect(409);
  });

  it('rejects duplicate names', async () => {
    await http()
      .post('/api/connections')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ name: 'prod', credentials: { authType: 'in-cluster' } })
      .expect(409);
  });

  it('updates the display name without touching the credentials', async () => {
    const res = await http()
      .patch('/api/connections/prod')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ displayName: 'Prod EU' })
      .expect(200);
    expect(res.body.displayName).toBe('Prod EU');
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('sets and resets the chart source of the manifest add-ons (FP30-F-02)', async () => {
    const patch = (body: object) =>
      http().patch('/api/connections/prod').set(CSRF).set('Cookie', admin).send(body);
    const unknown = await patch({ manifestChartRepository: 'mirror' }).expect(400);
    expect(unknown.body.message).toBe('Helm repository mirror not found');
    fake.helmRepositories.set('mirror', {
      apiVersion: 'navigator.capi-navigator.io/v1alpha1',
      kind: 'HelmRepository',
      metadata: { name: 'mirror' },
      spec: {
        type: 'oci',
        url: 'oci://registry.example.com/charts',
        insecureSkipTLSVerify: false,
        hasCredentials: false,
        hasCaCertificate: false,
        credentialsRevision: 0,
      },
    });
    const set = await patch({ manifestChartRepository: 'mirror' }).expect(200);
    expect(set.body.manifestChartRepository).toBe('mirror');
    const reset = await patch({ manifestChartRepository: null }).expect(200);
    expect(reset.body.manifestChartRepository).toBeUndefined();
    expect(testConnection).not.toHaveBeenCalled();
    fake.helmRepositories.delete('mirror');
  });

  it('replaces credentials, bumps the revision and re-tests', async () => {
    const before = fake.connections.get('prod')!.spec.credentialsRevision;
    const res = await http()
      .patch('/api/connections/prod')
      .set(CSRF)
      .set('Cookie', admin)
      .send({
        credentials: { authType: 'token', server: 'https://new.example:6443', token: 'new-token' },
      })
      .expect(200);
    expect(res.body).toMatchObject({ authType: 'token', server: 'https://new.example:6443' });
    expect(res.body.context).toBeUndefined();
    expect(fake.connections.get('prod')!.spec.credentialsRevision).toBe(before + 1);
    expect(res.body.status.details).toBe('tested https://new.example:6443');
  });

  it('stores the test result in the status (FP2-F-04)', async () => {
    testConnection.mockResolvedValueOnce({
      phase: 'Unauthorized',
      message: 'The cluster rejected the credentials',
      hint: 'Create a new token',
      lastCheckedAt: '2026-10-17T01:00:00.000Z',
    });
    const res = await http()
      .post('/api/connections/prod/test')
      .set(CSRF)
      .set('Cookie', admin)
      .expect(200);
    expect(res.body.status).toEqual({
      phase: 'Unauthorized',
      message: 'The cluster rejected the credentials',
      hint: 'Create a new token',
      lastCheckedAt: '2026-10-17T01:00:00.000Z',
    });
  });

  it('lets viewers read but not change connections (FP-1 roles)', async () => {
    const list = await http().get('/api/connections').set('Cookie', viewer).expect(200);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(['prod', 'token-conn', 'home']),
    );
    await http().get('/api/connections/prod').set('Cookie', viewer).expect(200);
    await http().post('/api/connections/prod/test').set(CSRF).set('Cookie', viewer).expect(403);
    await http().delete('/api/connections/prod').set(CSRF).set('Cookie', viewer).expect(403);
    await http().get('/api/connections/access-manifest').set('Cookie', viewer).expect(403);
  });

  it('serves the access manifests (FP2-F-07)', async () => {
    const full = await http()
      .get('/api/connections/access-manifest')
      .set('Cookie', admin)
      .expect(200);
    expect(full.headers['content-type']).toContain('application/yaml');
    expect(full.text).toContain('name: cluster-admin');
    const minimal = await http()
      .get('/api/connections/access-manifest?variant=minimal')
      .set('Cookie', admin)
      .expect(200);
    expect(minimal.text).toContain('name: capi-navigator-operate');
  });

  it('deletes a connection together with its Secret and audits it', async () => {
    await http().delete('/api/connections/token-conn').set(CSRF).set('Cookie', admin).expect(204);
    expect(fake.connections.has('token-conn')).toBe(false);
    expect(fake.secrets.has('management-cluster-token-conn-credentials')).toBe(false);
    await http().get('/api/connections/token-conn').set('Cookie', admin).expect(404);

    const audit = fake.auditEvents.map((e) => `${e.spec.action}:${e.spec.managementCluster ?? ''}`);
    expect(audit).toEqual(
      expect.arrayContaining([
        'connection.create:prod',
        'connection.update:prod',
        'connection.test:prod',
        'connection.delete:token-conn',
      ]),
    );
    expect(audit.some((a) => a.startsWith('connection.parse-kubeconfig'))).toBe(false);
  });
});
