import type { KubernetesObject, V1Secret } from '@kubernetes/client-node';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ManagedNamespaceSpecSchema,
  managedNamespaceObjects,
  MAX_TOKENS_PER_PERSON,
  NAMESPACE_PROFILE_QUOTAS,
  NAMESPACE_USER_ROLE,
  namespaceAddonName,
  singleClusterSelector,
  type ManagedNamespaceSpec,
  type NamespacePerson,
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
import { MyNamespacesController } from './my-namespaces.controller.js';
import { MyNamespacesService } from './my-namespaces.service.js';
import { NamespacesController } from './namespaces.controller.js';
import { NamespacesService } from './namespaces.service.js';
import { PeopleService } from './people.service.js';
import { objectKey, type WorkloadAccess } from './workload-access.js';

const ADMIN_PW = 'Initial-Admin-Pw-1';
const CSRF = { 'x-capi-navigator': '1' };
const TOKEN = 'eyJ-secret-token-of-the-workload-cluster';
const MINE = '/api/my/namespaces';
const OWNER = '/api/connections/home/clusters/team/prod/namespaces';

const EMPTY = {
  pods: [],
  deployments: [],
  statefulSets: [],
  daemonSets: [],
  jobs: [],
  events: [],
};
const KUBECONFIG = JSON.stringify({
  apiVersion: 'v1',
  kind: 'Config',
  clusters: [{ name: 'c', cluster: { server: 'https://prod.example.com:6443' } }],
  users: [{ name: 'admin', user: {} }],
  contexts: [{ name: 'x', context: { cluster: 'c', user: 'admin' } }],
  'current-context': 'x',
});

describe('self-service of namespace users over HTTP (FP-37)', () => {
  let app: NestExpressApplication;
  let fake: ReturnType<typeof createFakeStore>;
  let admin: string;
  let viewer: string;
  let service: NamespacesService;
  let max: string;
  let eva: string;
  let nobody: string;
  const logs: string[] = [];

  let defined: Record<string, ManagedNamespaceSpec[]>;
  let brokenConnections: string[];
  let readError: Error | undefined;
  let secrets: V1Secret[];

  const person = (name: string): NamespacePerson => ({
    kind: 'user',
    name,
    uid: fake.store.userCache.get(name)!.metadata.uid!,
  });
  const spec = (name: string, people: Record<string, NamespacePerson[]>, cluster = 'prod') =>
    ManagedNamespaceSpecSchema.parse({
      name,
      namespace: 'team',
      clusterSelector: singleClusterSelector(cluster),
      quota: NAMESPACE_PROFILE_QUOTAS.small,
      accounts: Object.entries(people).map(([n, p]) => ({ name: n, role: 'edit', people: p })),
    });

  const addons = {
    namespaceAddons: vi.fn(async (connection: string, namespace?: string) => {
      if (brokenConnections.includes(connection)) throw new Error('secret-host refused');
      return (defined[connection] ?? [])
        .filter((s) => namespace === undefined || s.namespace === namespace)
        .map((s) => ({
          spec: s,
          status: {
            name: namespaceAddonName(s),
            namespace: s.namespace,
            matchingClusters: Object.values(s.clusterSelector),
            releases: Object.values(s.clusterSelector).map((c) => ({
              name: 'r',
              cluster: c,
              ready: true,
              conditions: [],
              status: 'deployed',
            })),
          },
        }));
    }),
  };
  const access: WorkloadAccess = {
    server: 'https://prod.example.com:6443',
    caData: 'Q0E=',
    live: async (expected) => {
      if (readError) throw readError;
      return new Map(
        expected.map((o) => [
          objectKey(o),
          {
            ...o,
            ...(o.kind === 'ResourceQuota'
              ? { status: { hard: { pods: '20' }, used: { pods: '3' } } }
              : {}),
          } as KubernetesObject,
        ]),
      );
    },
    managedNamespaces: async () => [{ name: 'team-a', terminating: false }],
    namespace: async () => undefined,
    hasCalico: async () => true,
    // An answer takes a moment, so concurrent requests really overlap.
    tokenSecrets: async () => {
      const answer = secrets;
      await new Promise((r) => setTimeout(r, 20));
      return answer;
    },
    createTokenSecret: async (s) => {
      const created = { ...s, metadata: { ...s.metadata, uid: `uid-${secrets.length}` } };
      secrets = [...secrets, created];
      return created;
    },
    deleteTokenSecret: async (name) => {
      secrets = secrets.filter((s) => s.metadata!.name !== name);
    },
    issueToken: vi.fn(async () => ({ token: TOKEN, expiresAt: '2026-12-01T00:00:00.000Z' })),
    deleteNamespace: async () => undefined,
    deleteTier: async () => undefined,
  };

  const http = () => request(app.getHttpServer());
  const cookieFrom = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
      .split(';')[0]!;
  const send = (method: 'get' | 'post' | 'delete', path: string, cookie: string, body?: object) => {
    const r = http()[method](path).set(CSRF).set('Cookie', cookie);
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
  async function createUser(username: string, role: string): Promise<string> {
    await send('post', '/api/users', admin, {
      username,
      bindings: [{ role }],
      password: 'Temp-Password-1',
    }).expect(201);
    return activate(username, 'Temp-Password-1');
  }
  const issue = (cookie: string, account = 'ci', path = 'home/team/prod/team-a') =>
    send('post', `${MINE}/${path}/accounts/${account}/tokens`, cookie, {});

  beforeAll(async () => {
    fake = createFakeStore();
    const config = loadConfig({ INITIAL_ADMIN_PASSWORD: ADMIN_PW, LOG_JSON: 'false' });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, KubeModule, StoreModule, AuditModule, AuthModule],
      controllers: [NamespacesController, MyNamespacesController],
      providers: [
        NamespacesService,
        MyNamespacesService,
        PeopleService,
        {
          provide: ClustersService,
          useValue: {
            kubeconfig: async () => KUBECONFIG,
            storedSpec: async () => ({ kubernetes: { flavor: 'rke2' } }),
          },
        },
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
    service = moduleRef.get(NamespacesService);
    service.access = () => access;
    for (const name of ['home', 'other']) {
      await fake.store.connections.create({ name }, {} as never);
    }
    admin = await activate('admin', ADMIN_PW);
    viewer = await createUser('reader', 'viewer');
    max = await createUser('max', NAMESPACE_USER_ROLE);
    eva = await createUser('eva', NAMESPACE_USER_ROLE);
    nobody = await createUser('nobody', NAMESPACE_USER_ROLE);
  });
  afterAll(() => app?.close());

  beforeEach(() => {
    defined = {
      home: [
        spec('team-a', { ci: [person('max'), person('eva')], audit: [person('eva')] }),
        spec('team-b', { ci: [person('eva')] }),
      ],
      other: [spec('team-c', { ci: [person('eva')] }, 'stage')],
    };
    brokenConnections = [];
    readError = undefined;
    secrets = [];
    vi.clearAllMocks();
  });

  it('shows exactly the assigned namespaces and accounts (FP37-F-03)', async () => {
    const { body, headers } = await send('get', MINE, max).expect(200);
    expect(body).toEqual({
      incomplete: false,
      namespaces: [
        {
          connection: 'home',
          clusterNamespace: 'team',
          cluster: 'prod',
          namespace: 'team-a',
          accounts: [{ name: 'ci', role: 'edit' }],
          ready: true,
          unreachable: false,
          quota: [{ resource: 'pods', hard: '20', used: '3' }],
          tokens: [],
        },
      ],
    });
    expect(headers['cache-control']).toBe('no-store');
    const mine = (await send('get', MINE, eva).expect(200)).body.namespaces as {
      namespace: string;
    }[];
    expect(mine.map((n) => n.namespace).sort()).toEqual(['team-a', 'team-b', 'team-c']);
    expect((await send('get', MINE, nobody).expect(200)).body.namespaces).toEqual([]);
    // Assignments work for every role, and no role sees more (FP37-F-02).
    expect((await send('get', MINE, admin).expect(200)).body.namespaces).toEqual([]);
  });

  it('answers the same for what is not assigned and what does not exist (acceptance FP-37)', async () => {
    const answers = new Set<string>();
    const post = [
      'home/team/prod/team-a/accounts/audit', // exists, other account
      'home/team/prod/team-a/accounts/missing',
      'home/team/prod/team-b/accounts/ci', // exists, other namespace
      'home/team/prod/missing/accounts/ci',
      'home/team/stage/team-a/accounts/ci', // other cluster
      'home/elsewhere/prod/team-a/accounts/ci',
      'other/team/stage/team-c/accounts/ci', // exists on another connection
      'missing/team/prod/team-a/accounts/ci',
    ];
    for (const path of post) {
      const { body } = await send('post', `${MINE}/${path}/tokens`, max, {}).expect(404);
      answers.add(JSON.stringify(body));
    }
    brokenConnections = ['other'];
    const broken = await send(
      'post',
      `${MINE}/other/team/stage/team-c/accounts/ci/tokens`,
      max,
      {},
    ).expect(404);
    answers.add(JSON.stringify(broken.body));
    for (const path of ['home/team/prod/team-b', 'missing/team/prod/team-b']) {
      const { body } = await send('delete', `${MINE}/${path}/tokens/token-1`, max).expect(404);
      answers.add(JSON.stringify(body));
    }
    expect([...answers]).toHaveLength(1);
    expect(access.issueToken).not.toHaveBeenCalled();
  });

  it('issues a kubeconfig and shows only own tokens (FP37-F-04)', async () => {
    const res = await issue(max).expect(201);
    expect(res.body).toMatchObject({ format: 'kubeconfig' });
    expect(res.body.content).toContain(TOKEN);
    expect(res.headers['cache-control']).toBe('no-store');
    await issue(eva).expect(201);
    const { body } = await send('get', MINE, max).expect(200);
    expect(body.namespaces[0].tokens).toHaveLength(1);
    expect(body.namespaces[0].tokens[0]).toMatchObject({ id: res.body.id, account: 'ci' });
    expect(JSON.stringify(body)).not.toMatch(/eva|createdBy|unassigned/);
  });

  it('revokes only own tokens; the owner sees and revokes all (FP37-F-04)', async () => {
    const mine = (await issue(max).expect(201)).body.id as string;
    const evas = (await issue(eva).expect(201)).body.id as string;
    const path = `${MINE}/home/team/prod/team-a/tokens`;
    await send('delete', `${path}/${evas}`, max).expect(404);
    expect(secrets).toHaveLength(2);
    await send('delete', `${path}/${mine}`, max).expect(204);
    const list = await send('get', OWNER, admin).expect(200);
    expect(list.body.namespaces[0].tokens).toMatchObject([{ id: evas, createdBy: 'eva' }]);
    await send('delete', `${OWNER}/team-a/tokens/${evas}`, admin).expect(204);
    expect(secrets).toEqual([]);
  });

  it('checks the assignment on every request and tells the owner about left tokens (FP37-F-05)', async () => {
    await issue(max).expect(201);
    defined.home![0] = spec('team-a', { ci: [person('eva')] });
    await issue(max).expect(404);
    expect((await send('get', MINE, max).expect(200)).body.namespaces).toEqual([]);
    const { body } = await send('get', OWNER, admin).expect(200);
    expect(body.namespaces[0].tokens).toMatchObject([{ createdBy: 'max', unassigned: true }]);
  });

  it('limits the valid tokens per person and account, also at the same time (FP37-F-06)', async () => {
    const results = await Promise.all(
      Array.from({ length: MAX_TOKENS_PER_PERSON + 3 }, () => issue(eva)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(MAX_TOKENS_PER_PERSON);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    // Other accounts and people are not affected; expired ones do not count.
    await issue(eva, 'audit').expect(201);
    await issue(max).expect(201);
    const expired = secrets.find(
      (s) => s.metadata!.annotations!['capi-navigator.io/account'] === 'ci',
    )!;
    expired.metadata!.annotations!['capi-navigator.io/expires-at'] = '2020-01-01T00:00:00.000Z';
    await issue(eva).expect(201);
  });

  it('gives a new user with the name of a deleted one nothing (ADR-0041)', async () => {
    await createUser('temp', NAMESPACE_USER_ROLE);
    defined.home![0] = spec('team-a', { ci: [person('temp')] });
    await send('delete', '/api/users/temp', admin).expect(204);
    const again = await createUser('temp', NAMESPACE_USER_ROLE);
    expect((await send('get', MINE, again).expect(200)).body.namespaces).toEqual([]);
    await issue(again).expect(404);
  });

  it('writes audit events with person, cluster, namespace and account, never the token (FP37-F-06)', async () => {
    const { body } = await issue(max).expect(201);
    await send('delete', `${MINE}/home/team/prod/team-a/tokens/${body.id}`, max).expect(204);
    const events = fake.auditEvents.map((e) => e.spec).filter((e) => e.actor === 'max');
    expect(events.slice(-2)).toMatchObject([
      {
        action: 'my-namespace.token-issue',
        outcome: 'success',
        managementCluster: 'home',
        target: { kind: 'ServiceAccount', name: 'ci' },
        request: { path: `${MINE}/home/team/prod/team-a/accounts/ci/tokens` },
      },
      { action: 'my-namespace.token-revoke', outcome: 'success', target: { name: body.id } },
    ]);
    expect(JSON.stringify(fake.auditEvents)).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('refuses API tokens (FP37-F-07)', async () => {
    await send('post', '/api/users', admin, {
      username: 'robot',
      apiOnly: true,
      bindings: [{ role: 'admin' }],
    }).expect(201);
    const { body } = await send('post', '/api/users/robot/tokens', admin, {
      name: 'pipeline',
    }).expect(201);
    const auth = { Authorization: `Bearer ${body.token as string}` };
    await http().get(MINE).set(auth).expect(403);
    await http()
      .post(`${MINE}/home/team/prod/team-a/accounts/ci/tokens`)
      .set(auth)
      .send({})
      .expect(403);
  });

  it('says that something is missing without naming it', async () => {
    brokenConnections = ['other'];
    const first = await send('get', MINE, eva).expect(200);
    expect(first.body.incomplete).toBe(true);
    expect(JSON.stringify(first.body)).not.toMatch(/other|stage|secret-host/);
    brokenConnections = [];
    readError = new Error('connect ECONNREFUSED prod.internal');
    const second = await send('get', MINE, max).expect(200);
    expect(second.body.namespaces[0]).toMatchObject({ unreachable: true, quota: [], tokens: [] });
    expect(JSON.stringify(second.body)).not.toContain('prod.internal');
  });

  it('shows assigned people and token issuers only with clusters.access (ADR-0041)', async () => {
    await issue(max).expect(201);
    const owner = await send('get', OWNER, admin).expect(200);
    expect(owner.body.namespaces[0].spec.accounts[0].people).toHaveLength(2);
    const reader = await send('get', OWNER, viewer).expect(200);
    expect(reader.body.namespaces[0].tokens).toHaveLength(1);
    expect(JSON.stringify(reader.body)).not.toMatch(/max|eva/);
    await send('get', `${OWNER}/people`, viewer).expect(403);
    await send('get', `${OWNER}/people`, max).expect(403);
    const people = await send('get', `${OWNER}/people`, admin).expect(200);
    expect(people.body).toContainEqual(person('max'));
    expect(JSON.stringify(people.body)).not.toContain('robot');
  });

  it('shows the dashboard of an assigned namespace, read as its account (FP37-F-08)', async () => {
    const seen: string[] = [];
    service.readNamespace = async (kc, namespace) => {
      seen.push(`${namespace} as ${kc.getCurrentUser()!.impersonateUser}`);
      return { ...EMPTY, pods: [{ metadata: { name: 'web', namespace: 'team-a' } }] };
    };
    const path = `${MINE}/home/team/prod/team-a/dashboard`;
    const { body } = await send('get', path, max).expect(200);
    expect(body.pods).toMatchObject([{ name: 'web' }]);
    expect(seen).toEqual(['team-a as system:serviceaccount:capi-navigator-accounts:team-a.ci']);
    const other = await send('get', path.replace('team-a', 'team-b'), max).expect(404);
    const missing = await send('get', path.replace('team-a', 'missing'), max).expect(404);
    expect(other.body).toEqual(missing.body);
    await send('get', path, admin).expect(404);
    service.readNamespace = async () => {
      throw new Error('connect ECONNREFUSED prod.internal');
    };
    const failed = await send('get', path, max).expect(502);
    expect(JSON.stringify(failed.body)).not.toContain('prod.internal');
  });

  it('renders the same objects with and without people', () => {
    const s = spec('team-a', { ci: [person('max')] });
    const bare = spec('team-a', { ci: [] });
    expect(managedNamespaceObjects(s)).toEqual(managedNamespaceObjects(bare));
  });
});
