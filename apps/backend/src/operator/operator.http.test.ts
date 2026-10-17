import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Prerequisites } from '@capi-navigator/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SESSION_COOKIE } from '../auth/session.service.js';
import { APP_CONFIG, loadConfig } from '../config/config.js';
import { ConfigModule } from '../config/config.module.js';
import { configureApp } from '../configure-app.js';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { KubeModule } from '../kube/kube.module.js';
import { StoreModule } from '../store/store.module.js';
import { StoreService } from '../store/store.service.js';
import { createFakeStore } from '../testing/fake-store.js';
import { OperatorModule } from './operator.module.js';
import type { ProviderObject } from './providers.js';

// The Kubernetes side is simulated: prerequisites, provider CRs, apply and the ORC download.
const k8s = vi.hoisted(() => ({
  prerequisites: undefined as unknown as Prerequisites,
  providers: [] as ProviderObject[],
  clusters: [] as { name: string; namespace: string }[],
  applied: [] as { objects: { kind: string; metadata: { name: string } }[]; dryRun: boolean }[],
  deleted: [] as string[],
  secrets: {} as Record<string, { labels?: Record<string, string>; keys: string[] }>,
}));

vi.mock('./prerequisites.js', () => ({ detectPrerequisites: async () => k8s.prerequisites }));
vi.mock('./providers.js', async (orig) => ({
  ...(await orig<typeof import('./providers.js')>()),
  listProviders: async () => k8s.providers,
  clustersUsing: async () => k8s.clusters,
}));
vi.mock('../kube/apply.js', () => ({
  serverSideApply: async (_kc: unknown, objects: never[], opts: { dryRun?: boolean } = {}) => {
    k8s.applied.push({ objects, dryRun: !!opts.dryRun });
    return objects;
  },
}));
vi.mock('./orc-manifest.js', async (orig) => ({
  ...(await orig<typeof import('./orc-manifest.js')>()),
  fetchOrcManifest: async (version: string) => [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'orc-system' } },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'orc-controller-manager', namespace: 'orc-system', labels: { v: version } },
    },
  ],
}));

const notFound = () => Object.assign(new Error('nf'), { code: 404 });
const fakeKc = {
  makeApiClient: () => ({
    readNamespace: async ({ name }: { name: string }) => {
      if (name === 'capi-system') return {};
      throw notFound();
    },
    getNamespacedCustomObject: async ({ name, namespace }: { name: string; namespace: string }) => {
      const p = k8s.providers.find(
        (x) => x.metadata.name === name && x.metadata.namespace === namespace,
      );
      if (!p) throw notFound();
      return p;
    },
    deleteNamespacedCustomObject: async ({ name }: { name: string }) => {
      k8s.deleted.push(`provider:${name}`);
    },
    readNamespacedSecret: async ({ name }: { name: string }) => {
      const s = k8s.secrets[name];
      if (!s) throw notFound();
      return {
        metadata: { name, labels: s.labels },
        data: Object.fromEntries(s.keys.map((k) => [k, ''])),
      };
    },
    deleteNamespacedSecret: async ({ name }: { name: string }) => {
      k8s.deleted.push(`secret:${name}`);
    },
  }),
};

const ok = { installed: true, ready: true };
const prereqs = (
  orc: Prerequisites['orc'] = { installed: false, ready: false },
): Prerequisites => ({
  certManager: { ...ok, version: 'v1.21.2' },
  operator: { ...ok, version: 'v0.29.0' },
  orc,
  instructions: { certManager: 'helm …', operator: 'helm …', orc: 'kubectl …' },
});
const readyProvider = (
  kind: ProviderObject['kind'],
  name: string,
  namespace: string,
  version: string,
  extra: Partial<ProviderObject['spec']> = {},
): ProviderObject => ({
  kind,
  metadata: { name, namespace },
  spec: { version, ...extra },
  status: { installedVersion: version, conditions: [{ type: 'Ready', status: 'True' }] },
});
const CORE = readyProvider('CoreProvider', 'cluster-api', 'capi-system', 'v1.14.3');

describe('operator API (FP-3)', () => {
  let app: NestExpressApplication;
  let admin: string;
  let viewer: string;
  const CSRF = { 'x-capi-navigator': '1' };
  const base = '/api/connections/kind/operator';
  const http = () => request(app.getHttpServer());
  const post = (path: string, body: object, cookie = admin) =>
    http().post(`${base}${path}`).set(CSRF).set('Cookie', cookie).send(body);

  async function activate(username: string, pw: string): Promise<string> {
    const cookieOf = (res: request.Response) =>
      ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .find((c) => c.startsWith(SESSION_COOKIE))!
        .split(';')[0]!;
    const login = await http().post('/api/auth/login').set(CSRF).send({ username, password: pw });
    const changed = await http()
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', cookieOf(login))
      .send({ currentPassword: pw, newPassword: `${pw}-new` });
    return cookieOf(changed);
  }

  beforeAll(async () => {
    const fake = createFakeStore();
    const config = loadConfig({ INITIAL_ADMIN_PASSWORD: 'Admin-Pw-1', LOG_JSON: 'false' });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, KubeModule, StoreModule, AuditModule, AuthModule, OperatorModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(StoreService)
      .useValue(fake.store)
      .overrideProvider(KubeClientFactory)
      .useValue({ homeCluster: () => ({ makeApiClient: () => ({}) }) })
      .overrideProvider(ManagementClusterClients)
      .useValue({ forConnection: async () => fakeKc })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app, config);
    await app.init();
    admin = await activate('admin', 'Admin-Pw-1');
    await http()
      .post('/api/users')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ username: 'vera', role: 'viewer', password: 'Viewer-Pw-1' });
    viewer = await activate('vera', 'Viewer-Pw-1');
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    k8s.prerequisites = prereqs();
    k8s.providers = [];
    k8s.clusters = [];
    k8s.applied = [];
    k8s.deleted = [];
    k8s.secrets = {};
  });

  it('returns the state with install instructions when the operator is missing (acceptance)', async () => {
    k8s.prerequisites = {
      ...prereqs(),
      operator: { installed: false, ready: false },
    };
    const res = await http().get(base).set('Cookie', viewer).expect(200);
    expect(res.body.prerequisites.operator.installed).toBe(false);
    expect(res.body.prerequisites.instructions.operator).toBeTruthy();
    const blocked = await post('/providers', {
      catalogId: 'core',
      version: 'v1.14.3',
      namespace: 'capi-system',
    }).expect(409);
    expect(blocked.body.message).toMatch(/CAPI Operator/);
  });

  it('previews and installs the core provider with dry run first (FP3-F-09, FP3-F-10)', async () => {
    const preview = await post('/providers/preview', {
      catalogId: 'core',
      version: 'v1.14.3',
      namespace: 'capi-system',
    }).expect(200);
    expect(preview.body.yaml).toContain('kind: CoreProvider');
    expect(k8s.applied).toHaveLength(1);
    expect(k8s.applied[0]!.dryRun).toBe(true);

    await post('/providers', {
      catalogId: 'core',
      version: 'v1.14.3',
      namespace: 'capi-system',
    }).expect(201);
    expect(k8s.applied[1]!.dryRun).toBe(false);
    expect(k8s.applied[1]!.objects.map((o) => o.kind)).toEqual(['Namespace', 'CoreProvider']);
  });

  it('notes objects in a new namespace that cannot be dry-run', async () => {
    k8s.providers = [CORE];
    const res = await post('/providers/preview', {
      catalogId: 'helm',
      version: 'v0.6.4',
      namespace: 'caaph-system',
      variables: { TOKEN: 'secret-value' },
    }).expect(200);
    expect(res.body.warnings[0]).toMatch(/will be created/);
    expect(res.body.yaml).not.toContain('secret-value');
    expect(k8s.applied[0]!.objects.map((o) => o.kind)).toEqual(['Namespace']);
  });

  it('enforces dependencies: core first, ORC before CAPO (FP3-F-11, acceptance)', async () => {
    const capo = { catalogId: 'openstack', version: 'v0.15.0', namespace: 'capo-system' };
    expect((await post('/providers', capo).expect(409)).body.message).toMatch(/core/i);
    k8s.providers = [CORE];
    const noOrc = await post('/providers', capo).expect(409);
    expect(noOrc.body.message).toMatch(/ORC/);
    expect(noOrc.body.hint).toMatch(/Install ORC first/);
    k8s.prerequisites = prereqs({ ...ok, version: 'v2.4.0' });
    const warn = await post('/providers/preview', capo).expect(200);
    expect(warn.body.warnings.join(' ')).toMatch(/ORC v2\.6\.0/);
  });

  it('rejects duplicates and providers of later packs', async () => {
    k8s.providers = [CORE];
    await post('/providers', {
      catalogId: 'core',
      version: 'v1.14.3',
      namespace: 'capi-system',
    }).expect(409);
    const later = await post('/providers', {
      catalogId: 'k0smotron-bootstrap',
      version: 'v2.2.0',
      namespace: 'x',
    }).expect(400);
    expect(later.body.hint).toMatch(/FP-9/);
    await post('/providers', { catalogId: 'nope', version: 'v1.0.0', namespace: 'x' }).expect(404);
  });

  it('installs CAPA with the required, empty AWS_B64ENCODED_CREDENTIALS variable', async () => {
    k8s.providers = [CORE];
    await post('/providers', {
      catalogId: 'aws',
      version: 'v2.13.1',
      namespace: 'capa-system',
    }).expect(201);
    const objects = k8s.applied.at(-1)!.objects as unknown as {
      kind: string;
      stringData?: object;
      spec?: object;
    }[];
    expect(objects.find((o) => o.kind === 'Secret')?.stringData).toEqual({
      AWS_B64ENCODED_CREDENTIALS: '',
    });
    expect(objects.find((o) => o.kind === 'InfrastructureProvider')?.spec).toMatchObject({
      configSecret: { name: 'aws-infrastructure-variables' },
    });
  });

  it('upgrades, keeps stored variables and refuses downgrades (FP3-F-12)', async () => {
    k8s.providers = [
      CORE,
      readyProvider('AddonProvider', 'helm', 'caaph-system', 'v0.6.2', {
        configSecret: { name: 'cfg', namespace: 'caaph-system' },
      }),
    ];
    const path = '/providers/AddonProvider/caaph-system/helm';
    const down = await http()
      .put(`${base}${path}`)
      .set(CSRF)
      .set('Cookie', admin)
      .send({ version: 'v0.6.1' })
      .expect(400);
    expect(down.body.message).toMatch(/Downgrades/);
    const res = await http()
      .put(`${base}${path}`)
      .set(CSRF)
      .set('Cookie', admin)
      .send({ version: 'v0.6.4' })
      .expect(200);
    expect(res.body.yaml).toContain('version: v0.6.4');
    expect(res.body.yaml).toContain('name: cfg');
    expect(res.body.objects.map((o: { kind: string }) => o.kind)).not.toContain('Secret');
    await http()
      .put(`${base}/providers/Bogus/x/y`)
      .set(CSRF)
      .set('Cookie', admin)
      .send({ version: 'v1.0.0' })
      .expect(400);
  });

  it('lists variable names but never values (NF-01)', async () => {
    k8s.providers = [
      readyProvider('InfrastructureProvider', 'aws', 'capa-system', 'v2.13.1', {
        configSecret: { name: 'v' },
      }),
    ];
    k8s.secrets = { v: { keys: ['B', 'A'] } };
    const res = await http()
      .get(`${base}/providers/InfrastructureProvider/capa-system/aws/variables`)
      .set('Cookie', admin)
      .expect(200);
    expect(res.body).toEqual({ names: ['A', 'B'] });
  });

  it('warns before removing a provider in use and removes on confirmation', async () => {
    k8s.providers = [
      CORE,
      readyProvider('InfrastructureProvider', 'openstack', 'capo-system', 'v0.15.0', {
        configSecret: { name: 'cfg' },
      }),
    ];
    k8s.secrets = {
      cfg: { labels: { 'capi-navigator.io/managed-by': 'capi-navigator' }, keys: [] },
    };
    k8s.clusters = [{ name: 'prod', namespace: 'default' }];
    const path = `${base}/providers/InfrastructureProvider/capo-system/openstack`;
    const usage = await http().get(`${path}/usage`).set('Cookie', viewer).expect(200);
    expect(usage.body.clusters).toEqual([{ name: 'prod', namespace: 'default' }]);
    const refused = await http().delete(path).set(CSRF).set('Cookie', admin).expect(409);
    expect(refused.body.hint).toContain('default/prod');
    await http().delete(`${path}?force=true`).set(CSRF).set('Cookie', admin).expect(204);
    expect(k8s.deleted).toEqual(['provider:openstack', 'secret:cfg']);
  });

  it('refuses to remove core while other providers exist', async () => {
    k8s.providers = [CORE, readyProvider('AddonProvider', 'helm', 'caaph-system', 'v0.6.4')];
    await http()
      .delete(`${base}/providers/CoreProvider/capi-system/cluster-api`)
      .set(CSRF)
      .set('Cookie', admin)
      .expect(409);
  });

  it('previews and installs ORC with forced server-side apply (FP3-F-04a)', async () => {
    const preview = await post('/orc/preview', { version: 'v2.6.0' }).expect(200);
    expect(preview.body.objects).toHaveLength(2);
    expect(preview.body.yaml).toContain('orc-controller-manager');
    expect(k8s.applied).toHaveLength(0);
    await post('/orc', { version: 'v2.6.0' }).expect(200);
    expect(k8s.applied).toHaveLength(1);
    await post('/orc', { version: 'latest' }).expect(400);
  });

  it('lets viewers read but not change anything', async () => {
    await http().get(base).set('Cookie', viewer).expect(200);
    await post('/orc', { version: 'v2.6.0' }, viewer).expect(403);
    await post(
      '/providers',
      { catalogId: 'core', version: 'v1.14.3', namespace: 'capi-system' },
      viewer,
    ).expect(403);
  });

  it('serves release lists (FP3-F-07)', async () => {
    const res = await http().get(`${base}/releases/core`).set('Cookie', viewer).expect(200);
    expect(res.body.versions).toContain('v1.14.3');
    await http().get(`${base}/releases/orc`).set('Cookie', viewer).expect(200);
    await http().get(`${base}/releases/unknown`).set('Cookie', viewer).expect(404);
  });
});
