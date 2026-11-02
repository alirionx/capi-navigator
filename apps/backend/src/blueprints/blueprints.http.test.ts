import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { ClusterSpec, ClusterSummary } from '@capi-navigator/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SESSION_COOKIE } from '../auth/session.service.js';
import { ClustersService } from '../clusters/clusters.service.js';
import { APP_CONFIG, loadConfig } from '../config/config.js';
import { ConfigModule } from '../config/config.module.js';
import { configureApp } from '../configure-app.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { KubeModule } from '../kube/kube.module.js';
import { StoreModule } from '../store/store.module.js';
import { StoreService } from '../store/store.service.js';
import { createFakeStore } from '../testing/fake-store.js';
import { BlueprintsController } from './blueprints.controller.js';
import { BlueprintsService } from './blueprints.service.js';

const ADMIN_PW = 'Initial-Admin-Pw-1';
const CSRF = { 'x-capi-navigator': '1' };

const cluster = {
  name: 'example',
  namespace: 'osb',
  labels: { addons: 'base' },
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'medium' },
    workerPools: [{ name: 'default', replicas: 2, machineSize: 'medium' }],
  },
  infrastructure: {
    provider: 'proxmox',
    credentialRef: 'homelab',
    sourceNode: 'homeserver',
    image: '7112',
    storage: 'local-zfs',
    bootDisk: 'virtio0',
    network: {
      nodeCidr: '10.20.0.0/24',
      gateway: '10.20.0.1',
      addresses: ['10.20.0.71-10.20.0.88'],
    },
    apiEndpoint: '10.20.0.89',
  },
};

const blueprint = (over: object = {}) => ({
  name: 'small',
  spec: {
    displayName: 'Small cluster',
    connection: 'home',
    cluster,
    parameters: {
      workerCounts: [{ pool: 'default', min: 1, max: 3 }],
      machineSizes: [{ pool: 'default', choices: ['medium', 'large'] }],
    },
    ...over,
  },
});

describe('cluster blueprints over HTTP (FP-34)', () => {
  let app: NestExpressApplication;
  let fake: ReturnType<typeof createFakeStore>;
  let admin: string;
  let operator: string;
  let otherOperator: string;
  let blockers: string[] = [];
  let existing: ClusterSummary[] = [];
  const created: { connection: string; spec: ClusterSpec }[] = [];
  const clusters = {
    preview: vi.fn(async () => ({ yaml: 'kind: Cluster', objects: [], warnings: [], blockers })),
    create: vi.fn(async (connection: string, spec: ClusterSpec) => {
      created.push({ connection, spec });
      return {
        name: spec.name,
        namespace: spec.namespace,
        blueprint: spec.blueprint,
      } as ClusterSummary;
    }),
    list: vi.fn(async () => existing),
  };
  const http = () => request(app.getHttpServer());
  const cookieFrom = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
      .split(';')[0]!;
  const send = (method: 'post' | 'put' | 'delete', path: string, cookie: string, body?: object) =>
    http()[method](path).set(CSRF).set('Cookie', cookie).send(body);

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
      controllers: [BlueprintsController],
      providers: [BlueprintsService, { provide: ClustersService, useValue: clusters }],
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
    operator = await createUser('osb-op', [
      { role: 'operator', connections: ['home'], namespaces: ['osb'] },
    ]);
    otherOperator = await createUser('team-op', [
      { role: 'operator', connections: ['home'], namespaces: ['team-a'] },
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    blockers = [];
    existing = [];
    created.length = 0;
  });

  it('saves a blueprint after the check and lists it with its parameter schema (FP34-F-03, F-04)', async () => {
    await send('post', '/api/blueprints', operator, blueprint()).expect(403);
    await send('post', '/api/blueprints', admin, blueprint()).expect(201);
    expect(clusters.preview).toHaveBeenLastCalledWith(
      'home',
      expect.objectContaining({ name: 'example' }),
      false,
    );
    const list = await http().get('/api/blueprints').set('Cookie', operator).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].parametersSchema.properties.workerPools.properties.default).toMatchObject({
      properties: { replicas: { minimum: 1, maximum: 3, default: 2 } },
    });
    await send('post', '/api/blueprints', admin, blueprint()).expect(409);
  });

  it('refuses saving while the check fails (FP34-F-04)', async () => {
    blockers = ['Credential "homelab" may not be used in namespace osb.'];
    const res = await send('post', '/api/blueprints', admin, { ...blueprint(), name: 'blocked' });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('may not be used');
    blockers = [];
    await send('post', '/api/blueprints', admin, {
      name: 'old',
      spec: {
        ...blueprint().spec,
        parameters: { kubernetesVersions: ['v1.35.9+rke2r1', 'v1.30.0+rke2r1'] },
      },
    }).expect(400);
    await send('post', '/api/blueprints', admin, {
      name: 'bad',
      spec: {
        ...blueprint().spec,
        parameters: { workerCounts: [{ pool: 'gpu', min: 1, max: 2 }] },
      },
    }).expect(400);
  });

  it('creates a cluster in the blueprint namespace without a preview (FP34-F-05)', async () => {
    const res = await send('post', '/api/blueprints/small/clusters', operator, {
      name: 'ordered',
      parameters: { workerPools: { default: { replicas: 3, machineSize: 'large' } } },
      labels: { 'osb.example.com/instance-id': 'abc' },
    }).expect(201);
    expect(res.body).toMatchObject({ name: 'ordered', blueprint: 'small' });
    expect(created).toHaveLength(1);
    expect(created[0]!.connection).toBe('home');
    expect(created[0]!.spec).toMatchObject({
      name: 'ordered',
      namespace: 'osb',
      blueprint: 'small',
      labels: { addons: 'base', 'osb.example.com/instance-id': 'abc' },
      topology: { workerPools: [{ name: 'default', replicas: 3, machineSize: 'large' }] },
    });
    const audit = fake.auditEvents.find((e) => e.spec.action === 'cluster.create-from-blueprint');
    expect(audit?.spec).toMatchObject({
      actor: 'osb-op',
      outcome: 'success',
      target: { kind: 'Cluster', name: 'ordered' },
      request: { path: '/api/blueprints/small/clusters' },
    });
  });

  it('checks the permission in the blueprint namespace and the parameters (FP34-F-05)', async () => {
    await send('post', '/api/blueprints/small/clusters', otherOperator, { name: 'x' }).expect(403);
    await send('post', '/api/blueprints/missing/clusters', operator, { name: 'x' }).expect(404);
    for (const body of [
      { name: 'x', parameters: { workerPools: { default: { replicas: 4 } } } },
      { name: 'x', parameters: { controlPlane: { replicas: 3 } } },
      { name: 'x', labels: { addons: 'none' } },
      { name: 'X_bad' },
    ]) {
      await send('post', '/api/blueprints/small/clusters', operator, body).expect(400);
    }
    expect(created).toHaveLength(0);
  });

  it('replaces the blueprint as a whole (FP34-F-08)', async () => {
    const res = await send('put', '/api/blueprints/small', admin, {
      spec: { ...blueprint().spec, displayName: 'Small', parameters: {} },
    }).expect(200);
    expect(res.body.spec.parameters).toEqual({ workerCounts: [], machineSizes: [] });
    expect(fake.blueprints.get('small')!.spec.parameters).toEqual({
      workerCounts: [],
      machineSizes: [],
    });
    expect(res.body.parametersSchema.properties).toEqual({});
  });

  it('refuses deleting a blueprint that clusters use (FP34-F-09)', async () => {
    existing = [
      { name: 'ordered', namespace: 'osb', blueprint: 'small' } as ClusterSummary,
      { name: 'other', namespace: 'osb' } as ClusterSummary,
    ];
    const res = await send('delete', '/api/blueprints/small', admin).expect(409);
    expect(res.body.hint).toContain('osb/ordered');
    expect(res.body.hint).not.toContain('osb/other');
    const used = await http()
      .get('/api/blueprints/small/clusters')
      .set('Cookie', operator)
      .expect(200);
    expect(used.body.map((c: ClusterSummary) => c.name)).toEqual(['ordered']);
    existing = [];
    await send('delete', '/api/blueprints/small', operator).expect(403);
    await send('delete', '/api/blueprints/small', admin).expect(204);
    await http().get('/api/blueprints/small').set('Cookie', admin).expect(404);
  });
});
