import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { CredentialPlugin } from '../infra-providers/credential-plugin.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SESSION_COOKIE } from '../auth/session.service.js';
import { APP_CONFIG, loadConfig } from '../config/config.js';
import { ConfigModule } from '../config/config.module.js';
import { configureApp } from '../configure-app.js';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import {
  AwsCredentialPlugin,
  type AwsClients,
} from '../infra-providers/aws/aws-credential.plugin.js';
import type { HttpFn } from '../infra-providers/openstack/openstack-client.js';
import { GcpCredentialPlugin } from '../infra-providers/gcp/gcp-credential.plugin.js';
import { OpenStackCredentialPlugin } from '../infra-providers/openstack/openstack-credential.plugin.js';
import { ProxmoxCredentialPlugin } from '../infra-providers/proxmox/proxmox-credential.plugin.js';
import { PROXMOX_REQUIRED_PRIVILEGES } from '@capi-navigator/shared';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { KubeModule } from '../kube/kube.module.js';
import { StoreModule } from '../store/store.module.js';
import { StoreService } from '../store/store.service.js';
import { createFakeStore } from '../testing/fake-store.js';
import { CredentialsModule } from './credentials.module.js';
import { CREDENTIAL_PLUGINS } from './credentials.service.js';

// In-memory management cluster: Secrets and cluster-scoped identities.
type Obj = {
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  data?: Record<string, string>;
  spec?: Record<string, unknown>;
};
const mc = vi.hoisted(() => ({
  secrets: new Map<string, Obj>(),
  identities: new Map<string, Obj>(),
  /** Simulates a provider webhook that is not ready yet: identities are refused. */
  refuseIdentities: false,
  providers: [] as { kind: string; metadata: { name: string; namespace: string } }[],
  clusters: [] as {
    metadata: { name: string; namespace: string; annotations?: Record<string, string> };
    spec: Record<string, unknown>;
  }[],
}));
vi.mock('../kube/apply.js', () => ({
  serverSideApply: async (_kc: unknown, objects: Obj[]) => {
    for (const o of objects) {
      if (o.kind === 'Secret')
        mc.secrets.set(`${o.metadata.namespace}/${o.metadata.name}`, structuredClone(o));
      else if (mc.refuseIdentities)
        throw Object.assign(new Error('failed calling webhook: connection refused'), {
          code: 500,
        });
      else mc.identities.set(`${o.kind}/${o.metadata.name}`, structuredClone(o));
    }
    return objects;
  },
  deleteObjects: async (_kc: unknown, objects: Obj[]) => {
    for (const o of objects) {
      if (o.kind === 'Secret') mc.secrets.delete(`${o.metadata.namespace}/${o.metadata.name}`);
      else mc.identities.delete(`${o.kind}/${o.metadata.name}`);
    }
  },
}));
vi.mock('../operator/providers.js', () => ({ listProviders: async () => mc.providers }));

const notFound = () => Object.assign(new Error('nf'), { code: 404 });
const matches = (o: Obj, selector?: string) =>
  !selector ||
  selector.split(',').every((part) => {
    const [k, v] = part.split('=');
    return v === undefined ? k! in (o.metadata.labels ?? {}) : o.metadata.labels?.[k!] === v;
  });
const kindOf = (plural: string) =>
  plural.startsWith('openstack') ? 'OpenStackClusterIdentity' : 'AWSClusterStaticIdentity';
const fakeKc = {
  makeApiClient: () => ({
    listSecretForAllNamespaces: async ({ labelSelector }: { labelSelector?: string }) => ({
      items: [...mc.secrets.values()]
        .filter((s) => matches(s, labelSelector))
        .map((s) => structuredClone(s)),
    }),
    readNamespacedSecret: async ({ name, namespace }: { name: string; namespace: string }) => {
      const s = mc.secrets.get(`${namespace}/${name}`);
      if (!s) throw notFound();
      return structuredClone(s);
    },
    patchNamespacedSecret: async ({
      name,
      namespace,
      body,
    }: {
      name: string;
      namespace: string;
      body: Obj;
    }) => {
      const s = mc.secrets.get(`${namespace}/${name}`)!;
      s.metadata.annotations = { ...s.metadata.annotations, ...body.metadata.annotations };
      return s;
    },
    deleteNamespacedSecret: async ({ name, namespace }: { name: string; namespace: string }) => {
      mc.secrets.delete(`${namespace}/${name}`);
    },
    getClusterCustomObject: async ({ plural, name }: { plural: string; name: string }) => {
      const o = mc.identities.get(`${kindOf(plural)}/${name}`);
      if (!o) throw notFound();
      return structuredClone(o);
    },
    listClusterCustomObject: async ({ plural }: { plural: string }) => {
      if (plural.endsWith('clusters')) return { items: mc.clusters };
      return { items: [...mc.identities.values()].filter((o) => o.kind === kindOf(plural)) };
    },
    deleteClusterCustomObject: async ({ plural, name }: { plural: string; name: string }) => {
      mc.identities.delete(`${kindOf(plural)}/${name}`);
    },
  }),
};

const http = (): HttpFn => async (url) =>
  url.endsWith('/v3/auth/tokens')
    ? {
        status: 201,
        headers: { 'x-subject-token': 't' },
        body: JSON.stringify({
          token: {
            project: { id: 'p', name: 'PCP-1' },
            catalog: ['compute', 'network', 'image', 'load-balancer', 'volumev3'].map((type) => ({
              type,
              endpoints: [{ interface: 'public', region_id: 'dc4-a', url: `https://api/${type}` }],
            })),
          },
        }),
      }
    : url.includes('/flavors')
      ? {
          status: 200,
          headers: {},
          body: JSON.stringify({ flavors: [{ name: 'a1', vcpus: 1, ram: 2048, disk: 20 }] }),
        }
      : { status: 500, headers: {}, body: '{}' };
const awsClients = (): AwsClients => {
  const send = async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'GetCallerIdentityCommand') {
      throw Object.assign(new Error('bad key'), { name: 'InvalidClientTokenId' });
    }
    return {};
  };
  return { sts: { send }, iam: { send }, ec2: { send } } as AwsClients;
};

/** Fake Proxmox VE API for the credential test. */
const pveHttp: HttpFn = async (url) => {
  const path = url.replace(/^https:\/\/pve\.example:8006\/api2\/json/, '');
  const data: Record<string, unknown> = {
    '/version': { version: '9.2.21' },
    '/access/permissions': {
      '/': Object.fromEntries(PROXMOX_REQUIRED_PRIVILEGES.map((p) => [p.privilege, 1])),
    },
    '/nodes': [{ node: 'pve1', status: 'online' }],
  };
  return path in data
    ? { status: 200, headers: {}, body: JSON.stringify({ data: data[path] }) }
    : { status: 404, headers: {}, body: '{}' };
};
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

const CLOUDS = `clouds:
  infomaniak:
    auth: { auth_url: "https://api.example/identity", application_credential_id: id, application_credential_secret: TOP-SECRET }
    region_name: dc4-a
    auth_type: v3applicationcredential
`;
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('credentials API (FP-4)', () => {
  let app: NestExpressApplication;
  let admin: string;
  let viewer: string;
  const CSRF = { 'x-capi-navigator': '1' };
  const base = '/api/connections/kind/credentials';
  const req = () => request(app.getHttpServer());
  const post = (path: string, body: object, cookie = admin) =>
    req().post(`${base}${path}`).set(CSRF).set('Cookie', cookie).send(body);
  const osBody = (over: object = {}) => ({
    provider: 'openstack',
    name: 'infomaniak',
    allowedNamespaces: ['default'],
    openstack: { source: 'clouds.yaml', cloudsYaml: CLOUDS },
    ...over,
  });

  async function activate(username: string, pw: string): Promise<string> {
    const cookieOf = (res: request.Response) =>
      ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .find((c) => c.startsWith(SESSION_COOKIE))!
        .split(';')[0]!;
    const login = await req().post('/api/auth/login').set(CSRF).send({ username, password: pw });
    const changed = await req()
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', cookieOf(login))
      .send({ currentPassword: pw, newPassword: `${pw}-new` });
    return cookieOf(changed);
  }

  beforeAll(async () => {
    const fake = createFakeStore();
    const config = loadConfig({ INITIAL_ADMIN_PASSWORD: 'Admin-Pw-1', LOG_JSON: 'false' });
    const plugins: CredentialPlugin[] = [
      new OpenStackCredentialPlugin(http()),
      new AwsCredentialPlugin(awsClients),
      // Google endpoints that refuse at once: these tests cover storage, not the cloud test.
      new GcpCredentialPlugin({
        compute: 'http://127.0.0.1:1',
        resourceManager: 'http://127.0.0.1:1',
      }),
      new ProxmoxCredentialPlugin(pveHttp),
    ];
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, KubeModule, StoreModule, AuditModule, AuthModule, CredentialsModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(StoreService)
      .useValue(fake.store)
      .overrideProvider(KubeClientFactory)
      .useValue({ homeCluster: () => ({ makeApiClient: () => ({}) }) })
      .overrideProvider(ManagementClusterClients)
      .useValue({ forConnection: async () => fakeKc })
      .overrideProvider(CREDENTIAL_PLUGINS)
      .useValue(plugins)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app, config);
    await app.init();
    admin = await activate('admin', 'Admin-Pw-1');
    await req()
      .post('/api/users')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ username: 'vera', role: 'viewer', password: 'Viewer-Pw-1' });
    viewer = await activate('vera', 'Viewer-Pw-1');
  });
  afterAll(async () => app?.close());
  beforeEach(() => {
    mc.secrets.clear();
    mc.identities.clear();
    mc.clusters = [];
    mc.providers = [
      { kind: 'InfrastructureProvider', metadata: { name: 'openstack', namespace: 'capo-system' } },
      { kind: 'InfrastructureProvider', metadata: { name: 'aws', namespace: 'capa-system' } },
      { kind: 'InfrastructureProvider', metadata: { name: 'gcp', namespace: 'capg-system' } },
      { kind: 'InfrastructureProvider', metadata: { name: 'proxmox', namespace: 'capmox-system' } },
    ];
  });

  it('requires the provider to be installed (FP-3 first)', async () => {
    mc.providers = [];
    const res = await post('', osBody()).expect(409);
    expect(res.body.hint).toMatch(/Providers page/);
  });

  it('previews with masked secret values (hard rule 6)', async () => {
    const res = await post('/preview', osBody()).expect(200);
    expect(res.body.objects.map((o: { kind: string }) => o.kind)).toEqual([
      'Secret',
      'OpenStackClusterIdentity',
    ]);
    expect(res.body.yaml).toContain('clouds.yaml: "********"');
    expect(res.body.yaml).not.toContain('TOP-SECRET');
    expect(mc.secrets.size).toBe(0);
  });

  it('creates, tests and lists an OpenStack credential without secrets (FP4-F-03, FP4-F-06)', async () => {
    const res = await post('', osBody({ displayName: 'Infomaniak dc4' })).expect(201);
    expect(res.body).toMatchObject({
      name: 'infomaniak',
      displayName: 'Infomaniak dc4',
      allowedNamespaces: ['default'],
      secret: { name: 'capi-navigator-credential-infomaniak', namespace: 'capo-system' },
      lastTest: { ok: true, identity: 'Project PCP-1' },
    });
    const list = await req().get(base).set('Cookie', viewer).expect(200);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('TOP-SECRET');
    await post('', osBody()).expect(409);
  });

  it('leaves nothing behind when the identity is refused, so a retry works', async () => {
    const body = {
      provider: 'aws',
      name: 'aws-retry',
      aws: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: AWS_SECRET,
        region: 'eu-central-1',
      },
    };
    mc.refuseIdentities = true;
    try {
      await post('', body).expect(502);
    } finally {
      mc.refuseIdentities = false;
    }
    expect(
      [...mc.secrets.keys()].some((k) => k.endsWith('capi-navigator-credential-aws-retry')),
    ).toBe(false);
    await post('', body).expect(201);
    await req().delete(`${base}/aws/aws-retry`).set(CSRF).set('Cookie', admin).expect(204);
  });

  it('creates an AWS credential and reports a rejected key', async () => {
    const res = await post('', {
      provider: 'aws',
      name: 'aws-dev',
      aws: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: AWS_SECRET,
        region: 'eu-central-1',
      },
    }).expect(201);
    expect(res.body).toMatchObject({
      provider: 'aws',
      secret: { namespace: 'capa-system' },
      lastTest: { ok: false },
    });
    expect(JSON.stringify(res.body)).not.toContain(AWS_SECRET);
  });

  it('validates input with the shared schemas and plugin rules', async () => {
    const bad = await post(
      '',
      osBody({ openstack: { source: 'clouds.yaml', cloudsYaml: 'nope: [' } }),
    ).expect(400);
    expect(bad.body.message).toMatch(/not valid YAML/);
    await post('', {
      provider: 'aws',
      name: 'x',
      aws: { accessKeyId: 'nope', secretAccessKey: 'x', region: 'mars' },
    }).expect(400);
    const info = await post('/clouds-yaml-info', { cloudsYaml: CLOUDS }).expect(200);
    expect(info.body.clouds[0]).toMatchObject({ name: 'infomaniak', region: 'dc4-a' });
    expect(JSON.stringify(info.body)).not.toContain('TOP-SECRET');
  });

  it('updates namespaces, replaces secrets and refuses the wrong provider block', async () => {
    await post('', osBody()).expect(201);
    const path = `${base}/openstack/infomaniak`;
    const ns = await req()
      .patch(path)
      .set(CSRF)
      .set('Cookie', admin)
      .send({ allowedNamespaces: ['default', 'prod'] })
      .expect(200);
    expect(ns.body.allowedNamespaces).toEqual(['default', 'prod']);
    await req()
      .patch(path)
      .set(CSRF)
      .set('Cookie', admin)
      .send({
        aws: {
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: AWS_SECRET,
          region: 'eu-central-1',
        },
      })
      .expect(400);
    const replaced = await req()
      .patch(path)
      .set(CSRF)
      .set('Cookie', admin)
      .send({
        openstack: {
          source: 'clouds.yaml',
          cloudsYaml: CLOUDS.replace('TOP-SECRET', 'NEW-SECRET'),
        },
      })
      .expect(200);
    expect(replaced.body.lastTest.ok).toBe(true);
    await post('/openstack/infomaniak/test', {}).expect(200);
  });

  it('refuses to delete credentials in use and deletes otherwise', async () => {
    await post('', osBody()).expect(201);
    mc.clusters = [
      {
        metadata: { name: 'prod', namespace: 'default' },
        spec: { identityRef: { name: 'infomaniak' } },
      },
    ];
    const refused = await req()
      .delete(`${base}/openstack/infomaniak`)
      .set(CSRF)
      .set('Cookie', admin)
      .expect(409);
    expect(refused.body.hint).toContain('default/prod');
    mc.clusters = [];
    await req().delete(`${base}/openstack/infomaniak`).set(CSRF).set('Cookie', admin).expect(204);
    expect(mc.secrets.size + mc.identities.size).toBe(0);
  });

  it('stores Google Cloud credentials without identity resource, namespaces on the Secret (FP25-F-02)', async () => {
    const key = JSON.stringify({
      type: 'service_account',
      project_id: 'demo-proj',
      private_key: '-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----\n',
      client_email: 'capi@demo-proj.iam.gserviceaccount.com',
      token_uri: 'http://127.0.0.1:1/token',
    });
    const created = await post('', {
      provider: 'gcp',
      name: 'gcloud',
      allowedNamespaces: ['team-a'],
      gcp: { serviceAccountKey: key, region: 'europe-west6' },
    }).expect(201);
    expect(created.body).toMatchObject({
      provider: 'gcp',
      allowedNamespaces: ['team-a'],
      summary: { projectId: 'demo-proj', region: 'europe-west6' },
      identity: { apiVersion: 'v1', kind: 'Secret', name: 'capi-navigator-credential-gcloud' },
      secret: { name: 'capi-navigator-credential-gcloud', namespace: 'capg-system' },
      lastTest: { ok: false },
    });
    expect(JSON.stringify(created.body)).not.toContain('secret-material');
    expect(mc.identities.size).toBe(0);
    const secret = mc.secrets.get('capg-system/capi-navigator-credential-gcloud')!;
    expect(Buffer.from(secret.data!.credentials!, 'base64').toString()).toBe(key);

    const updated = await req()
      .patch(`${base}/gcp/gcloud`)
      .set(CSRF)
      .set('Cookie', admin)
      .send({ allowedNamespaces: ['team-a', 'team-b'] })
      .expect(200);
    expect(updated.body.allowedNamespaces).toEqual(['team-a', 'team-b']);

    mc.clusters = [
      {
        metadata: { name: 'gke-less', namespace: 'team-a' },
        spec: {
          credentialsRef: { name: 'capi-navigator-credential-gcloud', namespace: 'capg-system' },
        },
      },
    ];
    const refused = await req()
      .delete(`${base}/gcp/gcloud`)
      .set(CSRF)
      .set('Cookie', admin)
      .expect(409);
    expect(refused.body.hint).toContain('team-a/gke-less');
    mc.clusters = [];
    await req().delete(`${base}/gcp/gcloud`).set(CSRF).set('Cookie', admin).expect(204);
    expect(mc.secrets.size).toBe(0);
  });

  it('stores Proxmox VE credentials with machine sizes and a CA (FP31-F-02..04, F-09)', async () => {
    const pve = (over: object = {}) => ({
      url: 'https://pve.example:8006',
      tokenId: 'capmox@pve!capi',
      tokenSecret: 'PVE-TOKEN-SECRET',
      caCert: PEM,
      ...over,
    });
    const created = await post('', {
      provider: 'proxmox',
      name: 'homelab',
      allowedNamespaces: ['default'],
      proxmox: pve(),
    }).expect(201);
    expect(created.body.summary.machineSizes.map((m: { name: string }) => m.name)).toEqual([
      'small',
      'medium',
      'large',
      'xlarge',
    ]);
    expect(JSON.stringify(created.body)).not.toContain('PVE-TOKEN-SECRET');
    // The installed CAPMOX does not run with this CA yet: the test says so.
    expect(created.body.lastTest.checks).toContainEqual(
      expect.objectContaining({ id: 'provider-ca', ok: false, warning: true }),
    );
    const secret = mc.secrets.get('capmox-system/capi-navigator-credential-homelab')!;
    expect(Object.keys(secret.data!).sort()).toEqual(['ca.crt', 'secret', 'token', 'url']);

    const patch = (body: object) =>
      req().patch(`${base}/proxmox/homelab`).set(CSRF).set('Cookie', admin).send(body);
    const sizes = [{ name: 'tiny', vcpus: 1, memoryMiB: 2048 }];
    // Sizes only, without the token (FP31-F-04).
    expect((await patch({ machineSizes: sizes }).expect(200)).body.summary.machineSizes).toEqual(
      sizes,
    );
    expect(mc.secrets.get('capmox-system/capi-navigator-credential-homelab')!.data!.secret).toBe(
      secret.data!.secret,
    );
    // A new token keeps the sizes the admin set.
    const renewed = await patch({ proxmox: pve({ tokenSecret: 'NEW-SECRET' }) }).expect(200);
    expect(renewed.body.summary.machineSizes).toEqual(sizes);
    // Sizes belong to Proxmox credentials only.
    await post('', osBody()).expect(201);
    await req()
      .patch(`${base}/openstack/infomaniak`)
      .set(CSRF)
      .set('Cookie', admin)
      .send({ machineSizes: sizes })
      .expect(400);

    // Clusters reference a copy; the annotation on the ProxmoxCluster names the credential.
    mc.clusters = [
      {
        metadata: {
          name: 'pve-rke2',
          namespace: 'default',
          annotations: { 'capi-navigator.io/credential': 'homelab' },
        },
        spec: { credentialsRef: { name: 'pve-rke2-proxmox-credentials', namespace: 'default' } },
      },
    ];
    const refused = await req()
      .delete(`${base}/proxmox/homelab`)
      .set(CSRF)
      .set('Cookie', admin)
      .expect(409);
    expect(refused.body.hint).toContain('default/pve-rke2');
    mc.clusters = [];
  });

  it('enforces roles: viewers read, operators look up, admins change', async () => {
    await post('', osBody()).expect(201);
    await post('', osBody({ name: 'x2' }), viewer).expect(403);
    await req()
      .get(`${base}/openstack/infomaniak/lookups/flavors`)
      .set('Cookie', viewer)
      .expect(403);
    const res = await req()
      .get(`${base}/openstack/infomaniak/lookups/flavors`)
      .set('Cookie', admin)
      .expect(200);
    expect(res.body.options[0].value).toBe('a1');
    await req()
      .get(`${base}/openstack/infomaniak/lookups/regions`)
      .set('Cookie', admin)
      .expect(404);
    await req().get(`${base}/gcp/x`).set('Cookie', admin).expect(404);
  });
});
