import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.js';
import type { KubeClientFactory } from '../kube/kube-client.factory.js';
import { createFakeStore } from '../testing/fake-store.js';
import { AuditCleanupService } from './audit-cleanup.service.js';

const notFound = () => Object.assign(new Error('not found'), { code: 404 });

function fakeLeaseApi(initial?: { holderIdentity: string; renewTime: Date }) {
  let lease = initial
    ? { metadata: { name: 'l' }, spec: { ...initial, leaseDurationSeconds: 900 } }
    : undefined;
  return {
    readNamespacedLease: async () => {
      if (!lease) throw notFound();
      return lease;
    },
    createNamespacedLease: async ({ body }: { body: typeof lease }) => {
      lease = body;
      return body;
    },
    replaceNamespacedLease: async ({ body }: { body: typeof lease }) => {
      lease = body;
      return body;
    },
  };
}

function setup(leaseApi: ReturnType<typeof fakeLeaseApi>) {
  const fake = createFakeStore();
  const kube = {
    homeCluster: () => ({ makeApiClient: () => leaseApi }),
  } as unknown as KubeClientFactory;
  const config = loadConfig({ POD_NAME: 'pod-a', AUDIT_RETENTION_DAYS: '90' });
  return { fake, service: new AuditCleanupService(kube, fake.store, config) };
}

const now = new Date('2026-10-17T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

describe('AuditEvent retention (section 4, State storage)', () => {
  it('deletes events older than the retention period and keeps newer ones', async () => {
    const { fake, service } = setup(fakeLeaseApi());
    for (const ts of [daysAgo(120), daysAgo(91), daysAgo(89), daysAgo(1)]) {
      await fake.store.auditEvents.create(
        {},
        { timestamp: ts, actor: 'a', action: 'x', outcome: 'success' },
      );
    }
    expect(await service.runOnce(now)).toBe(2);
    expect(fake.auditEvents.map((e) => e.spec.timestamp)).toEqual([daysAgo(89), daysAgo(1)]);
  });

  it('skips the cleanup while another replica holds the lease', async () => {
    const { service } = setup(fakeLeaseApi({ holderIdentity: 'pod-b', renewTime: now }));
    expect(await service.runOnce(now)).toBeUndefined();
  });

  it('takes over an expired lease', async () => {
    const expired = new Date(now.getTime() - 60 * 60 * 1000);
    const { service } = setup(fakeLeaseApi({ holderIdentity: 'pod-b', renewTime: expired }));
    expect(await service.runOnce(now)).toBe(0);
  });
});
