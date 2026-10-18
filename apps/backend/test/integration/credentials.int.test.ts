// FP-4 against the local kind cluster: credentials are stored as Secret + cluster-scoped identity
// and accepted by the real CAPO/CAPA CRDs (ADR-0002). Installs core, ORC, CAPO and CAPA first and
// removes everything afterwards. With OPENSTACK_CLOUDS_YAML set, the OpenStack credential is
// tested against the real cloud (read-only). The AWS key is a dummy: STS just rejects it.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CoreV1Api, CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';
import type { Credential, OperatorState } from '@capi-navigator/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { SESSION_COOKIE } from '../../src/auth/session.service.js';
import { APP_CONFIG, loadConfig } from '../../src/config/config.js';
import { configureApp } from '../../src/configure-app.js';
import { requireKindCluster } from './kind-guard.js';
import { removeOrc } from './orc.js';

const NAMESPACE = `capi-navigator-it-${randomBytes(3).toString('hex')}`;
const CSRF = { 'x-capi-navigator': '1' };
const OP = '/api/connections/home/operator';
const CRED = '/api/connections/home/credentials';
const MIN = 60_000;
const cloudsYamlPath = process.env.OPENSTACK_CLOUDS_YAML;
const DUMMY_SECRET = 'dummySecretKeyThatIsNotValid0123456789ABCD';
const FAKE_CLOUDS = `clouds:
  test:
    auth:
      auth_url: https://keystone.invalid:5000/v3
      application_credential_id: fake-id
      application_credential_secret: fake-secret-value
    region_name: RegionOne
    auth_type: v3applicationcredential
`;

requireKindCluster();

describe('FP-4 credentials against kind', () => {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);
  const custom = kc.makeApiClient(CustomObjectsApi);
  let app: NestExpressApplication;
  let cookie: string;
  /** Catalog ids (and "orc") this test installed itself; only these are removed again. */
  const installedByTest: string[] = [];
  const http = () => request(app.getHttpServer());
  const get = (path: string) => http().get(path).set('Cookie', cookie);
  const send = (method: 'post' | 'patch' | 'delete', path: string, body?: object) =>
    http()[method](path).set(CSRF).set('Cookie', cookie).send(body);

  async function waitFor(what: string, fn: () => Promise<boolean>, timeout: number) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn().catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`Timeout waiting for ${what}`);
  }
  const ready = (id: string) => async () =>
    ((await get(OP)).body as OperatorState).providers.some(
      (p) => p.catalogId === id && p.phase === 'Ready',
    );

  beforeAll(async () => {
    await core.createNamespace({ body: { metadata: { name: NAMESPACE } } });
    const config = loadConfig({
      ...process.env,
      NAVIGATOR_NAMESPACE: NAMESPACE,
      INITIAL_ADMIN_PASSWORD: 'It-Admin-Pw-1',
      LOG_JSON: 'false',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
    configureApp(app, config);
    await app.init();
    const cookieOf = (res: request.Response) =>
      ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .find((c) => c.startsWith(SESSION_COOKIE))!
        .split(';')[0]!;
    const login = await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'admin', password: 'It-Admin-Pw-1' });
    const changed = await http()
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', cookieOf(login))
      .send({ currentPassword: 'It-Admin-Pw-1', newPassword: 'It-Admin-Pw-2' });
    cookie = cookieOf(changed);
    await send('post', '/api/connections', {
      name: 'home',
      credentials: { authType: 'in-cluster' },
    }).expect(201);

    // Providers from FP-3: install only what is missing and remember it, so the cleanup never
    // removes anything that was there before (e.g. installed by hand via the UI).
    const before = (await get(OP).expect(200)).body as OperatorState;
    if (!before.prerequisites.orc.installed) {
      await send('post', `${OP}/orc`, { version: 'v2.6.0' }).expect(200);
      installedByTest.push('orc');
    }
    const has = (id: string) => before.providers.some((p) => p.catalogId === id);
    for (const [id, version, namespace] of [
      ['core', 'v1.14.3', 'capi-system'],
      ['openstack', 'v0.15.0', 'capo-system'],
      ['aws', 'v2.13.1', 'capa-system'],
    ] as const) {
      if (has(id)) continue;
      if (id !== 'core') {
        await waitFor('core', ready('core'), 6 * MIN);
        await waitFor(
          'ORC',
          async () => ((await get(OP)).body as OperatorState).prerequisites.orc.ready,
          5 * MIN,
        );
      }
      await send('post', `${OP}/providers`, { catalogId: id, version, namespace }).expect(201);
      installedByTest.push(id);
    }
    await waitFor('CAPO', ready('openstack'), 8 * MIN);
    await waitFor('CAPA', ready('aws'), 8 * MIN);
  }, 25 * MIN);

  afterAll(async () => {
    // Remove only what this test installed (see beforeAll).
    const remove: [string, string, string, string][] = [
      ['aws', 'InfrastructureProvider', 'capa-system', 'aws'],
      ['openstack', 'InfrastructureProvider', 'capo-system', 'openstack'],
    ];
    for (const [id, kind, ns, name] of remove) {
      if (installedByTest.includes(id)) {
        await send('delete', `${OP}/providers/${kind}/${ns}/${name}?force=true`).catch(
          () => undefined,
        );
      }
    }
    if (installedByTest.includes('core')) {
      await waitFor(
        'infra providers gone',
        async () => ((await get(OP)).body as OperatorState).providers.length === 1,
        4 * MIN,
      ).catch(() => undefined);
      await send('delete', `${OP}/providers/CoreProvider/capi-system/cluster-api`).catch(
        () => undefined,
      );
      // Wait until it is gone, so a following test finds the cluster as it was before.
      await waitFor(
        'no providers left',
        async () => ((await get(OP)).body as OperatorState).providers.length === 0,
        3 * MIN,
      ).catch(() => undefined);
    }
    if (installedByTest.includes('orc')) await removeOrc(kc, 'v2.6.0').catch(() => undefined);
    await app?.close();
    await core.deleteNamespace({ name: NAMESPACE }).catch(() => undefined);
  }, 8 * MIN);

  it('stores an OpenStack credential as Secret + OpenStackClusterIdentity accepted by CAPO', async () => {
    const cloudsYaml = cloudsYamlPath ? readFileSync(cloudsYamlPath, 'utf8') : FAKE_CLOUDS;
    const body = {
      provider: 'openstack',
      name: 'it-openstack',
      displayName: 'Integration test',
      allowedNamespaces: ['default', 'team-a'],
      openstack: { source: 'clouds.yaml', cloudsYaml },
    };
    const preview = await send('post', `${CRED}/preview`, body).expect(200);
    expect(preview.body.yaml).toContain('kind: OpenStackClusterIdentity');
    expect(preview.body.yaml).not.toMatch(/application_credential_secret|fake-secret-value/);

    const res = await send('post', CRED, body).expect(201);
    const cred = res.body as Credential;
    expect(cred).toMatchObject({
      provider: 'openstack',
      allowedNamespaces: ['default', 'team-a'],
      identity: { kind: 'OpenStackClusterIdentity', name: 'it-openstack' },
      secret: { namespace: 'capo-system' },
    });
    expect(cred.lastTest?.ok).toBe(!!cloudsYamlPath);
    if (cloudsYamlPath) expect(cred.lastTest?.identity).toMatch(/^Project /);
    expect(JSON.stringify(res.body)).not.toMatch(/application_credential_secret|fake-secret-value/);

    const secret = await core.readNamespacedSecret({
      name: cred.secret.name,
      namespace: 'capo-system',
    });
    expect(Object.keys(secret.data ?? {})).toEqual(['clouds.yaml']);
    const identity = (await custom.getClusterCustomObject({
      group: 'infrastructure.cluster.x-k8s.io',
      version: 'v1alpha1',
      plural: 'openstackclusteridentities',
      name: 'it-openstack',
    })) as { spec: { secretRef: { name: string; namespace: string } } };
    expect(identity.spec.secretRef).toEqual({ name: cred.secret.name, namespace: 'capo-system' });
  });

  it(
    'serves OpenStack selection lists (FP4-F-05)',
    async () => {
      if (!cloudsYamlPath) return;
      for (const kind of ['images', 'flavors', 'externalNetworks']) {
        const res = await get(`${CRED}/openstack/it-openstack/lookups/${kind}`).expect(200);
        expect(res.body.options.length).toBeGreaterThan(0);
      }
    },
    2 * MIN,
  );

  it(
    'stores an AWS credential as Secret + AWSClusterStaticIdentity accepted by CAPA',
    async () => {
      const res = await send('post', CRED, {
        provider: 'aws',
        name: 'it-aws',
        allowedNamespaces: ['default'],
        aws: {
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: DUMMY_SECRET,
          region: 'eu-central-1',
        },
      }).expect(201);
      const cred = res.body as Credential;
      expect(cred).toMatchObject({
        provider: 'aws',
        summary: { region: 'eu-central-1', accessKeyIdSuffix: 'MPLE' },
        identity: { kind: 'AWSClusterStaticIdentity', name: 'it-aws' },
        secret: { namespace: 'capa-system' },
      });
      // The dummy key is rejected by STS: an understandable message, no secret in the response.
      expect(cred.lastTest).toMatchObject({ ok: false, message: 'AWS rejected the access key' });
      expect(JSON.stringify(res.body)).not.toContain(DUMMY_SECRET);

      const secret = await core.readNamespacedSecret({
        name: cred.secret.name,
        namespace: 'capa-system',
      });
      expect(Object.keys(secret.data ?? {}).sort()).toEqual(['AccessKeyID', 'SecretAccessKey']);
      const identity = (await custom.getClusterCustomObject({
        group: 'infrastructure.cluster.x-k8s.io',
        version: 'v1beta2',
        plural: 'awsclusterstaticidentities',
        name: 'it-aws',
      })) as { spec: { secretRef: string; allowedNamespaces: { list: string[] } } };
      expect(identity.spec).toMatchObject({
        secretRef: cred.secret.name,
        allowedNamespaces: { list: ['default'] },
      });
    },
    2 * MIN,
  );

  const ownNames = (list: Credential[]) =>
    list.map((c) => c.name).filter((n) => n.startsWith('it-'));

  it('lists credentials without secrets and updates allowed namespaces', async () => {
    const list = await get(CRED).expect(200);
    // Only the test's own credentials: a dev cluster may hold real ones (never touched here).
    expect(ownNames(list.body as Credential[])).toEqual(['it-aws', 'it-openstack']);
    expect(JSON.stringify(list.body)).not.toContain(DUMMY_SECRET);
    const updated = await send('patch', `${CRED}/aws/it-aws`, {
      allowedNamespaces: ['default', 'prod'],
    }).expect(200);
    expect(updated.body.allowedNamespaces).toEqual(['default', 'prod']);
  });

  it('deletes credentials with Secret and identity', async () => {
    for (const [provider, name] of [
      ['aws', 'it-aws'],
      ['openstack', 'it-openstack'],
    ]) {
      await send('delete', `${CRED}/${provider}/${name}`).expect(204);
    }
    expect(ownNames((await get(CRED).expect(200)).body as Credential[])).toEqual([]);
  });
});
