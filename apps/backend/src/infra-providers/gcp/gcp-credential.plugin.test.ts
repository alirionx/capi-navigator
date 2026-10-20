import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GCP_REQUIRED_PERMISSIONS } from '@capi-navigator/shared';
import type { CredentialPlugin } from '../credential-plugin.js';
import { GCP_SECRET_KEY, GcpCredentialPlugin } from './gcp-credential.plugin.js';

/** A fake of the Google token endpoint, Compute Engine and Resource Manager APIs. */
class FakeGoogle {
  readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  computeDisabled = false;
  resourceManagerDisabled = false;
  revoked = false;
  granted: string[] = [...GCP_REQUIRED_PERMISSIONS];
  base = '';
  private server?: Server;

  async start() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.base);
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const json = (status: number, data: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (url.pathname === '/token') {
          const form = new URLSearchParams(body);
          const [h, c, sig] = (form.get('assertion') ?? '').split('.');
          const ok =
            form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' &&
            verify(
              'RSA-SHA256',
              Buffer.from(`${h}.${c}`),
              this.key.publicKey,
              Buffer.from(sig ?? '', 'base64url'),
            );
          const claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString() || '{}');
          if (!ok || this.revoked || claims.aud !== `${this.base}/token`) {
            return json(400, {
              error: 'invalid_grant',
              error_description: 'Invalid JWT Signature.',
            });
          }
          return json(200, { access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });
        }
        if (req.headers.authorization !== 'Bearer tok')
          return json(401, { error: { message: 'no token' } });
        const p = '/compute/v1/projects/demo-proj';
        if (
          url.pathname.startsWith('/compute') &&
          this.computeDisabled &&
          !url.pathname.includes('/ubuntu-os-cloud/')
        ) {
          return json(403, {
            error: {
              code: 403,
              message:
                'Compute Engine API has not been used in project demo-proj before or it is disabled.',
              status: 'PERMISSION_DENIED',
              details: [{ reason: 'SERVICE_DISABLED' }],
            },
          });
        }
        if (url.pathname.startsWith('/crm') && this.resourceManagerDisabled) {
          return json(403, {
            error: {
              code: 403,
              message:
                'Cloud Resource Manager API has not been used in project 123 before or it is disabled.',
              status: 'PERMISSION_DENIED',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  reason: 'SERVICE_DISABLED',
                  metadata: { service: 'cloudresourcemanager.googleapis.com' },
                },
              ],
            },
          });
        }
        switch (url.pathname) {
          case p:
            return json(200, { name: 'demo-proj' });
          case `${p}/regions`:
            return json(200, {
              items: [
                { name: 'us-central1', description: 'Iowa', status: 'UP' },
                { name: 'europe-west6', description: 'Zurich', status: 'UP' },
                { name: 'old-region1', status: 'DOWN' },
              ],
            });
          case `${p}/regions/europe-west6`:
            return json(200, {
              name: 'europe-west6',
              zones: [
                `${this.base}${p}/zones/europe-west6-b`,
                `${this.base}${p}/zones/europe-west6-a`,
              ],
            });
          case `${p}/zones/europe-west6-a/machineTypes`:
            return json(200, {
              items: [
                { name: 'n2-standard-4', guestCpus: 4, memoryMb: 16384 },
                { name: 'e2-medium', guestCpus: 2, memoryMb: 4096 },
                { name: 'm1-megamem-96', guestCpus: 96, memoryMb: 1468006 },
                { name: 'n1-standard-1', guestCpus: 1, memoryMb: 3840 },
                {
                  name: 'e2-small',
                  guestCpus: 2,
                  memoryMb: 2048,
                  deprecated: { state: 'DEPRECATED' },
                },
              ],
            });
          case `${p}/global/networks`:
            return json(200, { items: [{ name: 'default' }] });
          case '/compute/v1/projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64':
            return json(200, {
              name: 'ubuntu-2404-noble-amd64-v20261015',
              creationTimestamp: '2026-10-15',
            });
          case '/crm/v1/projects/demo-proj:testIamPermissions': {
            const asked = (JSON.parse(body) as { permissions: string[] }).permissions;
            return json(200, { permissions: asked.filter((x) => this.granted.includes(x)) });
          }
          default:
            return json(404, { error: { code: 404, message: `not found: ${url.pathname}` } });
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise((r) => this.server?.close(r));
  }

  serviceAccountKey(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: 'service_account',
      project_id: 'demo-proj',
      private_key_id: 'kid-1',
      private_key: this.key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      client_email: 'capi-navigator@demo-proj.iam.gserviceaccount.com',
      token_uri: `${this.base}/token`,
      ...over,
    });
  }
}

describe('Google Cloud credentials (FP25-F-02..04)', () => {
  const google = new FakeGoogle();
  let plugin: GcpCredentialPlugin;
  const summary = { region: 'europe-west6', projectId: 'demo-proj' };
  const data = () => ({ [GCP_SECRET_KEY]: google.serviceAccountKey() });

  beforeAll(async () => {
    await google.start();
    plugin = new GcpCredentialPlugin({
      compute: `${google.base}/compute/v1`,
      resourceManager: `${google.base}/crm/v1`,
    });
  });
  afterAll(() => google.stop());
  beforeEach(() => {
    google.computeDisabled = false;
    google.resourceManagerDisabled = false;
    google.revoked = false;
    google.granted = [...GCP_REQUIRED_PERMISSIONS];
  });

  it('stores the key as uploaded under "credentials" and summarizes project and account', () => {
    const key = google.serviceAccountKey();
    const n = plugin.normalize({ serviceAccountKey: key, region: 'europe-west6' });
    expect(n.data).toEqual({ credentials: key });
    expect(n.summary).toEqual({
      region: 'europe-west6',
      projectId: 'demo-proj',
      serviceAccount: 'capi-navigator@demo-proj.iam.gserviceaccount.com',
    });
    // CAPG references the Secret directly; there is no identity resource.
    expect((plugin as CredentialPlugin).identity).toBeUndefined();
  });

  it('refuses keys that are not service account keys, without echoing key material', () => {
    const cases: [string, RegExp][] = [
      ['not json', /not valid JSON/],
      [google.serviceAccountKey({ type: 'authorized_user' }), /not a service account key/],
      [google.serviceAccountKey({ client_email: undefined }), /no "client_email"/],
    ];
    for (const [key, message] of cases) {
      let error: Error | undefined;
      try {
        plugin.normalize({ serviceAccountKey: key, region: 'europe-west6' });
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).toMatch(message);
      expect(error?.message).not.toContain('PRIVATE KEY');
    }
    expect(() =>
      plugin.normalize({ serviceAccountKey: google.serviceAccountKey(), region: 'Zurich' }),
    ).toThrow(/region like/);
  });

  it('tests token, Compute Engine API, region and permissions (FP25-F-03)', async () => {
    const result = await plugin.test(data(), summary);
    expect(result).toMatchObject({
      ok: true,
      identity: 'Project demo-proj (capi-navigator@demo-proj.iam.gserviceaccount.com)',
    });
    expect(result.checks.map((c) => [c.name, c.ok])).toEqual([
      ['Authentication (service account key)', true],
      ['Compute Engine API', true],
      ['Region europe-west6', true],
      ['Permissions for Cluster API', true],
    ]);
  });

  it('only warns when the Resource Manager API is off, naming that API', async () => {
    google.resourceManagerDisabled = true;
    const result = await plugin.test(data(), summary);
    expect(result.ok).toBe(true);
    expect(result.checks.at(-1)).toMatchObject({
      ok: false,
      warning: true,
      message:
        'The Cloud Resource Manager API is not enabled in the project; permissions not checked (optional)',
    });
  });

  it('names missing permissions with the role to grant', async () => {
    google.granted = GCP_REQUIRED_PERMISSIONS.filter((p) => p !== 'iam.serviceAccounts.actAs');
    const result = await plugin.test(data(), summary);
    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)?.message).toBe('Missing: iam.serviceAccounts.actAs');
    expect(result.hint).toMatch(/role "Editor"/);
  });

  it('explains a disabled Compute Engine API and a revoked key', async () => {
    google.computeDisabled = true;
    const disabled = await plugin.test(data(), summary);
    expect(disabled).toMatchObject({
      ok: false,
      message: 'The Compute Engine API is not enabled in the project',
    });
    expect(disabled.hint).toContain('compute.googleapis.com?project=demo-proj');

    google.revoked = true;
    const revoked = await plugin.test(data(), summary);
    expect(revoked).toMatchObject({ ok: false, message: 'Google refused the service account key' });
  });

  it('provides selection lists for the wizard (FP25-F-04)', async () => {
    const values = async (kind: 'regions' | 'zones' | 'machineTypes' | 'images' | 'networks') =>
      (await plugin.lookup(data(), summary, kind, {})).map((o) => o.value);
    expect(await values('regions')).toEqual(['europe-west6', 'us-central1']);
    expect(await values('zones')).toEqual(['europe-west6-a', 'europe-west6-b']);
    // Common families only, not deprecated, sorted by size.
    expect(await values('machineTypes')).toEqual(['e2-medium', 'n2-standard-4']);
    // Families the project cannot see are left out.
    expect(await values('images')).toEqual([
      'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261015',
    ]);
    expect(await values('networks')).toEqual(['default']);
    const names = await plugin.imageNames(data(), summary, [
      'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261015',
    ]);
    expect(Object.values(names)).toEqual(['ubuntu-2404-noble-amd64-v20261015']);
  });

  it('finds clusters by their credentialsRef', () => {
    const credential = {
      name: 'g',
      secret: { name: 'capi-navigator-credential-g', namespace: 'capg-system' },
    };
    const cluster = (ref: unknown) => ({ spec: { credentialsRef: ref } });
    expect(plugin.clusterKind.usesCredential(cluster(credential.secret), credential)).toBe(true);
    expect(
      plugin.clusterKind.usesCredential(
        cluster({ ...credential.secret, namespace: 'x' }),
        credential,
      ),
    ).toBe(false);
    expect(plugin.clusterKind.usesCredential({ spec: {} }, credential)).toBe(false);
  });
});
