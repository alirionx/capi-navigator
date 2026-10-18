// FP-17 node shell against the local kind cluster (management cluster node). Run with `pnpm test:int`.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { SHELL_LABEL, SHELL_NAMESPACE } from '@capi-navigator/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AppModule } from '../../src/app.module.js';
import { SESSION_COOKIE } from '../../src/auth/session.service.js';
import { APP_CONFIG, loadConfig } from '../../src/config/config.js';
import { configureApp } from '../../src/configure-app.js';
import { requireKindCluster } from './kind-guard.js';

const NAMESPACE = `capi-navigator-it-${randomBytes(3).toString('hex')}`;
const ADMIN_PW = 'It-Admin-Pw-1';
const CSRF = { 'x-capi-navigator': '1' };

requireKindCluster();

describe('FP-17 node shell against kind', () => {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);
  let app: NestExpressApplication;
  let cookie: string;
  let port: number;
  const http = () => request(app.getHttpServer());

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
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: ['error'],
      forceCloseConnections: true,
    });
    configureApp(app, config);
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;

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

    await http()
      .post('/api/connections')
      .set(CSRF)
      .set('Cookie', cookie)
      .send({
        name: 'kind-shell',
        credentials: {
          authType: 'kubeconfig',
          kubeconfig: readFileSync(process.env.KUBECONFIG!, 'utf8'),
        },
      })
      .expect(201);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await core.deleteNamespace({ name: NAMESPACE }).catch(() => undefined);
  });

  it('lists the nodes and runs a root shell in the host namespaces; the pod is removed', async () => {
    const nodes = await http()
      .get('/api/connections/kind-shell/nodes')
      .set('Cookie', cookie)
      .expect(200);
    const node = nodes.body[0].name as string;

    const url = `ws://127.0.0.1:${port}/api/connections/kind-shell/nodes/${node}/shell`;
    // Without Origin (cross-site protection) the upgrade is refused.
    const refused = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { headers: { cookie } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    expect(refused).toBe(403);

    const output = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { cookie, origin: `http://127.0.0.1:${port}` } });
      let out = '';
      ws.on('message', (data, binary) => {
        if (binary) {
          out += String(data);
          return;
        }
        const msg = JSON.parse(String(data)) as { type: string; state?: string; message?: string };
        if (msg.type === 'error') reject(new Error(msg.message));
        if (msg.state === 'connected') {
          ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
          setTimeout(
            () =>
              ws.send(
                JSON.stringify({
                  type: 'input',
                  data: 'echo "N=$(hostname) P=$(cat /proc/1/comm)"; exit\n',
                }),
              ),
            500,
          );
        }
      });
      ws.on('close', () => resolve(out));
    });
    expect(output).toContain(`N=${node} P=systemd`);

    // The session ended: no shell pod remains.
    let left = 1;
    for (let i = 0; i < 20 && left > 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      left = (
        await core.listNamespacedPod({
          namespace: SHELL_NAMESPACE,
          labelSelector: `${SHELL_LABEL}=true`,
        })
      ).items.filter((p) => !p.metadata?.deletionTimestamp).length;
    }
    expect(left).toBe(0);
  }, 180_000);
});
