import type { KubeConfig } from '@kubernetes/client-node';
import { NavigatorUserCrd, type NavigatorUserSpecSchema } from '@capi-navigator/shared';
import { describe, expect, it, vi } from 'vitest';
import { toHttpException } from '../kube/errors.js';
import { CustomResourceClient } from './custom-resource.client.js';
import { ResourceCache } from './resource-cache.js';
import { SecretStore } from './secret.store.js';

const kcWith = (api: object) => ({ makeApiClient: () => api }) as unknown as KubeConfig;
const user = (name: string, rv: string, role = 'viewer') => ({
  apiVersion: 'navigator.capi-navigator.io/v1alpha1',
  kind: 'NavigatorUser',
  metadata: { name, resourceVersion: rv },
  spec: { role, disabled: false, mustChangePassword: false, sessionGeneration: 0 },
});

describe('CustomResourceClient', () => {
  it('validates the spec, sets the field manager and pages through lists', async () => {
    const api = {
      createNamespacedCustomObject: vi.fn(async ({ body }) => body),
      listNamespacedCustomObject: vi.fn(async () => ({
        items: [],
        metadata: { continue: 'next' },
      })),
      patchNamespacedCustomObject: vi.fn(async ({ body }) => body),
      patchNamespacedCustomObjectStatus: vi.fn(async ({ body }) => body),
      deleteNamespacedCustomObject: vi.fn(async () => ({})),
    };
    const client = new CustomResourceClient(kcWith(api), 'ns', NavigatorUserCrd);
    expect(client.path).toBe(
      '/apis/navigator.capi-navigator.io/v1alpha1/namespaces/ns/navigatorusers',
    );
    const created = await client.create({ name: 'a' }, { role: 'admin' } as never);
    expect(created.spec).toEqual({
      role: 'admin',
      disabled: false,
      apiOnly: false,
      mustChangePassword: false,
      sessionGeneration: 0,
    });
    expect(api.createNamespacedCustomObject.mock.calls[0]![0].fieldManager).toBe('capi-navigator');
    await expect(client.create({ name: 'b' }, { role: 'root' } as never)).rejects.toThrow();
    expect((await client.list()).continue).toBe('next');
    await client.patchSpec('a', { disabled: true }, '7');
    expect(api.patchNamespacedCustomObject.mock.calls[0]![0].body).toEqual({
      metadata: { resourceVersion: '7' },
      spec: { disabled: true },
    });
    await client.patchStatus('a', { x: 1 });
    await client.delete('a');
    expect(api.deleteNamespacedCustomObject).toHaveBeenCalled();
  });
});

describe('ResourceCache (STATE-03)', () => {
  const cache = () =>
    new ResourceCache<typeof NavigatorUserSpecSchema>(
      kcWith({}),
      new CustomResourceClient(kcWith({}), 'ns', NavigatorUserCrd),
    );

  it('keeps the newest version and sorts by name', () => {
    const c = cache();
    c.upsert(user('b', '10', 'admin') as never);
    c.upsert(user('a', '5') as never);
    c.upsert(user('b', '9', 'viewer') as never); // stale event
    expect(c.get('b')?.spec.role).toBe('admin');
    expect(c.list().map((u) => u.metadata.name)).toEqual(['a', 'b']);
    c.remove('a');
    expect(c.get('a')).toBeUndefined();
    expect(c.isSynced).toBe(false);
  });

  it('ignores objects that do not match the schema', () => {
    const c = cache();
    c.upsert(user('x', '1', 'superuser') as never);
    expect(c.get('x')).toBeUndefined();
  });
});

describe('SecretStore (NF-01)', () => {
  it('encodes and decodes data, and creates on put when missing', async () => {
    const stored = new Map<string, Record<string, string>>();
    const notFound = Object.assign(new Error('nf'), { code: 404 });
    const api = {
      readNamespacedSecret: vi.fn(async ({ name }) => {
        const data = stored.get(name);
        if (!data) throw notFound;
        return { data };
      }),
      createNamespacedSecret: vi.fn(async ({ body }) => stored.set(body.metadata.name, body.data)),
      replaceNamespacedSecret: vi.fn(async ({ name, body }) => {
        if (!stored.has(name)) throw notFound;
        stored.set(name, body.data);
      }),
      deleteNamespacedSecret: vi.fn(async ({ name }) => {
        if (!stored.delete(name)) throw notFound;
      }),
    };
    const secrets = new SecretStore(kcWith(api), 'ns');
    expect(await secrets.get('missing')).toBeUndefined();
    await secrets.put('s', { key: 'välue' });
    expect(stored.get('s')).toEqual({ key: Buffer.from('välue').toString('base64') });
    expect(await secrets.get('s')).toEqual({ key: 'välue' });
    await secrets.put('s', { key: 'new' });
    expect(await secrets.get('s')).toEqual({ key: 'new' });
    await secrets.delete('s');
    await secrets.delete('s'); // idempotent
    await expect(secrets.create('c', { a: 'b' }, { l: 'v' })).resolves.toBeUndefined();
  });
});

describe('toHttpException (NF-06)', () => {
  it.each([
    [401, 502, /rejected the credentials/],
    [403, 502, /missing permissions/],
    [404, 404, /not found/],
    [409, 409, /changed concurrently/],
    [422, 422, /invalid/],
    [undefined, 502, /not reachable/],
  ])('maps Kubernetes status %s to HTTP %s', (code, http, message) => {
    const err = Object.assign(
      new Error('raw'),
      code ? { code, body: '{"message":"k8s says no"}' } : {},
    );
    const ex = toHttpException(err, 'Do thing');
    expect(ex.getStatus()).toBe(http);
    const body = ex.getResponse() as { message: string; details?: string };
    expect(body.message).toMatch(message);
    expect(body.details).toBe(code ? 'k8s says no' : 'raw');
  });
});
