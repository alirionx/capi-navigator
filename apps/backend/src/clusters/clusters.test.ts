import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ClusterSpecSchema,
  transform,
  type Credential,
  type OperatorState,
} from '@capi-navigator/shared';
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
import { onlyManagedByApp, presetUpToDate } from './clusters.service.js';
import { toEvents, toStatus, toSummary, type K8sObj } from './status.js';

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

describe('add-on preset updates (FP5-F-09, FP5-F-17)', () => {
  const desired = { spec: { chartName: 'aws-ccm', valuesTemplate: 'hostNetworking: true\n' } };
  const field = (manager: string, keys: string[], subresource?: string) => ({
    manager,
    ...(subresource ? { subresource } : {}),
    fieldsV1: Object.fromEntries(keys.map((k) => [k, {}])),
  });

  it('detects outdated presets and ignores fields added by CAAPH', () => {
    expect(presetUpToDate({ spec: { ...desired.spec, options: { wait: true } } }, desired)).toBe(
      true,
    );
    expect(presetUpToDate({ spec: { ...desired.spec, valuesTemplate: 'old\n' } }, desired)).toBe(
      false,
    );
  });

  it('updates only presets whose spec nobody else changed', () => {
    const app = field('capi-navigator', ['f:metadata', 'f:spec']);
    const caaph = field('manager', ['f:metadata']);
    const status = field('manager', ['f:status'], 'status');
    expect(onlyManagedByApp({ metadata: { managedFields: [app, caaph, status] } })).toBe(true);
    expect(
      onlyManagedByApp({
        metadata: { managedFields: [app, field('kubectl-edit', ['f:spec'])] },
      }),
    ).toBe(false);
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
          status: {
            phase: 'Running',
            nodeRef: { name: 'n1' },
            addresses: [
              { type: 'Hostname', address: 'n1' },
              { type: 'InternalIP', address: '10.6.0.12' },
            ],
          },
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
      conditions: [],
    });
    expect(
      status.machines.map((m) => `${m.role}:${m.name}:${m.phase}:${m.nodeName ?? ''}`),
    ).toEqual(['control-plane:cp1:Provisioning:', 'worker:w1:Running:n1']);
    expect(status.machines.find((m) => m.name === 'w1')?.internalIP).toBe('10.6.0.12');
  });

  it('adds size, image and root disk from the infra machine and the deployment (FP6-F-02)', () => {
    const status = toStatus({
      cluster,
      mds: [md],
      machines: [
        {
          metadata: {
            name: 'w1',
            labels: { 'cluster.x-k8s.io/deployment-name': 'demo-default' },
          },
          spec: { infrastructureRef: { kind: 'OpenStackMachine', name: 'w1-os' } },
          status: { phase: 'Running' },
        },
        {
          metadata: { name: 'a1' },
          spec: { infrastructureRef: { kind: 'AWSMachine', name: 'a1-aws' } },
        },
      ],
      infraMachines: [
        {
          kind: 'OpenStackMachine',
          metadata: { name: 'w1-os' },
          spec: { flavor: { filter: { name: 'a2-ram4' } }, image: { id: 'img-1' } },
          status: { initialization: { provisioned: true } },
        },
        {
          kind: 'AWSMachine',
          metadata: { name: 'a1-aws' },
          spec: { instanceType: 't3.large', ami: { id: 'ami-1' }, rootVolume: { size: 80 } },
        },
      ],
      kubeconfigAvailable: false,
    });
    expect(status.machines.find((m) => m.name === 'w1')).toMatchObject({
      deployment: 'demo-default',
      size: 'a2-ram4',
      image: 'img-1',
      infrastructure: { kind: 'OpenStackMachine', name: 'w1-os', ready: true },
    });
    expect(status.machines.find((m) => m.name === 'a1')).toMatchObject({
      size: 't3.large',
      image: 'ami-1',
      rootVolumeGB: 80,
    });
  });

  it('keeps events about the cluster objects only, newest first (FP6-F-02)', () => {
    const events = toEvents(
      [
        {
          type: 'Warning',
          reason: 'Failed',
          message: 'old',
          involvedObject: { kind: 'Machine', name: 'w1' },
          lastTimestamp: '2026-10-17T10:00:00Z',
        },
        {
          reason: 'Created',
          message: 'new',
          involvedObject: { kind: 'Cluster', name: 'demo' },
          series: { count: 3, lastObservedTime: '2026-10-17T11:00:00Z' },
        },
        { reason: 'Other', involvedObject: { kind: 'Pod', name: 'x' } },
      ],
      [
        { kind: 'Cluster', name: 'demo' },
        { kind: 'Machine', name: 'w1' },
      ],
    );
    expect(events.map((e) => `${e.reason}:${e.count}`)).toEqual(['Created:3', 'Failed:1']);
  });

  it('derives the distribution of external clusters from the control plane kind', () => {
    const external = { ...cluster, metadata: { ...cluster.metadata, annotations: {} } };
    expect(toSummary(external, cp).flavor).toBe('rke2');
  });
});

// ---- HTTP: preview and create with simulated management cluster ----

const k8s = vi.hoisted(() => ({
  applied: [] as { kinds: string[]; dryRun: boolean; force?: boolean }[],
  namespaces: new Set<string>(),
  existingCluster: false,
  /** Stored spec annotation of the existing cluster (FP-6 changes). */
  storedSpec: undefined as string | undefined,
  /** Live objects by "Kind/name" for change previews. */
  live: new Map<string, unknown>(),
  /** Simulated server-side apply conflicts by "Kind/name". */
  conflicts: new Map<string, { managers: string[]; fields: string[] }>(),
  machines: [] as unknown[],
  deleted: [] as string[],
}));
vi.mock('../kube/apply.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../kube/apply.js')>()),
  serverSideApply: async (
    _kc: unknown,
    objects: { kind: string }[],
    opts: { dryRun?: boolean; force?: boolean } = {},
  ) => {
    k8s.applied.push({
      kinds: objects.map((o) => o.kind),
      dryRun: !!opts.dryRun,
      ...(opts.force ? { force: true } : {}),
    });
    return objects;
  },
  deleteObjects: async (_kc: unknown, objects: { kind: string; metadata: { name: string } }[]) => {
    k8s.deleted.push(...objects.map((o) => `${o.kind}/${o.metadata.name}`));
  },
  readLive: async (_kc: unknown, o: { kind: string; metadata: { name: string } }) =>
    k8s.live.get(`${o.kind}/${o.metadata.name}`),
  dryRunApply: async (_kc: unknown, o: { kind: string; metadata: { name: string } }) => ({
    result: o,
    ...(k8s.conflicts.has(`${o.kind}/${o.metadata.name}`)
      ? { conflict: k8s.conflicts.get(`${o.kind}/${o.metadata.name}`) }
      : {}),
  }),
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
        return {
          metadata: {
            name,
            namespace: 'team-a',
            ...(k8s.storedSpec
              ? { annotations: { 'capi-navigator.io/cluster-spec': k8s.storedSpec } }
              : {}),
          },
          spec: {},
          status: { phase: 'Pending' },
        };
      }
      throw notFound();
    },
    listClusterCustomObject: async () => ({ items: [] }),
    // Live MachineDeployments (from the simulated live state) and machines (FP-7 pipeline).
    listNamespacedCustomObject: async ({ plural }: { plural: string }) => ({
      items:
        plural === 'machinedeployments'
          ? [...k8s.live.entries()]
              .filter(([key]) => key.startsWith('MachineDeployment/'))
              .map(([, o]) => o)
          : plural === 'machines'
            ? k8s.machines
            : [],
    }),
    readNamespacedSecret: async ({ name }: { name: string }) => {
      if (name === 'demo-kubeconfig') {
        return {
          data: { value: Buffer.from('apiVersion: v1\nkind: Config\n').toString('base64') },
        };
      }
      throw notFound();
    },
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

  let fake: ReturnType<typeof createFakeStore>;

  beforeAll(async () => {
    fake = createFakeStore();
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

  it('shows and downloads the kubeconfig for operators only, audited and not cached (FP6-F-04, ADR-0005)', async () => {
    k8s.existingCluster = true;
    const url = '/api/connections/home/clusters/team-a/demo/kubeconfig';
    await http().get(url).set('Cookie', viewerCookie).expect(403);

    const view = await http().get(url).set('Cookie', operatorCookie).expect(200);
    expect(view.text).toBe('apiVersion: v1\nkind: Config\n');
    expect(view.headers['cache-control']).toBe('no-store');

    const dl = await http().get(`${url}/download`).set('Cookie', operatorCookie).expect(200);
    expect(dl.headers['content-disposition']).toBe('attachment; filename="demo.kubeconfig"');
    expect(dl.headers['cache-control']).toBe('no-store');

    const audit = fake.auditEvents
      .filter((e) => e.spec.action.startsWith('cluster.kubeconfig'))
      .map((e) => `${e.spec.action}:${e.spec.outcome}:${e.spec.actor}:${e.spec.target?.name}`);
    // Requests rejected by the role guard never reach the handler (and the audit interceptor).
    expect(audit).toEqual([
      'cluster.kubeconfig.view:success:otto:demo',
      'cluster.kubeconfig.download:success:otto:demo',
    ]);
    // The audit log never contains the kubeconfig itself.
    expect(JSON.stringify(fake.auditEvents)).not.toContain('kind: Config');

    k8s.existingCluster = false;
    await http().get(url).set('Cookie', operatorCookie).expect(404);
  });

  it('scales a pool: preview shows only changed objects, drift needs a take-over (FP6-F-05)', async () => {
    const spec = ClusterSpecSchema.parse({
      ...OS_SPEC,
      addons: { cloudControllerManager: false, csiDriver: false },
    });
    k8s.existingCluster = true;
    k8s.storedSpec = JSON.stringify(spec);
    // Live state = what the app applied for the current spec.
    for (const o of transform(spec, { credential: { cloudName: 'infomaniak' } })) {
      k8s.live.set(`${o.kind}/${o.metadata.name}`, o);
    }
    const url = '/api/connections/home/clusters/team-a/demo/scale';
    const body = { pool: 'default', replicas: 3 };
    await http()
      .post(`${url}/preview`)
      .set(CSRF)
      .set('Cookie', viewerCookie)
      .send(body)
      .expect(403);

    const preview = await http()
      .post(`${url}/preview`)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send(body)
      .expect(200);
    expect(
      preview.body.diffs.map((d: { kind: string; change: string }) => `${d.kind}:${d.change}`),
    ).toEqual(['Cluster:update', 'MachineDeployment:update']);
    const md = preview.body.diffs[1];
    expect(md.before).toMatch(/replicas: 2/);
    expect(md.after).toMatch(/replicas: 3/);

    k8s.applied = [];
    await http().post(url).set(CSRF).set('Cookie', operatorCookie).send(body).expect(200);
    expect(k8s.applied.filter((a) => !a.dryRun)).toEqual([
      { kinds: ['Cluster', 'MachineDeployment'], dryRun: false },
    ]);

    // Drift: someone scaled with kubectl; applying needs an explicit take-over.
    k8s.conflicts.set('MachineDeployment/demo-default', {
      managers: ['kubectl-scale'],
      fields: ['.spec.replicas'],
    });
    const drifted = await http()
      .post(`${url}/preview`)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send(body)
      .expect(200);
    expect(drifted.body.drift).toEqual([
      {
        kind: 'MachineDeployment',
        name: 'demo-default',
        managers: ['kubectl-scale'],
        fields: ['.spec.replicas'],
        blocking: true,
      },
    ]);
    await http().post(url).set(CSRF).set('Cookie', operatorCookie).send(body).expect(409);
    k8s.applied = [];
    await http()
      .post(url)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send({ ...body, takeOver: true })
      .expect(200);
    expect(k8s.applied.filter((a) => !a.dryRun)[0]?.force).toBe(true);

    const actions = fake.auditEvents.map((e) => e.spec.action);
    expect(actions.filter((a) => a === 'cluster.scale')).toHaveLength(3);
    expect(actions).not.toContain('cluster.scale.preview');

    // Unknown pool and external clusters.
    await http()
      .post(`${url}/preview`)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send({ pool: 'nope', replicas: 1 })
      .expect(400);
    k8s.storedSpec = undefined;
    await http()
      .post(`${url}/preview`)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send(body)
      .expect(409);
    k8s.conflicts.clear();
    k8s.live.clear();
    k8s.existingCluster = false;
  });

  it('edits labels but refuses reserved prefixes (FP6-F-07)', async () => {
    k8s.existingCluster = true;
    k8s.storedSpec = JSON.stringify(ClusterSpecSchema.parse(OS_SPEC));
    const url = '/api/connections/home/clusters/team-a/demo/labels';
    await http()
      .post(`${url}/preview`)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send({ labels: { 'capi-navigator.io/ccm': 'x' } })
      .expect(400);
    const res = await http()
      .post(`${url}/preview`)
      .set(CSRF)
      .set('Cookie', operatorCookie)
      .send({ labels: { env: 'prod' } })
      .expect(200);
    const cluster = res.body.diffs.find((d: { kind: string }) => d.kind === 'Cluster');
    expect(cluster.after).toMatch(/env: prod/);
    k8s.storedSpec = undefined;
    k8s.existingCluster = false;
  });

  it('applies day-2 changes generically: rollout plan, pool removal, one rollout at a time (FP-7)', async () => {
    const spec = ClusterSpecSchema.parse({
      ...OS_SPEC,
      addons: { cloudControllerManager: false, csiDriver: false },
      topology: {
        ...OS_SPEC.topology,
        workerPools: [
          { name: 'default', replicas: 2, machineSize: 'a4-ram8-disk50-perf1' },
          { name: 'gpu', replicas: 1, machineSize: 'a8-ram32-disk80-perf1' },
        ],
      },
    });
    k8s.existingCluster = true;
    k8s.storedSpec = JSON.stringify(spec);
    for (const o of transform(spec, { credential: { cloudName: 'infomaniak' } })) {
      k8s.live.set(`${o.kind}/${o.metadata.name}`, {
        ...o,
        status: { upToDateReplicas: (o.spec as { replicas?: number }).replicas },
      });
    }
    k8s.machines = [
      {
        metadata: { name: 'cp-1', labels: { 'cluster.x-k8s.io/control-plane': '' } },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      },
      {
        metadata: { name: 'w-1', labels: { 'cluster.x-k8s.io/deployment-name': 'demo-default' } },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      },
      {
        metadata: { name: 'g-1', labels: { 'cluster.x-k8s.io/deployment-name': 'demo-gpu' } },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      },
    ];
    const url = '/api/connections/home/clusters/team-a/demo/changes';
    const post = (path: string, change: unknown) =>
      http().post(path).set(CSRF).set('Cookie', operatorCookie).send({ change });

    // Flavor change of a pool: new templates, the pool's machines are replaced.
    const flavor = await post(`${url}/preview`, {
      type: 'machine',
      group: 'default',
      machineSize: 'a8-ram16-disk50-perf1',
    }).expect(200);
    expect(flavor.body.rollouts).toEqual([
      expect.objectContaining({
        name: 'demo-default',
        machines: ['w-1'],
        action: 'replace',
        strategy: 'maxSurge 1, maxUnavailable 0',
      }),
    ]);
    expect(
      flavor.body.diffs.map((d: { kind: string; change: string }) => `${d.kind}:${d.change}`),
    ).toEqual(
      expect.arrayContaining(['OpenStackMachineTemplate:create', 'MachineDeployment:update']),
    );

    // Upgrade: control plane first; workers later (automatic).
    const up = await post(`${url}/preview`, { type: 'upgrade', version: 'v1.36.5+rke2r1' }).expect(
      200,
    );
    expect(
      up.body.rollouts.map((r: { name: string; action: string }) => `${r.name}:${r.action}`),
    ).toEqual(['demo-control-plane:replace', 'demo-default:later', 'demo-gpu:later']);
    await post(`${url}/preview`, { type: 'upgrade', version: 'v1.34.12+rke2r1' }).expect(400);

    // Removing a pool deletes its MachineDeployment.
    const rm = await post(`${url}/preview`, { type: 'removePool', pool: 'gpu' }).expect(200);
    expect(rm.body.diffs).toContainEqual(
      expect.objectContaining({ kind: 'MachineDeployment', name: 'demo-gpu', change: 'delete' }),
    );
    expect(rm.body.rollouts).toContainEqual(
      expect.objectContaining({ name: 'demo-gpu', machines: ['g-1'], action: 'remove' }),
    );
    await post(url, { type: 'removePool', pool: 'gpu' }).expect(200);
    expect(k8s.deleted).toContain('MachineDeployment/demo-gpu');
    const actions = fake.auditEvents.map((e) => e.spec.action);
    expect(actions).toContain('cluster.change.removePool');

    // A running rollout blocks further machine changes.
    k8s.live.set('MachineDeployment/demo-default', {
      ...(k8s.live.get('MachineDeployment/demo-default') as object),
      status: { replicas: 3, readyReplicas: 2, upToDateReplicas: 1 },
    });
    const blocked = await post(`${url}/preview`, { type: 'rebuild', group: 'default' }).expect(200);
    expect(blocked.body.blockers.join()).toMatch(/rollout is still running/);
    await post(url, { type: 'rebuild', group: 'default' }).expect(409);

    k8s.live.clear();
    k8s.machines = [];
    k8s.storedSpec = undefined;
    k8s.existingCluster = false;
  });
});
