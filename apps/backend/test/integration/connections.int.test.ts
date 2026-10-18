// FP-2 acceptance against the local kind cluster. Run with `pnpm test:int`.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  type KubernetesObject,
} from '@kubernetes/client-node';
import { MANAGEMENT_ACCESS_MANIFEST } from '@capi-navigator/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { AppModule } from '../../src/app.module.js';
import { SESSION_COOKIE } from '../../src/auth/session.service.js';
import { APP_CONFIG, loadConfig } from '../../src/config/config.js';
import { configureApp } from '../../src/configure-app.js';
import { requireKindCluster } from './kind-guard.js';

const NAMESPACE = `capi-navigator-it-${randomBytes(3).toString('hex')}`;
const ADMIN_PW = 'It-Admin-Pw-1';
const CSRF = { 'x-capi-navigator': '1' };

requireKindCluster();

describe('FP-2 acceptance against kind', () => {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);
  const objects = KubernetesObjectApi.makeApiClient(kc);
  const accessObjects = parseAllDocuments(MANAGEMENT_ACCESS_MANIFEST).map(
    (d) => d.toJS() as KubernetesObject,
  );
  let app: NestExpressApplication;
  let cookie: string;
  /** Secret values used in the tests; none of them may ever appear in an API response. */
  const secretValues: string[] = ['not-a-valid-token'];
  const http = () => request(app.getHttpServer());
  const post = (path: string, body: unknown) =>
    http()
      .post(path)
      .set(CSRF)
      .set('Cookie', cookie)
      .send(body as object);

  beforeAll(async () => {
    await core.createNamespace({ body: { metadata: { name: NAMESPACE } } });
    const config = loadConfig({
      ...process.env,
      NAVIGATOR_NAMESPACE: NAMESPACE,
      INITIAL_ADMIN_PASSWORD: ADMIN_PW,
      LOG_JSON: 'false',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
    configureApp(app, config);
    await app.init();

    const login = await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'admin', password: ADMIN_PW });
    const first = ([] as string[]).concat(login.headers['set-cookie'] ?? []);
    const changed = await http()
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', first.find((c) => c.startsWith(SESSION_COOKIE))!.split(';')[0]!)
      .send({ currentPassword: ADMIN_PW, newPassword: 'It-Admin-Pw-2' })
      .expect(200);
    const next = ([] as string[]).concat(changed.headers['set-cookie'] ?? []);
    cookie = next.find((c) => c.startsWith(SESSION_COOKIE))!.split(';')[0]!;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await core.deleteNamespace({ name: NAMESPACE }).catch(() => undefined);
    for (const obj of [...accessObjects].reverse()) {
      await objects.delete(obj).catch(() => undefined);
    }
  });

  it('adds the kind cluster via kubeconfig; the test shows version and "Reachable"', async () => {
    const kubeconfig = readFileSync(process.env.KUBECONFIG!, 'utf8');
    const contexts = await post('/api/connections/kubeconfig-contexts', { kubeconfig }).expect(200);
    expect(contexts.body.contexts[0].name).toBe(
      `kind-${process.env.KIND_CLUSTER_NAME ?? 'capi-navigator'}`,
    );

    const res = await post('/api/connections', {
      name: 'kind-kubeconfig',
      displayName: 'kind via kubeconfig',
      credentials: { authType: 'kubeconfig', kubeconfig },
    }).expect(201);
    expect(res.body.status).toMatchObject({ phase: 'Reachable' });
    expect(res.body.status.kubernetesVersion).toMatch(/^v1\./);
    expect(res.body.status.permissions.every((p: { allowed: boolean }) => p.allowed)).toBe(true);
  });

  it('adds the kind cluster via service account token from the access manifest', async () => {
    for (const obj of accessObjects) {
      await objects.patch(
        obj,
        undefined,
        undefined,
        'capi-navigator-it',
        true,
        PatchStrategy.ServerSideApply,
      );
    }
    let token: string | undefined;
    let ca: string | undefined;
    for (let i = 0; i < 20 && !token; i++) {
      const secret = await core.readNamespacedSecret({
        name: 'capi-navigator-token',
        namespace: 'capi-navigator-access',
      });
      token = secret.data?.token && Buffer.from(secret.data.token, 'base64').toString();
      ca = secret.data?.['ca.crt'] && Buffer.from(secret.data['ca.crt'], 'base64').toString();
      if (!token) await new Promise((r) => setTimeout(r, 500));
    }
    secretValues.push(token!);
    const res = await post('/api/connections', {
      name: 'kind-token',
      credentials: {
        authType: 'token',
        server: kc.getCurrentCluster()!.server,
        token,
        caCert: ca,
      },
    }).expect(201);
    expect(res.body.status).toMatchObject({ phase: 'Reachable' });
    expect(res.body.status.kubernetesVersion).toMatch(/^v1\./);
  }, 30_000);

  it('offers the home cluster itself as connection (FP2-F-03)', async () => {
    const res = await post('/api/connections', {
      name: 'home',
      credentials: { authType: 'in-cluster' },
    }).expect(201);
    expect(res.body).toMatchObject({ authType: 'in-cluster', status: { phase: 'Reachable' } });
  });

  it('reports an invalid token clearly', async () => {
    const res = await post('/api/connections', {
      name: 'bad-token',
      credentials: {
        authType: 'token',
        server: kc.getCurrentCluster()!.server,
        token: 'not-a-valid-token',
      },
    }).expect(201);
    // No CA given: the self-signed kind certificate is not trusted.
    expect(res.body.status).toMatchObject({ phase: 'Unreachable' });
    expect(res.body.status.message).toMatch(/not trusted/);

    const withCa = await http()
      .patch('/api/connections/bad-token')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({
        credentials: {
          authType: 'token',
          server: kc.getCurrentCluster()!.server,
          token: 'not-a-valid-token',
          caCert: Buffer.from(kc.getCurrentCluster()!.caData!, 'base64').toString(),
        },
      })
      .expect(200);
    expect(withCa.body.status).toMatchObject({ phase: 'Unauthorized' });
    expect(withCa.body.status.hint).toBeTruthy();
  });

  it('rejects an invalid kubeconfig with a clear message', async () => {
    const res = await post('/api/connections', {
      name: 'broken',
      credentials: { authType: 'kubeconfig', kubeconfig: 'clusters: [oops' },
    }).expect(400);
    expect(res.body.message).toMatch(/not valid YAML/);
    expect(res.body.fieldErrors['credentials.kubeconfig']).toBeDefined();
  });

  it('keeps credentials only in Secrets and never returns them', async () => {
    const list = await http().get('/api/connections').set('Cookie', cookie).expect(200);
    const text = JSON.stringify(list.body);
    const user = kc.getCurrentUser()!;
    for (const value of [...secretValues, user.keyData!, user.certData!]) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toMatch(/BEGIN (CERTIFICATE|RSA|EC|PRIVATE)/);
    const secrets = await core.listNamespacedSecret({ namespace: NAMESPACE });
    expect(secrets.items.map((s) => s.metadata?.name)).toEqual(
      expect.arrayContaining([
        'management-cluster-kind-kubeconfig-credentials',
        'management-cluster-kind-token-credentials',
      ]),
    );
  });

  it('deletes a connection with its Secret and records the actions in the audit log', async () => {
    await http().delete('/api/connections/bad-token').set(CSRF).set('Cookie', cookie).expect(204);
    const secret = await core
      .readNamespacedSecret({
        name: 'management-cluster-bad-token-credentials',
        namespace: NAMESPACE,
      })
      .catch(() => undefined);
    expect(secret).toBeUndefined();

    const events = await objects.list<
      KubernetesObject & { spec: { action: string; managementCluster?: string } }
    >('navigator.capi-navigator.io/v1alpha1', 'AuditEvent', NAMESPACE);
    const actions = events.items.map((e) => `${e.spec.action}:${e.spec.managementCluster ?? ''}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        'connection.create:kind-kubeconfig',
        'connection.create:kind-token',
        'connection.update:bad-token',
        'connection.delete:bad-token',
      ]),
    );
    expect(actions.some((a) => a.startsWith('connection.parse-kubeconfig'))).toBe(false);
  });
});
