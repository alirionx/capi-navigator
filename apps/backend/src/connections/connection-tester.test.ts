import type { KubeConfig } from '@kubernetes/client-node';
import { REQUIRED_PERMISSIONS } from '@capi-navigator/shared';
import { describe, expect, it } from 'vitest';
import { explainError, testConnection } from './connection-tester.js';

const now = () => new Date('2026-10-17T00:00:00Z');

function fakeKc(opts: {
  version?: () => Promise<{ gitVersion: string }>;
  allowed?: (resource: string, verb: string) => boolean;
  reviewError?: unknown;
}): KubeConfig {
  return {
    makeApiClient: (api: { name: string }) =>
      api.name.includes('VersionApi')
        ? { getCode: opts.version ?? (() => Promise.resolve({ gitVersion: 'v1.34.0' })) }
        : {
            createSelfSubjectAccessReview: async ({
              body,
            }: {
              body: { spec: { resourceAttributes: { resource: string; verb: string } } };
            }) => {
              if (opts.reviewError) throw opts.reviewError;
              const { resource, verb } = body.spec.resourceAttributes;
              return { status: { allowed: opts.allowed ? opts.allowed(resource, verb) : true } };
            },
          },
  } as unknown as KubeConfig;
}

const netError = (code: string) =>
  Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

describe('connection test (FP2-F-04, FP2-F-06)', () => {
  it('reports a reachable cluster with version and all permissions', async () => {
    const status = await testConnection(fakeKc({}), now);
    expect(status).toMatchObject({
      phase: 'Reachable',
      kubernetesVersion: 'v1.34.0',
      lastCheckedAt: '2026-10-17T00:00:00.000Z',
    });
    expect(status.permissions).toHaveLength(REQUIRED_PERMISSIONS.length);
    expect(status.message).toBeUndefined();
  });

  it('explains missing required permissions', async () => {
    const status = await testConnection(
      fakeKc({ allowed: (resource) => resource !== 'clusters' }),
      now,
    );
    expect(status.phase).toBe('Reachable');
    expect(status.message).toMatch(/1 required permission/);
    expect(status.permissions?.find((p) => p.resource === 'clusters')?.allowed).toBe(false);
  });

  it('notes when only install permissions are missing (minimal role)', async () => {
    const install = new Set(
      REQUIRED_PERMISSIONS.filter((p) => p.level === 'install').map(
        (p) => `${p.resource}/${p.verb}`,
      ),
    );
    const status = await testConnection(
      fakeKc({ allowed: (resource, verb) => !install.has(`${resource}/${verb}`) }),
      now,
    );
    expect(status.message).toMatch(/cannot be installed/);
  });

  it('reports rejected credentials as Unauthorized', async () => {
    const status = await testConnection(
      fakeKc({ reviewError: Object.assign(new Error('Unauthorized'), { code: 401 }) }),
      now,
    );
    expect(status).toMatchObject({ phase: 'Unauthorized', kubernetesVersion: 'v1.34.0' });
    expect(status.hint).toMatch(/token/);
  });

  it('reports an unreachable cluster', async () => {
    const status = await testConnection(
      fakeKc({ version: () => Promise.reject(netError('ECONNREFUSED')) }),
      now,
    );
    expect(status).toMatchObject({
      phase: 'Unreachable',
      message: expect.stringMatching(/refused/),
    });
  });

  it.each([
    ['SELF_SIGNED_CERT_IN_CHAIN', /not trusted/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /not trusted/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', /does not match/],
    ['CERT_HAS_EXPIRED', /expired/],
    ['ENOTFOUND', /cannot be resolved/],
    ['ETIMEDOUT', /does not answer/],
  ])('translates %s', (code, message) => {
    const status = explainError(netError(code));
    expect(status.message).toMatch(message);
    expect(status.hint).toBeTruthy();
    expect(status.details).toContain(code);
  });
});
