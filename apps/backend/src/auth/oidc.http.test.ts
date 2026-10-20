import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditModule } from '../audit/audit.module.js';
import { APP_CONFIG, loadConfig, type AppConfig } from '../config/config.js';
import { ConfigModule } from '../config/config.module.js';
import { configureApp } from '../configure-app.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { KubeModule } from '../kube/kube.module.js';
import { StoreModule } from '../store/store.module.js';
import { StoreService } from '../store/store.service.js';
import { createFakeStore } from '../testing/fake-store.js';
import { TestOidcProvider } from '../testing/oidc-provider.js';
import {
  AUTH_SETTINGS_NAME,
  OIDC_CLIENT_SECRET_NAME,
  type OidcSettings,
  type RoleBinding,
} from '@capi-navigator/shared';
import { AuthSettingsService } from './auth-settings.service.js';
import { AuthModule } from './auth.module.js';
import { GroupsService, groupResourceName } from './groups.service.js';
import { safeReturnPath } from './oidc.controller.js';
import { OIDC_FLOW_COOKIE } from './oidc.service.js';
import { SESSION_COOKIE } from './session.service.js';

const ADMIN_PW = 'Initial-Admin-Pw-1';
const CSRF = { 'x-capi-navigator': '1' };
const PUBLIC_URL = 'http://capi.test';

describe('OpenID Connect sign-in over HTTP (FP-14)', () => {
  const idp = new TestOidcProvider();
  let app: NestExpressApplication;
  let fake: ReturnType<typeof createFakeStore>;
  let config: AppConfig;
  const http = () => request(app.getHttpServer());

  const cookies = (res: request.Response) =>
    ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = (res: request.Response, name: string) =>
    cookies(res)
      .find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))
      ?.split(';')[0];

  /** Runs the whole sign-in; returns the callback response (and the session cookie, if any). */
  async function signIn(redirect = '/clusters') {
    const start = await http()
      .get(`/api/auth/oidc/login?redirect=${encodeURIComponent(redirect)}`)
      .expect(302);
    const flow = cookie(start, OIDC_FLOW_COOKIE);
    const atProvider = await fetch(start.headers.location!, { redirect: 'manual' });
    const back = new URL(atProvider.headers.get('location')!);
    const callback = await http()
      .get(back.pathname + back.search)
      .set('Cookie', flow ?? '');
    return { start, flow, back, callback, session: cookie(callback, SESSION_COOKIE) };
  }

  /** Maps a group directly in the store; the API is tested separately. */
  async function mapGroup(group: string, bindings: RoleBinding[]) {
    await fake.store.groups.create({ name: groupResourceName(group) }, { group, bindings });
  }

  beforeAll(async () => {
    await idp.start();
    fake = createFakeStore();
    config = loadConfig({
      INITIAL_ADMIN_PASSWORD: ADMIN_PW,
      LOG_JSON: 'false',
      COOKIE_SECURE: 'false',
      PUBLIC_URL,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, KubeModule, StoreModule, AuditModule, AuthModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .overrideProvider(StoreService)
      .useValue(fake.store)
      .overrideProvider(KubeClientFactory)
      .useValue({ homeCluster: () => ({ makeApiClient: () => ({}) }) })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app, config);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await idp.stop();
  });

  /** Stores the provider settings as the Authentication page would (ADR-0020). */
  function configure(over: Partial<OidcSettings> = {}) {
    fake.authSettings.set(AUTH_SETTINGS_NAME, {
      apiVersion: 'navigator.capi-navigator.io/v1alpha1',
      kind: 'NavigatorAuthSettings',
      metadata: { name: AUTH_SETTINGS_NAME, resourceVersion: '1' },
      spec: {
        oidc: {
          enabled: true,
          issuerUrl: idp.issuer,
          clientId: idp.clientId,
          scopes: 'openid profile groups',
          groupsClaim: 'groups',
          usernameClaim: 'preferred_username',
          buttonLabel: 'Sign in with Test',
          defaultRole: 'viewer',
          ...over,
        },
      },
    });
    fake.secrets.set(OIDC_CLIENT_SECRET_NAME, { clientSecret: idp.clientSecret });
  }

  beforeEach(() => {
    idp.person = { sub: 'sub-jane', name: 'jane', groups: ['team-a', 'unrelated'] };
    idp.tamper = {};
    configure();
    fake.groups.clear();
  });

  it('offers the OIDC button on the sign-in page (FP14-F-07)', async () => {
    const res = await http().get('/api/auth/options').expect(200);
    expect(res.body).toEqual({ oidc: { label: 'Sign in with Test' } });
  });

  it('redirects to the provider with PKCE, state, nonce and the configured redirect URI (FP14-F-02, FP14-F-03)', async () => {
    const res = await http().get('/api/auth/oidc/login').set('Host', 'evil.example').expect(302);
    const url = new URL(res.headers.location!);
    expect(url.origin).toBe(idp.issuer);
    expect(url.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/api/auth/oidc/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid profile groups');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    const flow = cookies(res).find((c) => c.startsWith(`${OIDC_FLOW_COOKIE}=`))!;
    expect(flow).toContain('HttpOnly');
    expect(flow).toContain('SameSite=Lax');
    expect(flow).toContain('Path=/api/auth/oidc');
  });

  it('signs in a person of a mapped group without creating a user (FP14-F-04, FP14-F-06)', async () => {
    await mapGroup('team-a', [{ role: 'operator', connections: ['home'], namespaces: ['team-a'] }]);
    const usersBefore = fake.users.size;
    const { callback, session } = await signIn('/clusters');
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/clusters');
    expect(session).toBeTruthy();
    expect(fake.users.size).toBe(usersBefore);

    const me = await http().get('/api/auth/me').set('Cookie', session!).expect(200);
    expect(me.body).toMatchObject({
      username: 'jane (oidc)',
      source: 'oidc',
      groups: ['team-a'], // only mapped groups (FP14-F-06)
      mustChangePassword: false,
      bindings: [{ role: 'operator', connections: ['home'], namespaces: ['team-a'] }],
    });
    // The cookie holds no provider token and no unmapped group.
    const payload = Buffer.from(session!.split('=')[1]!.split('.')[0]!, 'base64url').toString();
    expect(payload).not.toContain('unrelated');
    expect(payload).not.toMatch(/eyJ/); // no JWT inside
    expect(fake.auditEvents.at(-1)).toMatchObject({
      spec: {
        actor: 'jane (oidc)',
        action: 'auth.oidc.login',
        outcome: 'success',
        subject: 'sub-jane',
      },
    });
  });

  it('applies a changed mapping on the next request (FP14-F-04)', async () => {
    await mapGroup('team-a', [{ role: 'admin' }]);
    const { session } = await signIn();
    await http().get('/api/users').set('Cookie', session!).expect(200);
    const mapping = [...fake.groups.values()][0]!;
    mapping.spec.bindings = [{ role: 'viewer' }];
    await http().get('/api/users').set('Cookie', session!).expect(403);
    fake.groups.clear();
    // No mapping left: default role viewer.
    const me = await http().get('/api/auth/me').set('Cookie', session!).expect(200);
    expect(me.body.bindings).toMatchObject([{ role: 'viewer' }]);
  });

  it('gives people without a mapped group the default role, or refuses them (FP14-F-05)', async () => {
    const viewer = await signIn();
    const me = await http().get('/api/auth/me').set('Cookie', viewer.session!).expect(200);
    expect(me.body.bindings).toMatchObject([{ role: 'viewer' }]);

    configure({ defaultRole: '' });
    const refused = await signIn();
    expect(refused.callback.headers.location).toBe('/login?error=oidc_no_access');
    expect(refused.session).toBeUndefined();
    expect(fake.auditEvents.at(-1)?.spec).toMatchObject({
      outcome: 'failure',
      actor: 'jane (oidc)',
    });
  });

  it('reads groups from UserInfo when the ID token has none, and handles a single group string', async () => {
    await mapGroup('team-a', [{ role: 'admin' }]);
    idp.person = { sub: 's2', name: 'bob', groups: ['team-a'], groupsInUserInfoOnly: true };
    const fromUserInfo = await signIn();
    const me = await http().get('/api/auth/me').set('Cookie', fromUserInfo.session!).expect(200);
    expect(me.body.groups).toEqual(['team-a']);

    idp.person = { sub: 's3', name: 'carol', groups: 'team-a' };
    const single = await signIn();
    const me2 = await http().get('/api/auth/me').set('Cookie', single.session!).expect(200);
    expect(me2.body.groups).toEqual(['team-a']);
  });

  it('falls back to email and subject as display name (FP14-F-01)', async () => {
    idp.person = { sub: 'only-sub', email: 'dave@example.com' };
    const { session } = await signIn();
    const me = await http().get('/api/auth/me').set('Cookie', session!).expect(200);
    expect(me.body.username).toBe('dave@example.com (oidc)');
  });

  it.each([
    ['a wrong issuer', { issuer: 'https://other.example' }],
    ['a wrong audience', { audience: 'other-client' }],
    ['an expired ID token', { expiresIn: -120 }],
    ['a wrong nonce', { nonce: 'not-the-nonce' }],
    ['a signature from an unknown key', { foreignKey: true }],
  ])('refuses %s (FP14-F-02)', async (_case, tamper) => {
    idp.tamper = tamper;
    const { callback, session } = await signIn();
    expect(callback.headers.location).toBe('/login?error=oidc_failed');
    expect(session).toBeUndefined();
    expect(fake.auditEvents.at(-1)?.spec).toMatchObject({
      action: 'auth.oidc.login',
      outcome: 'failure',
    });
  });

  it('refuses a wrong state, a missing flow cookie and a replayed callback (FP14-F-02)', async () => {
    const run = await signIn();
    expect(run.session).toBeTruthy();
    // Replay: same callback URL and flow cookie again.
    const replay = await http()
      .get(run.back.pathname + run.back.search)
      .set('Cookie', run.flow!);
    expect(replay.headers.location).toBe('/login?error=oidc_failed');

    // Callback without the flow cookie (e.g. started in another browser).
    const start = await http().get('/api/auth/oidc/login').expect(302);
    const atProvider = await fetch(start.headers.location!, { redirect: 'manual' });
    const back = new URL(atProvider.headers.get('location')!);
    const noCookie = await http().get(back.pathname + back.search);
    expect(noCookie.headers.location).toBe('/login?error=oidc_failed');

    // Wrong state.
    const start2 = await http().get('/api/auth/oidc/login').expect(302);
    const flow2 = cookie(start2, OIDC_FLOW_COOKIE)!;
    const at2 = await fetch(start2.headers.location!, { redirect: 'manual' });
    const back2 = new URL(at2.headers.get('location')!);
    back2.searchParams.set('state', 'forged');
    const forged = await http()
      .get(back2.pathname + back2.search)
      .set('Cookie', flow2);
    expect(forged.headers.location).toBe('/login?error=oidc_failed');
    expect(cookie(forged, SESSION_COOKIE)).toBeUndefined();
  });

  it('shows a cancelled sign-in at the provider as such', async () => {
    const start = await http().get('/api/auth/oidc/login').expect(302);
    const res = await http()
      .get('/api/auth/oidc/callback?error=access_denied&state=x')
      .set('Cookie', cookie(start, OIDC_FLOW_COOKIE)!);
    expect(res.headers.location).toBe('/login?error=oidc_cancelled');
  });

  it('keeps provider tokens and codes out of responses and the audit log (FP14-F-02, FP14-F-09)', async () => {
    const { callback } = await signIn();
    const visible = JSON.stringify([callback.headers, callback.body, fake.auditEvents]);
    for (const code of idp.issuedCodes) expect(visible).not.toContain(code);
    expect(visible).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ/);
  });

  it('keeps local sign-in, refuses a password change and tokens for OIDC people (FP14-F-07, FP14-F-08)', async () => {
    await http()
      .post('/api/auth/login')
      .set(CSRF)
      .send({ username: 'admin', password: ADMIN_PW })
      .expect(200);
    const { session } = await signIn();
    await http()
      .post('/api/auth/change-password')
      .set(CSRF)
      .set('Cookie', session!)
      .send({ currentPassword: 'x', newPassword: 'Another-Password-1' })
      .expect(400);
  });

  it('signs out at the provider too (FP14-F-10)', async () => {
    const { session } = await signIn();
    const res = await http().post('/api/auth/logout').set(CSRF).set('Cookie', session!).expect(200);
    const url = new URL(res.body.endSessionUrl);
    expect(url.origin + url.pathname).toBe(`${idp.issuer}/logout`);
    expect(url.searchParams.get('client_id')).toBe(idp.clientId);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC_URL}/login`);
    const local = await http().post('/api/auth/logout').set(CSRF).expect(200);
    expect(local.body).toEqual({});
  });

  it('lets admins manage group mappings and protects roles in use (FP14-F-04, FP14-F-09)', async () => {
    await mapGroup('capi-admins', [{ role: 'admin' }]);
    idp.person = { sub: 'sub-admin', name: 'alice', groups: ['capi-admins'] };
    const { session } = await signIn();
    const api = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
      http()[method](path).set(CSRF).set('Cookie', session!);

    const created = await api('post', '/api/oidc-groups')
      .send({ group: 'Engineering Team', bindings: [{ role: 'operator', namespaces: ['team-a'] }] })
      .expect(201);
    expect(created.body).toMatchObject({
      group: 'Engineering Team',
      name: expect.stringMatching(/^group-[0-9a-f]{24}$/),
    });
    await api('post', '/api/oidc-groups')
      .send({ group: 'Engineering Team', bindings: [{ role: 'viewer' }] })
      .expect(409);
    await api('post', '/api/oidc-groups')
      .send({ group: 'x', bindings: [{ role: 'no-such-role' }] })
      .expect(400);
    await api('post', '/api/oidc-groups').send({ group: 'x', bindings: [] }).expect(400);
    const list = await api('get', '/api/oidc-groups').expect(200);
    expect(list.body.map((m: { group: string }) => m.group)).toEqual([
      'capi-admins',
      'Engineering Team',
    ]);
    await api('patch', `/api/oidc-groups/${created.body.name}`)
      .send({ bindings: [{ role: 'viewer' }] })
      .expect(200);

    // A custom role used by a mapping, and the default role, cannot be deleted.
    await api('post', '/api/roles')
      .send({ name: 'ops', displayName: 'Ops', permissions: ['clusters.change'] })
      .expect(201);
    await api('patch', `/api/oidc-groups/${created.body.name}`)
      .send({ bindings: [{ role: 'ops' }] })
      .expect(200);
    const inUse = await api('delete', '/api/roles/ops').expect(409);
    expect(inUse.body.message).toContain('Engineering Team');

    await api('delete', `/api/oidc-groups/${created.body.name}`).expect(204);
    await api('delete', '/api/roles/ops').expect(204);
    expect(fake.auditEvents.map((e) => e.spec.action)).toEqual(
      expect.arrayContaining(['oidc-group.create', 'oidc-group.update', 'oidc-group.delete']),
    );
    expect(fake.auditEvents.find((e) => e.spec.action === 'oidc-group.create')?.spec).toMatchObject(
      {
        actor: 'alice (oidc)',
        subject: 'sub-admin',
      },
    );

    // A viewer cannot manage mappings.
    idp.person = { sub: 'sub-v', name: 'victor', groups: [] };
    const viewer = await signIn();
    await http().get('/api/oidc-groups').set('Cookie', viewer.session!).expect(403);
  });

  it('lets admins configure the provider in the UI, without ever returning the secret (FP14-F-12..F-14)', async () => {
    await mapGroup('capi-admins', [{ role: 'admin' }]);
    idp.person = { sub: 'sub-admin', name: 'alice', groups: ['capi-admins'] };
    const { session } = await signIn();
    const api = (method: 'get' | 'post' | 'put', path: string) =>
      http()[method](path).set(CSRF).set('Cookie', session!);

    const read = await api('get', '/api/auth-settings').expect(200);
    expect(read.body).toMatchObject({
      oidc: { enabled: true, issuerUrl: idp.issuer, secretSet: true },
      publicUrl: PUBLIC_URL,
      redirectUri: `${PUBLIC_URL}/api/auth/oidc/callback`,
    });
    expect(JSON.stringify(read.body)).not.toContain(idp.clientSecret);

    // Test before saving: what the provider offers, and a clear message for a wrong URL.
    const ok = await api('post', '/api/auth-settings/oidc/test')
      .send({ issuerUrl: idp.issuer })
      .expect(200);
    expect(ok.body).toMatchObject({
      ok: true,
      issuer: idp.issuer,
      endSessionEndpoint: `${idp.issuer}/logout`,
    });
    const bad = await api('post', '/api/auth-settings/oidc/test')
      .send({ issuerUrl: `${idp.issuer}/nothing` })
      .expect(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.message).toBeTruthy();

    // Save with a new label and secret; the secret is kept write-only.
    const settings = { ...read.body.oidc, buttonLabel: 'Sign in with Company SSO' };
    delete settings.secretSet;
    await api('put', '/api/auth-settings/oidc')
      .send({ ...settings, clientSecret: 'rotated-secret' })
      .expect(200);
    expect(fake.secrets.get(OIDC_CLIENT_SECRET_NAME)).toEqual({ clientSecret: 'rotated-secret' });
    const options = await http().get('/api/auth/options').expect(200);
    expect(options.body).toEqual({ oidc: { label: 'Sign in with Company SSO' } });
    const audit = fake.auditEvents.filter((e) => e.spec.action === 'auth-settings.update');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(fake.auditEvents)).not.toContain('rotated-secret');

    // Unknown default role is refused.
    await api('put', '/api/auth-settings/oidc')
      .send({ ...settings, defaultRole: 'no-such-role' })
      .expect(400);
    fake.secrets.set(OIDC_CLIENT_SECRET_NAME, { clientSecret: idp.clientSecret });

    // Switching OIDC off hides the button and ends OIDC sessions at once (ADR-0020).
    await api('put', '/api/auth-settings/oidc')
      .send({ ...settings, enabled: false })
      .expect(200);
    expect((await http().get('/api/auth/options').expect(200)).body).toEqual({ oidc: null });
    await http().get('/api/auth/me').set('Cookie', session!).expect(401);
    await http().get('/api/auth/oidc/login').expect(404);
  });

  it('refuses to enable OIDC without client secret', async () => {
    fake.authSettings.clear();
    fake.secrets.delete(OIDC_CLIENT_SECRET_NAME);
    const app2 = await http().get('/api/auth/options').expect(200);
    expect(app2.body).toEqual({ oidc: null });
    // Without OIDC only the local admin can save; checked in the service directly.
    const service = app.get(AuthSettingsService);
    await expect(
      service.update({ enabled: true, issuerUrl: idp.issuer, clientId: 'x' }),
    ).rejects.toThrow(/client secret/);
    await service.update({ enabled: false, issuerUrl: idp.issuer, clientId: 'x' });
    expect(fake.authSettings.get(AUTH_SETTINGS_NAME)?.spec.oidc.enabled).toBe(false);
  });

  it('maps single people by subject and issuer, effective at once (FP14-F-04)', async () => {
    await mapGroup('capi-admins', [{ role: 'admin' }]);
    idp.person = { sub: 'sub-admin', name: 'alice', groups: ['capi-admins'] };
    const admin = (await signIn()).session!;
    // A person without groups, e.g. Rancher with local accounts.
    idp.person = { sub: 'u-carol1', name: 'carol' };
    const carol = (await signIn()).session!;
    const me = async () => (await http().get('/api/auth/me').set('Cookie', carol).expect(200)).body;
    expect(await me()).toMatchObject({ subject: 'u-carol1', bindings: [{ role: 'viewer' }] });

    const created = await http()
      .post('/api/oidc-groups')
      .set(CSRF)
      .set('Cookie', admin)
      .send({
        subject: 'u-carol1',
        displayName: 'Carol',
        description: 'test',
        bindings: [{ role: 'operator', namespaces: ['team-a'] }],
      })
      .expect(201);
    expect(created.body).toMatchObject({
      kind: 'person',
      subject: 'u-carol1',
      issuer: idp.issuer,
      displayName: 'Carol',
      name: expect.stringMatching(/^person-[0-9a-f]{24}$/),
    });
    // Effective on the next request, without signing in again.
    expect((await me()).bindings).toMatchObject([{ role: 'operator', namespaces: ['team-a'] }]);

    // Clearing the description removes it (merge patch with null).
    const updated = await http()
      .patch(`/api/oidc-groups/${created.body.name}`)
      .set(CSRF)
      .set('Cookie', admin)
      .send({ displayName: 'Carol', bindings: [{ role: 'operator', namespaces: ['team-a'] }] })
      .expect(200);
    expect(updated.body.description).toBeUndefined();
    expect(updated.body.subject).toBe('u-carol1');

    // Same subject at another provider: the mapping does not apply.
    configure({ issuerUrl: 'https://other-idp.example' });
    expect((await me()).bindings).toMatchObject([{ role: 'viewer' }]);
    configure();
    expect((await me()).bindings).toMatchObject([{ role: 'operator' }]);

    // A group mapping and a person mapping add up.
    expect(
      (await http().get('/api/oidc-groups').set('Cookie', admin).expect(200)).body.map(
        (m: { kind: string }) => m.kind,
      ),
    ).toEqual(['group', 'person']);
    await http()
      .post('/api/oidc-groups')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ subject: 'u-carol1', bindings: [{ role: 'viewer' }] })
      .expect(409);
    await http()
      .post('/api/oidc-groups')
      .set(CSRF)
      .set('Cookie', admin)
      .send({ group: 'x', subject: 'y', bindings: [{ role: 'viewer' }] })
      .expect(400);
  });

  it('refuses person mappings while no provider is set up', async () => {
    const service = app.get(GroupsService);
    fake.authSettings.clear();
    await expect(
      service.create({ subject: 'u-1', bindings: [{ role: 'viewer' }] }),
    ).rejects.toThrow(/provider first/);
  });

  it('only returns to paths inside the app', () => {
    expect(safeReturnPath('/clusters/a/b?tab=1')).toBe('/clusters/a/b?tab=1');
    for (const bad of [
      undefined,
      '',
      'https://evil.example',
      '//evil.example',
      '/\\evil',
      '/api/users',
    ]) {
      expect(safeReturnPath(bad)).toBe('/');
    }
  });
});

describe('OpenID Connect settings without public URL (FP14-F-03)', () => {
  it('cannot enable OIDC, and stored settings stay inactive', async () => {
    const fake = createFakeStore();
    const service = new AuthSettingsService(fake.store, loadConfig({ PUBLIC_URL: '' }));
    await expect(
      service.update({
        enabled: true,
        issuerUrl: 'https://idp.example',
        clientId: 'x',
        clientSecret: 's',
      }),
    ).rejects.toThrow(/public URL/);
    expect(service.redirectUri).toBeUndefined();
    expect((await service.get()).redirectUri).toBeNull();
  });
});
