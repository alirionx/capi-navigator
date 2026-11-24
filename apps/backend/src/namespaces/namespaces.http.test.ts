import type { KubernetesObject, V1Secret } from '@kubernetes/client-node';
import { ConflictException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  FLAVOR_PLUGINS,
  ManagedNamespaceSpecSchema,
  managedNamespaceObjects,
  NAMESPACE_PROFILE_QUOTAS,
  namespaceAddonName,
  singleClusterSelector,
  type ManagedNamespaceSpecInput,
} from '@capi-navigator/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SESSION_COOKIE } from '../auth/session.service.js';
import { ClustersService } from '../clusters/clusters.service.js';
import { APP_CONFIG, loadConfig } from '../config/config.js';
import { ConfigModule } from '../config/config.module.js';
import { configureApp } from '../configure-app.js';
import { AddonsService } from '../helm/addons.service.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { KubeModule } from '../kube/kube.module.js';
import { StoreModule } from '../store/store.module.js';
import { StoreService } from '../store/store.service.js';
import { createFakeStore } from '../testing/fake-store.js';
import { NamespacesController } from './namespaces.controller.js';
import { NamespacesService } from './namespaces.service.js';
import { objectKey, type WorkloadAccess } from './workload-access.js';

const ADMIN_PW = 'Initial-Admin-Pw-1';
const CSRF = { 'x-capi-navigator': '1' };
const TOKEN = 'eyJ-secret-token-of-the-workload-cluster';
const BASE = '/api/connections/home/clusters/team/prod/namespaces';

const spec = (over: Partial<ManagedNamespaceSpecInput> = {}) =>
  ManagedNamespaceSpecSchema.parse({
    name: 'team-a',
    namespace: 'team',
    clusterSelector: singleClusterSelector('prod'),
    quota: NAMESPACE_PROFILE_QUOTAS.small,
    accounts: [{ name: 'ci', role: 'edit' }],
    ...over,
  });

describe('managed namespaces over HTTP (FP-36)', () => {
  let app: NestExpressApplication;
  let fake: ReturnType<typeof createFakeStore>;
  let admin: string;
  let operator: string;
  let otherOperator: string;
  let viewer: string;
  const logs: string[] = [];

  // ---- state of the fake management and workload cluster
  let defined: ReturnType<typeof spec>[];
  let released: boolean;
  let stored: () => unknown;
  let live: Map<string, KubernetesObject>;
  let managed: string[];
  let terminating: string[];
  let existing: Record<string, Record<string, string>>;
  let secrets: V1Secret[];
  let calico: boolean;
  let tokenError: Error | undefined;
  let readError: Error | undefined;
  const deleted: string[] = [];

  const status = (s: ReturnType<typeof spec>) => ({
    name: namespaceAddonName(s),
    namespace: s.namespace,
    matchingClusters: ['prod'],
    releases: [{ name: 'r', cluster: 'prod', ready: released, conditions: [], status: 'deployed' }],
  });
  const addons = {
    namespaceAddons: vi.fn(async () => defined.map((s) => ({ spec: s, status: status(s) }))),
    matching: vi.fn(async () => ['prod']),
    planNamespace: vi.fn(
      async (_c: string, _s: unknown, blockers: string[], warnings: string[]) => ({
        preview: { diffs: [], drift: [], matchingClusters: ['prod'], warnings, blockers },
      }),
    ),
    applyNamespace: vi.fn(
      async (_c: string, _s: unknown, _t: boolean, blockers: string[], warnings: string[]) => {
        if (blockers.length) throw new ConflictException(blockers.join('; '));
        return { diffs: [], drift: [], matchingClusters: ['prod'], warnings, blockers };
      },
    ),
    delete: vi.fn(async () => undefined),
  };
  const clusters = {
    kubeconfig: vi.fn(async () => 'kubeconfig'),
    storedSpec: vi.fn(async () => stored()),
  };
  const access: WorkloadAccess = {
    server: 'https://prod.example.com:6443',
    caData: 'Q0E=',
    live: async () => {
      if (readError) throw readError;
      return live;
    },
    managedNamespaces: async () =>
      managed.map((name) => ({ name, terminating: terminating.includes(name) })),
    namespace: async (n) =>
      existing[n] && { labels: existing[n], terminating: terminating.includes(n) },
    hasCalico: async () => calico,
    tokenSecrets: async () => secrets,
    createTokenSecret: async (s) => {
      const created = { ...s, metadata: { ...s.metadata, uid: `uid-${secrets.length}` } };
      secrets = [...secrets, created];
      return created;
    },
    deleteTokenSecret: async (name) => {
      deleted.push(name);
      secrets = secrets.filter((s) => s.metadata!.name !== name);
    },
    issueToken: vi.fn(async () => {
      if (tokenError) throw tokenError;
      return { token: TOKEN, expiresAt: '2026-12-01T00:00:00.000Z' };
    }),
    deleteNamespace: async (n) => void deleted.push(`Namespace/${n}`),
    deleteTier: async (n) => void deleted.push(`Tier/${n}`),
  };

  const http = () => request(app.getHttpServer());
  const cookieFrom = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
      .split(';')[0]!;
  const send = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    cookie: string,
    body?: object,
  ) => {
    const r = http()[method](`${BASE}${path}`).set(CSRF).set('Cookie', cookie);
    return body ? r.send(body) : r;
  };
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
    await http()
      .post('/api/users')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ username, bindings, password: 'Temp-Password-1' })
      .expect(201);
    return activate(username, 'Temp-Password-1');
  }

  beforeAll(async () => {
    fake = createFakeStore();
    const config = loadConfig({ INITIAL_ADMIN_PASSWORD: ADMIN_PW, LOG_JSON: 'false' });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, KubeModule, StoreModule, AuditModule, AuthModule],
      controllers: [NamespacesController],
      providers: [
        NamespacesService,
        { provide: ClustersService, useValue: clusters },
        { provide: AddonsService, useValue: addons },
      ],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(StoreService)
      .useValue(fake.store)
      .overrideProvider(KubeClientFactory)
      .useValue({ homeCluster: () => ({ makeApiClient: () => ({}) }) })
      .compile();
    const record = (...args: unknown[]) => void logs.push(JSON.stringify(args));
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: { log: record, error: record, warn: record, debug: record, verbose: record },
    });
    configureApp(app, config);
    await app.init();
    moduleRef.get(NamespacesService).access = () => access;
    admin = await activate('admin', ADMIN_PW);
    const limited = (namespaces: string[]) => [
      { role: 'operator', connections: ['home'], namespaces },
    ];
    operator = await createUser('team-op', limited(['team']));
    otherOperator = await createUser('other-op', limited(['elsewhere']));
    viewer = await createUser('reader', [{ role: 'viewer' }]);
  });
  afterAll(() => app?.close());

  beforeEach(() => {
    defined = [spec()];
    released = true;
    stored = () => ({ kubernetes: { flavor: 'rke2' } });
    live = new Map(managedNamespaceObjects(spec()).map((o) => [objectKey(o), o]));
    managed = ['team-a'];
    terminating = [];
    existing = { 'team-a': { 'capi-navigator.io/namespace': 'team-a' } };
    secrets = [];
    calico = true;
    tokenError = undefined;
    readError = undefined;
    deleted.length = 0;
    vi.clearAllMocks();
  });

  describe('permissions (FP36-F-12)', () => {
    it('lets viewers read and nothing else, operators act only in their scope', async () => {
      await send('get', '', viewer).expect(200);
      const calls: ['post' | 'put' | 'delete', string, object?][] = [
        ['post', '/preview', { spec: spec() }],
        ['put', '/team-a', { spec: spec() }],
        ['delete', '/team-a'],
        ['post', '/team-a/delete', { confirmName: 'team-a' }],
        ['post', '/team-a/accounts/ci/tokens', {}],
        ['delete', '/team-a/tokens/token-1'],
      ];
      for (const [method, path, body] of calls) {
        for (const cookie of [viewer, otherOperator]) {
          await send(method, path, cookie, body).expect(403);
        }
      }
      await send('put', '/team-a', operator, { spec: spec() }).expect(200);
    });

    it('refuses a body for another namespace than the one that was checked', async () => {
      const body = { spec: spec({ namespace: 'elsewhere' }) };
      await send('post', '/preview', operator, body).expect(400);
      await send('put', '/team-a', operator, body).expect(400);
      await send('put', '/team-b', operator, { spec: spec() }).expect(400);
      expect(addons.applyNamespace).not.toHaveBeenCalled();
    });
  });

  describe('list (FP36-F-11)', () => {
    it('shows accounts, quota usage and no drift on fresh objects', async () => {
      const quota = live.get('ResourceQuota/team-a/capi-navigator')!;
      live.set('ResourceQuota/team-a/capi-navigator', {
        ...quota,
        status: { hard: { pods: '20' }, used: { pods: '3' } },
      } as KubernetesObject);
      const { body } = await send('get', '', viewer).expect(200);
      expect(body.namespaces).toMatchObject([
        {
          name: 'team-a',
          exists: true,
          leftOver: false,
          drift: [],
          quota: [{ resource: 'pods', used: '3', hard: '20' }],
          accounts: [{ name: 'ci', role: 'edit', exists: true }],
          addon: { ready: true },
        },
      ]);
    });

    it('shows changed and missing objects as drift, but not while the release installs', async () => {
      live.delete('LimitRange/team-a/capi-navigator');
      const quota = structuredClone(
        live.get('ResourceQuota/team-a/capi-navigator')!,
      ) as unknown as {
        spec: { hard: Record<string, string> };
      };
      quota.spec.hard.pods = '99';
      live.set('ResourceQuota/team-a/capi-navigator', quota as unknown as KubernetesObject);
      const { body } = await send('get', '', viewer).expect(200);
      expect(body.namespaces[0].drift).toEqual([
        {
          kind: 'ResourceQuota',
          name: 'capi-navigator',
          missing: false,
          fields: ['spec.hard.pods'],
        },
        { kind: 'LimitRange', name: 'capi-navigator', missing: true, fields: [] },
      ]);
      released = false;
      const installing = await send('get', '', viewer).expect(200);
      expect(installing.body.namespaces[0]).toMatchObject({ drift: [], addon: { ready: false } });
    });

    it('shows namespaces left over from removed add-ons (FP36-F-04)', async () => {
      defined = [];
      const { body } = await send('get', '', viewer).expect(200);
      expect(body.namespaces).toMatchObject([{ name: 'team-a', leftOver: true }]);
    });

    it('answers from the add-ons when the cluster cannot be read', async () => {
      readError = new Error('connection refused');
      const { body } = await send('get', '', viewer).expect(200);
      expect(body).toMatchObject({
        unreachable: 'connection refused',
        namespaces: [{ name: 'team-a', exists: false, drift: [] }],
      });
    });
  });

  describe('checks before creating (FP36-F-03a, F-13, F-14)', () => {
    const blockers = async () =>
      (await send('post', '/preview', operator, { spec: spec() }).expect(200)).body
        .blockers as string[];

    it('passes for a suitable cluster', async () => expect(await blockers()).toEqual([]));

    it('refuses clusters from a blueprint and clusters the app did not create', async () => {
      stored = () => ({ kubernetes: { flavor: 'rke2' }, blueprint: 'small' });
      expect((await blockers())[0]).toContain('blueprint small');
      stored = () => {
        throw new ConflictException('created outside CAPI Navigator');
      };
      expect((await blockers())[0]).toContain('created outside');
      expect((await send('get', '', viewer)).body.unsupported).toContain('created outside');
    });

    it('refuses clusters without the Calico resources', async () => {
      calico = false;
      expect((await blockers())[0]).toContain('Calico resources');
    });

    it('refuses a namespace that exists and is not managed', async () => {
      existing = { 'team-a': { team: 'x' } };
      expect((await blockers())[0]).toContain('already exists and is not managed');
    });

    it('refuses a namespace that is being deleted, and shows it as such', async () => {
      terminating = ['team-a'];
      expect((await blockers())[0]).toContain('is being deleted');
      defined = [];
      const { body } = await send('get', '', viewer).expect(200);
      expect(body.namespaces).toMatchObject([{ name: 'team-a', terminating: true }]);
    });

    it('refuses clusters whose distribution has another CNI (FP36-F-03a)', async () => {
      const plugin = FLAVOR_PLUGINS.rke2!;
      const cni = plugin.cni;
      try {
        plugin.cni = 'other';
        expect((await blockers())[0]).toContain('needs Calico');
        expect((await send('get', '', viewer)).body.unsupported).toContain('needs Calico');
        await send('put', '/team-a', operator, { spec: spec() }).expect(409);
      } finally {
        plugin.cni = cni;
      }
    });

    it('refuses a second definition that can match the same cluster', async () => {
      defined = [spec({ clusterSelector: { env: 'prod' } })];
      expect((await blockers())[0]).toContain('is already defined by');
    });

    it('does not apply while a check fails', async () => {
      calico = false;
      await send('put', '/team-a', operator, { spec: spec() }).expect(409);
    });
  });

  describe('removal (FP36-F-04, F-05)', () => {
    it('ends the access by removing the add-on only', async () => {
      await send('delete', '/team-a', operator).expect(204);
      expect(addons.delete).toHaveBeenCalledWith('home', 'team', namespaceAddonName(spec()));
      expect(deleted).toEqual([]);
    });

    it('deletes a left-over namespace with its tier, only with the name typed', async () => {
      await send('post', '/team-a/delete', operator, { confirmName: 'team-a' }).expect(409);
      defined = [];
      await send('post', '/team-a/delete', operator, { confirmName: 'team' }).expect(400);
      managed = [];
      await send('post', '/kube-system/delete', operator, { confirmName: 'kube-system' }).expect(
        404,
      );
      expect(deleted).toEqual([]);
      managed = ['team-a'];
      await send('post', '/team-a/delete', operator, { confirmName: 'team-a' }).expect(204);
      expect(deleted).toEqual(['Namespace/team-a', 'Tier/capi-navigator-team-a']);
    });
  });

  describe('tokens (FP36-F-08 to F-10)', () => {
    const issue = (body: object = {}, account = 'ci') =>
      send('post', `/team-a/accounts/${account}/tokens`, operator, body);

    it('returns a kubeconfig once, bound to a Secret of its own, without caching', async () => {
      const res = await issue().expect(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        format: 'kubeconfig',
        fileName: 'prod-team-a-ci.kubeconfig',
        expiresAt: '2026-12-01T00:00:00.000Z',
      });
      expect(res.body.content).toContain(`token: ${TOKEN}`);
      expect(res.body.content).toContain('server: https://prod.example.com:6443');
      expect(res.body.content).toContain('namespace: team-a');
      expect(access.issueToken).toHaveBeenCalledWith(
        'team-a.ci',
        { name: res.body.id, uid: 'uid-0' },
        7 * 86_400,
      );
      expect(secrets[0]).toMatchObject({
        metadata: {
          namespace: 'capi-navigator-accounts',
          annotations: {
            'capi-navigator.io/account': 'ci',
            'capi-navigator.io/created-by': 'team-op',
          },
        },
      });
      expect(secrets[0]!.data ?? secrets[0]!.stringData).toBeUndefined();
      expect((await issue({ format: 'token' }).expect(201)).body.content).toBe(TOKEN);
    });

    it('never puts the token into logs, audit events or other responses', async () => {
      await issue().expect(201);
      const list = await send('get', '', admin).expect(200);
      expect(list.body.namespaces[0].tokens).toMatchObject([
        { account: 'ci', createdBy: 'team-op', expired: false },
      ]);
      expect(JSON.stringify(list.body)).not.toContain(TOKEN);
      expect(JSON.stringify(fake.auditEvents)).not.toContain(TOKEN);
      expect(logs.join()).not.toContain(TOKEN);
      const event = fake.auditEvents
        .filter((e) => e.spec.action === 'namespace.token-issue')
        .at(-1);
      expect(event?.spec).toMatchObject({
        actor: 'team-op',
        outcome: 'success',
        target: { kind: 'ServiceAccount', name: 'ci' },
      });
    });

    it('refuses lifetimes outside 10 minutes to 7 days and unknown accounts', async () => {
      for (const lifetimeSeconds of [599, 7 * 86_400 + 1, 1.5]) {
        await issue({ lifetimeSeconds }).expect(400);
      }
      await issue({ lifetimeSeconds: 600 }).expect(201);
      await issue({}, 'nobody').expect(404);
      await send('post', '/other/accounts/ci/tokens', operator, {}).expect(404);
    });

    it('leaves no Secret behind when the token is refused, and removes expired ones', async () => {
      tokenError = Object.assign(new Error('forbidden'), { code: 403 });
      expect((await issue()).status).toBeGreaterThanOrEqual(400);
      expect(secrets).toEqual([]);
      tokenError = undefined;
      const { body } = await issue().expect(201);
      secrets[0]!.metadata!.annotations!['capi-navigator.io/expires-at'] = '2020-01-01T00:00:00Z';
      await issue().expect(201);
      expect(deleted).toContain(body.id);
      expect(secrets).toHaveLength(1);
    });

    it('revokes one token and only tokens of the namespace', async () => {
      const { body } = await issue().expect(201);
      await issue().expect(201);
      await send('delete', `/team-b/tokens/${body.id}`, operator).expect(404);
      await send('delete', '/team-a/tokens/sh.helm.release.v1.ns-team-a.v1', operator).expect(404);
      await send('delete', `/team-a/tokens/${body.id}`, operator).expect(204);
      expect(secrets).toHaveLength(1);
    });
  });
});
