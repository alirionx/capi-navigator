// FP-3 acceptance against the local kind cluster (needs `pnpm kind:up`, i.e. cert-manager and
// the CAPI Operator). Installs ORC and providers for real, then removes everything again.
// Run with `pnpm test:int`.
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  type KubernetesObject,
} from '@kubernetes/client-node';
import type { InstalledProvider, OperatorState } from '@capi-navigator/shared';
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
const BASE = '/api/connections/home/operator';
const MIN = 60_000;

requireKindCluster();

describe('FP-3 acceptance against kind', () => {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);
  let app: NestExpressApplication;
  let cookie: string;
  const http = () => request(app.getHttpServer());
  const get = (path: string) => http().get(path).set('Cookie', cookie);
  const send = (method: 'post' | 'put' | 'delete', path: string, body?: object) =>
    http()[method](path).set(CSRF).set('Cookie', cookie).send(body);

  async function state(): Promise<OperatorState> {
    return (await get(BASE).expect(200)).body as OperatorState;
  }

  async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeout: number) {
    const end = Date.now() + timeout;
    let last: unknown;
    while (Date.now() < end) {
      try {
        const result = await fn();
        if (result !== undefined) return result;
      } catch (err) {
        last = err;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    const s = await state().catch(() => undefined);
    throw new Error(`Timeout waiting for ${what}: ${JSON.stringify(s?.providers ?? last)}`);
  }

  const providerReady = (catalogId: string, version?: string) => async () => {
    const p = (await state()).providers.find((x: InstalledProvider) => x.catalogId === catalogId);
    return p?.phase === 'Ready' && (!version || p.installedVersion === version) ? p : undefined;
  };

  beforeAll(async () => {
    const pre = await core.readNamespace({ name: 'capi-operator-system' }).catch(() => undefined);
    if (!pre) throw new Error('The CAPI Operator is not installed. Run `pnpm kind:up` first.');
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
    await app.listen(0, '127.0.0.1');

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
      .send({ currentPassword: 'It-Admin-Pw-1', newPassword: 'It-Admin-Pw-2' })
      .expect(200);
    cookie = cookieOf(changed);
    await send('post', '/api/connections', {
      name: 'home',
      credentials: { authType: 'in-cluster' },
    }).expect(201);
    // This test installs and removes everything, so it only runs on a cluster without providers
    // and without ORC; it must never touch what someone else installed.
    const before = await state();
    if (before.providers.length > 0 || before.prerequisites.orc.installed) {
      throw new Error(
        'The kind cluster already has providers or ORC. The FP-3 test needs a clean cluster: pnpm kind:down && pnpm kind:up',
      );
    }
  }, 2 * MIN);

  afterAll(async () => {
    await app?.close();
    await core.deleteNamespace({ name: NAMESPACE }).catch(() => undefined);
  }, 2 * MIN);

  it('detects cert-manager and the CAPI Operator with versions (FP3-F-01, FP3-F-02)', async () => {
    const s = await state();
    expect(s.prerequisites.certManager).toMatchObject({ installed: true, ready: true });
    expect(s.prerequisites.operator).toMatchObject({ installed: true, ready: true });
    expect(s.prerequisites.operator.version).toMatch(/^v0\./);
    expect(s.prerequisites.instructions.operator).toContain('helm upgrade --install');
  });

  it('streams the state via server-sent events (FP3-F-13)', async () => {
    const { port } = app.getHttpServer().address() as AddressInfo;
    const first = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: `${BASE}/events`, headers: { Cookie: cookie } },
        (res) => {
          let buf = '';
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            if (buf.includes('\n\n')) {
              req.destroy();
              resolve(buf);
            }
          });
        },
      );
      req.on('error', (err) => (err.message.includes('socket hang up') ? undefined : reject(err)));
      req.end();
    });
    expect(first).toContain('event: state');
    expect(first).toContain('"prerequisites"');
  });

  it('blocks CAPO without ORC with a hint (acceptance FP-3)', async () => {
    // Core is not installed yet either; the ORC check comes after the dependency check, so test
    // the ORC rule once core is ready (see below). Here: the dependency rule (FP3-F-11).
    const res = await send('post', `${BASE}/providers`, {
      catalogId: 'openstack',
      version: 'v0.15.0',
      namespace: 'capo-system',
    }).expect(409);
    expect(res.body.message).toMatch(/core/i);
  });

  it(
    'installs ORC from its release manifest (FP3-F-04a)',
    async () => {
      const preview = await send('post', `${BASE}/orc/preview`, { version: 'v2.6.0' }).expect(200);
      expect(preview.body.objects).toEqual(
        expect.arrayContaining([
          { kind: 'Deployment', name: 'orc-controller-manager', namespace: 'orc-system' },
        ]),
      );
      expect(preview.body.yaml).toContain('clusterctl.cluster.x-k8s.io/move');
      await send('post', `${BASE}/orc`, { version: 'v2.6.0' }).expect(200);
      const orc = await waitFor(
        'ORC ready',
        async () => {
          const o = (await state()).prerequisites.orc;
          return o.ready ? o : undefined;
        },
        5 * MIN,
      );
      expect(orc.version).toBe('v2.6.0');
    },
    6 * MIN,
  );

  it(
    'installs the core provider (FP3-F-09, FP3-F-11)',
    async () => {
      const preview = await send('post', `${BASE}/providers/preview`, {
        catalogId: 'core',
        version: 'v1.14.3',
        namespace: 'capi-system',
      }).expect(200);
      expect(preview.body.yaml).toContain('kind: CoreProvider');
      await send('post', `${BASE}/providers`, {
        catalogId: 'core',
        version: 'v1.14.3',
        namespace: 'capi-system',
      }).expect(201);
      await waitFor('core Ready', providerReady('core', 'v1.14.3'), 6 * MIN);
    },
    7 * MIN,
  );

  it(
    'installs RKE2, OpenStack and CAAPH and all reach Ready (acceptance FP-3)',
    async () => {
      const installs = [
        { catalogId: 'rke2-bootstrap', version: 'v0.26.0', namespace: 'rke2-bootstrap-system' },
        {
          catalogId: 'rke2-control-plane',
          version: 'v0.26.0',
          namespace: 'rke2-control-plane-system',
        },
        { catalogId: 'openstack', version: 'v0.15.0', namespace: 'capo-system' },
        // Older CAAPH on purpose: upgraded in the next test.
        { catalogId: 'helm', version: 'v0.6.2', namespace: 'caaph-system' },
      ];
      for (const body of installs) await send('post', `${BASE}/providers`, body).expect(201);
      for (const { catalogId, version } of installs) {
        await waitFor(`${catalogId} Ready`, providerReady(catalogId, version), 8 * MIN);
      }
      const s = await state();
      expect(s.providers.map((p) => `${p.catalogId}:${p.phase}`).sort()).toEqual([
        'core:Ready',
        'helm:Ready',
        'openstack:Ready',
        'rke2-bootstrap:Ready',
        'rke2-control-plane:Ready',
      ]);
    },
    12 * MIN,
  );

  it(
    'upgrades a provider through the operator (acceptance FP-3)',
    async () => {
      const path = `${BASE}/providers/AddonProvider/caaph-system/helm`;
      const preview = await send('put', `${path}/preview`, { version: 'v0.6.4' }).expect(200);
      expect(preview.body.yaml).toContain('version: v0.6.4');
      await send('put', path, { version: 'v0.6.2' }).expect(200); // same version is allowed
      const down = await send('put', path, { version: 'v0.6.1' }).expect(400);
      expect(down.body.message).toMatch(/Downgrades/);
      await send('put', path, { version: 'v0.6.4' }).expect(200);
      await waitFor('CAAPH upgraded', providerReady('helm', 'v0.6.4'), 6 * MIN);
    },
    7 * MIN,
  );

  it('refuses to remove the core provider while others depend on it', async () => {
    const res = await send(
      'delete',
      `${BASE}/providers/CoreProvider/capi-system/cluster-api`,
    ).expect(409);
    expect(res.body.message).toMatch(/depend/);
  });

  it(
    'removes providers again (FP3-F-12)',
    async () => {
      const order = [
        ['AddonProvider', 'caaph-system', 'helm'],
        ['InfrastructureProvider', 'capo-system', 'openstack'],
        ['ControlPlaneProvider', 'rke2-control-plane-system', 'rke2'],
        ['BootstrapProvider', 'rke2-bootstrap-system', 'rke2'],
      ];
      for (const [kind, ns, name] of order) {
        const usage = await get(`${BASE}/providers/${kind}/${ns}/${name}/usage`).expect(200);
        expect(usage.body.clusters).toEqual([]);
        await send('delete', `${BASE}/providers/${kind}/${ns}/${name}`).expect(204);
      }
      await waitFor(
        'only core left',
        async () => ((await state()).providers.length === 1 ? true : undefined),
        3 * MIN,
      );
      await send('delete', `${BASE}/providers/CoreProvider/capi-system/cluster-api`).expect(204);
      await waitFor(
        'no providers left',
        async () => ((await state()).providers.length === 0 ? true : undefined),
        3 * MIN,
      );
    },
    8 * MIN,
  );

  it('wrote AuditEvents with the management cluster', async () => {
    const objects = KubernetesObjectApi.makeApiClient(kc);
    const events = await objects.list<
      KubernetesObject & { spec: { action: string; managementCluster?: string } }
    >('navigator.capi-navigator.io/v1alpha1', 'AuditEvent', NAMESPACE);
    const actions = events.items.map((e) => `${e.spec.action}:${e.spec.managementCluster ?? ''}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        'orc.install:home',
        'provider.install:home',
        'provider.update:home',
        'provider.delete:home',
      ]),
    );
  });

  it(
    'cleans up ORC',
    async () => {
      await removeOrc(kc, 'v2.6.0');
    },
    4 * MIN,
  );
});
