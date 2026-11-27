import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as openpgp from 'openpgp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SESSION_COOKIE } from '../auth/session.service.js';
import { APP_CONFIG, loadConfig } from '../config/config.js';
import { ConfigModule } from '../config/config.module.js';
import { configureApp } from '../configure-app.js';
import { readFromChartArchive } from '../helm/chart-archive.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { KubeModule } from '../kube/kube.module.js';
import { StoreModule } from '../store/store.module.js';
import { StoreService } from '../store/store.service.js';
import { createFakeStore } from '../testing/fake-store.js';
import { backupStore } from './backup.fixtures.js';
import { BackupModule } from './backup.module.js';

const ADMIN_PW = 'Initial-Admin-Pw-1';
const CSRF = { 'x-capi-navigator': '1' };

/** The fake store of the auth tests, plus what the backup reads. */
function store() {
  const fake = createFakeStore();
  const backup = backupStore().store as unknown as Record<string, Record<string, unknown>>;
  const merged = { ...(fake.store as unknown as Record<string, Record<string, unknown>>) };
  for (const k of [
    'connections',
    'helmRepositories',
    'roles',
    'groups',
    'users',
    'tokens',
    'authSettings',
    'blueprints',
  ]) {
    merged[k] = { ...merged[k], list: backup[k]!.list };
  }
  merged.backupSettings = backup.backupSettings!;
  merged.secrets = { ...merged.secrets, getRaw: backup.secrets!.getRaw };
  Object.assign(merged, { addonPresetOverridesConfigMap: backup.addonPresetOverridesConfigMap });
  return { fake, store: merged as unknown as StoreService };
}

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('backup endpoints over HTTP (FP-38)', () => {
  let app: NestExpressApplication;
  let fake: ReturnType<typeof createFakeStore>;
  let admin: string;
  let key: { publicKey: string; privateKey: string };
  const http = () => request(app.getHttpServer());
  const cookieFrom = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
      .split(';')[0]!;

  beforeAll(async () => {
    const s = store();
    fake = s.fake;
    const config = loadConfig({ INITIAL_ADMIN_PASSWORD: ADMIN_PW, LOG_JSON: 'false' });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, KubeModule, StoreModule, AuditModule, AuthModule, BackupModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(StoreService)
      .useValue(s.store)
      .overrideProvider(KubeClientFactory)
      .useValue({ homeCluster: () => ({ makeApiClient: () => ({}) }) })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app, config);
    await app.init();
    const first = await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'admin', password: ADMIN_PW })
      .expect(200);
    const changed = await http()
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', cookieFrom(first))
      .send({ currentPassword: ADMIN_PW, newPassword: 'Admin-New-Pw-12' })
      .expect(200);
    admin = cookieFrom(changed);
    key = await openpgp.generateKey({
      type: 'curve25519',
      userIDs: [{ name: 'Ops', email: 'ops@example.com' }],
      format: 'armored',
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('saves a key and downloads an encrypted backup with an AuditEvent (FP38-F-05, F-07)', async () => {
    const saved = await http()
      .put('/api/backup/settings')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ recipients: [{ publicKey: key.publicKey }], includeAuditEvents: true })
      .expect(200);
    expect(saved.body.recipients[0].fingerprint).toMatch(/^[0-9A-F]{40}$/);

    const res = await http()
      .post('/api/backup')
      .set(CSRF)
      .set('Cookie', admin)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pgp-encrypted');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="capi-navigator-home-\d{8}T\d{6}Z\.tar\.gz\.gpg"$/,
    );
    const body = res.body as Buffer;
    expect(body.includes(Buffer.from('HASH-OF-ADMIN'))).toBe(false);
    const message = await openpgp.readMessage({ binaryMessage: new Uint8Array(body) });
    const decryptionKeys = await openpgp.readPrivateKey({ armoredKey: key.privateKey });
    const { data } = await openpgp.decrypt({ message, decryptionKeys, format: 'binary' });
    const tgz = Buffer.from(data as Uint8Array);
    expect(readFromChartArchive(tgz, (p) => p === 'resources/10-secrets.yaml')).toContain(
      'navigator-user-admin-password',
    );

    const event = fake.auditEvents.find((e) => e.spec.action === 'backup.create');
    expect(event?.spec).toMatchObject({
      actor: 'admin',
      outcome: 'success',
      message: expect.stringMatching(/^\d+ objects, encrypted to [0-9A-F]{40}$/),
    });
    expect(fake.auditEvents.some((e) => e.spec.action === 'backup.settings.update')).toBe(true);
  });

  it('lets an API token download, but not change the keys (FP38-F-06)', async () => {
    await http()
      .post('/api/users')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ username: 'ci-backup', apiOnly: true, bindings: [{ role: 'admin' }] })
      .expect(201);
    const created = await http()
      .post('/api/users/ci-backup/tokens')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ name: 'nightly' })
      .expect(201);
    const bearer = { Authorization: `Bearer ${created.body.token as string}` };
    await http()
      .put('/api/backup/settings')
      .set(bearer)
      .send({ recipients: [{ publicKey: key.publicKey }], includeAuditEvents: true })
      .expect(403);
    await http().post('/api/backup').set(bearer).buffer(true).parse(binary).expect(200);
  });
});
