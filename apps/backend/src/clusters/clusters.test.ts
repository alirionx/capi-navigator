import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ClusterSpecSchema, type Credential, type OperatorState } from '@capi-navigator/shared';
import request from 'supertest';
import { parse } from 'yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SESSION_COOKIE } from '../auth/session.service.js';
import { APP_CONFIG, loadConfig } from '../config/config.js';
import { ConfigModule } from '../config/config.module.js';
import { configureApp } from '../configure-app.js';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { CredentialsService } from '../credentials/credentials.service.js';
import {
  buildCloudConf,
  buildCloudConfigResourceSetSecret,
} from '../infra-providers/openstack/cloud-config.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { KubeModule } from '../kube/kube.module.js';
import { OperatorService } from '../operator/operator.service.js';
import { StoreModule } from '../store/store.module.js';
import { StoreService } from '../store/store.service.js';
import { createFakeStore } from '../testing/fake-store.js';
import { ClustersModule } from './clusters.module.js';
import { toStatus, toSummary, type K8sObj } from './status.js';

const OS_SPEC = {
  name: 'demo',
  namespace: 'team-a',
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'a2-ram4-disk0', rootVolumeSizeGB: 50 },
    workerPools: [{ name: 'default', replicas: 2, machineSize: 'a4-ram8-disk50-perf1' }],
  },
  infrastructure: {
    provider: 'openstack',
    credentialRef: 'infomaniak',
    image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
    externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  },
};
const CLOUDS = `clouds:\n  infomaniak:\n    auth: { auth_url: "https://api.example/identity", application_credential_id: app-id, application_credential_secret: "s3cr\\"et" }\n    region_name: dc4-a\n    auth_type: v3applicationcredential\n`;

describe('OpenStack cloud config (FP5-F-10, ADR-0004)', () => {
  const spec = ClusterSpecSchema.parse(OS_SPEC);
  const infra = spec.infrastructure as Extract<
    typeof spec.infrastructure,
    { provider: 'openstack' }
  >;
  const cloud = {
    auth: {
      auth_url: 'https://api.example/identity',
      application_credential_id: 'app-id',
      application_credential_secret: 's3cr"et',
    },
    region_name: 'dc4-a',
    auth_type: 'v3applicationcredential',
  };

  it('builds cloud.conf with application credential, region and floating network', () => {
    const conf = buildCloudConf(cloud, infra, true);
    expect(conf).toContain(
      '[Global]\nauth-url=https://api.example/identity\napplication-credential-id=app-id',
    );
    expect(conf).toContain('application-credential-secret="s3cr\\"et"');
    expect(conf).toContain('region=dc4-a\nca-file=/etc/config/ca.crt');
    expect(conf).toContain(`[LoadBalancer]\nfloating-network-id=${infra.externalNetwork}`);
  });

  it('builds password-based cloud.conf', () => {
    const conf = buildCloudConf(
      {
        auth: { auth_url: 'https://k', username: 'u', password: 'p', project_name: 'pr' },
        region_name: 'r',
        auth_type: 'password',
      },
      infra,
      false,
    );
    expect(conf).toMatch(
      /username=u\npassword=p\ntenant-name=pr\ntenant-domain-name=Default\nuser-domain-name=Default/,
    );
    expect(conf).not.toContain('ca-file');
  });

  it('wraps kube-system/cloud-config into a ClusterResourceSet Secret', () => {
    const secret = buildCloudConfigResourceSetSecret(spec, 'CONF', 'CA');
    expect(secret).toMatchObject({
      type: 'addons.cluster.x-k8s.io/resource-set',
      metadata: { name: 'demo-cloud-config', namespace: 'team-a' },
    });
    const inner = parse(Buffer.from(secret.data['cloud-config.yaml']!, 'base64').toString());
    expect(inner).toMatchObject({
      metadata: { name: 'cloud-config', namespace: 'kube-system' },
      stringData: { 'cloud.conf': 'CONF', 'ca.crt': 'CA' },
    });
  });
});

describe('status mapping (US-07)', () => {
  const cluster: K8sObj = {
    metadata: {
      name: 'demo',
      namespace: 'team-a',
      labels: { env: 'x' },
      annotations: { 'capi-navigator.io/cluster-spec': '{"kubernetes":{"flavor":"rke2"}}' },
    },
    spec: {
      infrastructureRef: { kind: 'OpenStackCluster', name: 'demo' },
      controlPlaneRef: { kind: 'RKE2ControlPlane', name: 'demo-control-plane' },
    },
    status: { phase: 'Provisioned', conditions: [{ type: 'Available', status: 'True' }] },
  };
  const cp: K8sObj = {
    kind: 'RKE2ControlPlane',
    metadata: { name: 'demo-control-plane' },
    spec: { replicas: 3, version: 'v1.35.9+rke2r1' },
    status: { availableReplicas: 2 },
  };
  const md: K8sObj = {
    metadata: { name: 'demo-default', labels: { 'cluster.x-k8s.io/cluster-name': 'demo' } },
    spec: { replicas: 2 },
    status: { readyReplicas: 1, upToDateReplicas: 2 },
  };

  it('summarizes provider, flavor, version and readiness', () => {
    expect(toSummary(cluster, cp, [md])).toMatchObject({
      provider: 'openstack',
      flavor: 'rke2',
      version: 'v1.35.9+rke2r1',
      phase: 'Provisioned',
      ready: true,
      controlPlane: { replicas: 3, ready: 2 },
      workers: { replicas: 2, ready: 1 },
      managed: true,
    });
    expect(toSummary({ metadata: { name: 'x' } }).managed).toBe(false);
  });

  it('lists machines with role, pool and node', () => {
    const status = toStatus({
      cluster,
      cp,
      infra: {
        kind: 'OpenStackCluster',
        metadata: { name: 'demo' },
        status: { initialization: { provisioned: true } },
      },
      mds: [md],
      machines: [
        {
          metadata: { name: 'w1', labels: { 'capi-navigator.io/pool': 'default' } },
          spec: { providerID: 'openstack:///x' },
          status: { phase: 'Running', nodeRef: { name: 'n1' } },
        },
        {
          metadata: { name: 'cp1', labels: { 'cluster.x-k8s.io/control-plane': '' } },
          status: { phase: 'Provisioning' },
        },
      ],
      kubeconfigAvailable: true,
    });
    expect(status.infrastructure?.ready).toBe(true);
    expect(status.machineDeployments[0]).toEqual({
      name: 'demo-default',
      pool: 'default',
      replicas: 2,
      ready: 1,
      upToDate: 2,
    });
    expect(
      status.machines.map((m) => `${m.role}:${m.name}:${m.phase}:${m.nodeName ?? ''}`),
    ).toEqual(['control-plane:cp1:Provisioning:', 'worker:w1:Running:n1']);
  });
});

// ---- HTTP: preview and create with simulated management cluster ----

const k8s = vi.hoisted(() => ({
  applied: [] as { kinds: string[]; dryRun: boolean }[],
  namespaces: new Set<string>(),
  existingCluster: false,
}));
vi.mock('../kube/apply.js', () => ({
  serverSideApply: async (
    _kc: unknown,
    objects: { kind: string }[],
    opts: { dryRun?: boolean } = {},
  ) => {
    k8s.applied.push({ kinds: objects.map((o) => o.kind), dryRun: !!opts.dryRun });
    return objects;
  },
}));
const notFound = () => Object.assign(new Error('nf'), { code: 404 });
const fakeKc = {
  makeApiClient: () => ({
    readNamespace: async ({ name }: { name: string }) => {
      if (!k8s.namespaces.has(name)) throw notFound();
      return {};
    },
    getNamespacedCustomObject: async ({ plural, name }: { plural: string; name: string }) => {
      if (plural === 'clusters' && k8s.existingCluster) {
        return { metadata: { name, namespace: 'team-a' }, spec: {}, status: { phase: 'Pending' } };
      }
      throw notFound();
    },
    listClusterCustomObject: async () => ({ items: [] }),
  }),
};

describe('clusters API (FP5-F-05, FP5-F-08, FP5-F-18)', () => {
  let app: NestExpressApplication;
  let operatorCookie: string;
  let viewerCookie: string;
  const CSRF = { 'x-capi-navigator': '1' };
  const base = '/api/connections/kind/clusters';
  const http = () => request(app.getHttpServer());
  const ready = (catalogId: string) => ({
    kind: 'CoreProvider',
    name: catalogId,
    namespace: 'x',
    catalogId,
    phase: 'Ready',
    conditions: [],
  });
  let state: OperatorState;
  let credential: Credential;
  const allowNamespace = vi.fn();

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
      imports: [ConfigModule, KubeModule, StoreModule, AuditModule, AuthModule, ClustersModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(StoreService)
      .useValue(fake.store)
      .overrideProvider(KubeClientFactory)
      .useValue({ homeCluster: () => ({ makeApiClient: () => ({}) }) })
      .overrideProvider(ManagementClusterClients)
      .useValue({ forConnection: async () => fakeKc })
      .overrideProvider(OperatorService)
      .useValue({ state: async () => state })
      .overrideProvider(CredentialsService)
      .useValue({
        resolve: async () => ({ credential, data: { 'clouds.yaml': CLOUDS } }),
        allowNamespace,
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app, config);
    await app.init();
    const admin = await activate('admin', 'Admin-Pw-1');
    for (const [u, role] of [
      ['otto', 'operator'],
      ['vera', 'viewer'],
    ]) {
      await http()
        .post('/api/users')
        .set(CSRF)
        .set('Cookie', admin)
        .send({ username: u, role, password: 'Temp-Pw-12' });
    }
    operatorCookie = await activate('otto', 'Temp-Pw-12');
    viewerCookie = await activate('vera', 'Temp-Pw-12');
  });
  afterAll(async () => app?.close());

  beforeEach(() => {
    state = {
      prerequisites: {
        certManager: { installed: true, ready: true },
        operator: { installed: true, ready: true },
        orc: { installed: true, ready: true },
        instructions: { certManager: '', operator: '', orc: '' },
      },
      providers: ['core', 'rke2-bootstrap', 'rke2-control-plane', 'openstack', 'aws', 'helm'].map(
        ready,
      ),
    } as unknown as OperatorState;
    credential = {
      name: 'infomaniak',
      provider: 'openstack',
      allowedNamespaces: ['team-a'],
      summary: { cloudName: 'infomaniak' },
      identity: { apiVersion: 'x', kind: 'OpenStackClusterIdentity', name: 'infomaniak' },
      secret: { name: 's', namespace: 'capo-system' },
      lastTest: { ok: true, testedAt: 'x', checks: [] },
    };
    k8s.applied = [];
    k8s.namespaces = new Set(['team-a']);
    k8s.existingCluster = false;
    allowNamespace.mockReset();
  });

  const preview = (spec: object = OS_SPEC, extra: object = {}) =>
    http()
      .post(`${base}/preview`)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send({ spec, ...extra });

  it('previews all objects with the cloud config masked and dry-runs them', async () => {
    const res = await preview().expect(200);
    expect(res.body.blockers).toEqual([]);
    const kinds = res.body.objects.map((o: { kind: string }) => o.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'Secret',
        'HelmChartProxy',
        'Cluster',
        'OpenStackCluster',
        'ClusterResourceSet',
      ]),
    );
    expect(res.body.yaml).toMatch(/cloud-config.yaml: ["']\*{8}["']/);
    expect(res.body.yaml).not.toContain('s3cr');
    expect(k8s.applied).toEqual([{ kinds: expect.any(Array), dryRun: true }]);
  });

  it('blocks when providers, ORC or the credential test are missing', async () => {
    state.providers = state.providers.filter((p) => p.catalogId !== 'rke2-control-plane');
    state.prerequisites.orc.ready = false;
    credential.lastTest = { ok: false, testedAt: 'x', checks: [] };
    const res = await preview().expect(200);
    expect(res.body.blockers.join('\n')).toMatch(/RKE2 control plane must be installed/);
    expect(res.body.blockers.join('\n')).toMatch(/ORC must be installed/);
    expect(res.body.blockers.join('\n')).toMatch(/not passed its test/);
    await http()
      .post(base)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send({ spec: OS_SPEC })
      .expect(409);
  });

  it('does not need CAAPH or a cloud config without add-ons', async () => {
    state.providers = state.providers.filter((p) => p.catalogId !== 'helm');
    const res = await preview({
      ...OS_SPEC,
      addons: { cloudControllerManager: false, csiDriver: false },
    }).expect(200);
    expect(res.body.blockers).toEqual([]);
    expect(res.body.objects.map((o: { kind: string }) => o.kind)).not.toContain(
      'ClusterResourceSet',
    );
  });

  it('offers to allow the namespace for the credential and does it on create', async () => {
    k8s.namespaces = new Set();
    const spec = { ...OS_SPEC, namespace: 'new-ns' };
    const blocked = await preview(spec).expect(200);
    expect(blocked.body.credentialNamespaceMissing).toBe(true);
    expect(blocked.body.blockers.join()).toMatch(/may not be used in namespace new-ns/);
    const granted = await preview(spec, { grantCredentialNamespace: true }).expect(200);
    expect(granted.body.blockers).toEqual([]);
    expect(granted.body.objects[0]).toEqual({ kind: 'Namespace', name: 'new-ns' });
    // The namespace does not exist yet: only cluster-scoped objects can be dry-run.
    expect(k8s.applied.at(-1)!.kinds).toEqual(['Namespace']);

    await http()
      .post(base)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send({ spec, grantCredentialNamespace: true })
      .expect(201);
    expect(allowNamespace).toHaveBeenCalledWith('kind', 'openstack', 'infomaniak', 'new-ns');
  });

  it('creates with server-side apply and refuses duplicates', async () => {
    const res = await http()
      .post(base)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send({ spec: OS_SPEC })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'demo',
      namespace: 'team-a',
      provider: 'openstack',
      managed: true,
    });
    expect(k8s.applied.some((a) => !a.dryRun && a.kinds.includes('Cluster'))).toBe(true);
    k8s.existingCluster = true;
    const dup = await http()
      .post(base)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send({ spec: OS_SPEC })
      .expect(409);
    expect(dup.body.message).toMatch(/already exists/);
  });

  it('validates the spec with the shared schema and enforces roles', async () => {
    const bad = await preview({
      ...OS_SPEC,
      kubernetes: { version: 'v1.35.9+rke2r1', podCidr: '10.6.0.0/16' },
    }).expect(400);
    expect(Object.keys(bad.body.fieldErrors)).toContain('spec.infrastructure.network.nodeCidr');
    await http()
      .post(`${base}/preview`)
      .set(CSRF)
      .set('Cookie', viewerCookie)
      .send({ spec: OS_SPEC })
      .expect(403);
    await http().get(base).set('Cookie', viewerCookie).expect(200);
  });
});
