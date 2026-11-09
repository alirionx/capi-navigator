import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ClustersService } from './clusters.service.js';

/** FP34-F-14, FP34-F-15: what counts as used for the pool of a blueprint. */
const service = (opts: {
  items?: Record<string, unknown>[];
  listError?: unknown;
  subnets?: string[];
  lookupError?: unknown;
}) => {
  const list = vi.fn(async () => {
    if (opts.listError) throw opts.listError;
    return { items: opts.items ?? [] };
  });
  const kc = { makeApiClient: () => ({ listClusterCustomObject: list }) };
  const lookup = vi.fn(async () => {
    if (opts.lookupError) throw opts.lookupError;
    return {
      kind: 'subnets',
      options: (opts.subnets ?? []).map((value) => ({ value, label: value })),
    };
  });
  const svc = new ClustersService(
    { forConnection: async () => kc } as never,
    { lookup } as never,
    {} as never,
    {} as never,
  );
  return { svc, lookup, list };
};

const osCluster = (cidr: string, identity = 'other-project') => ({
  metadata: { name: cidr, namespace: 'x' },
  spec: { identityRef: { name: identity }, managedSubnets: [{ cidr }] },
});

describe('usedAddresses (FP34-F-15)', () => {
  it('counts the networks of all OpenStack clusters and the subnets of the project', async () => {
    const { svc, lookup } = service({
      items: [osCluster('10.7.0.0/24'), osCluster('10.7.1.0/24', 'infomaniak')],
      subnets: ['192.168.5.0/24'],
    });
    expect(await svc.usedAddresses('home', 'openstack', 'infomaniak')).toEqual([
      '10.7.0.0/24',
      '10.7.1.0/24',
      '192.168.5.0/24',
    ]);
    expect(lookup).toHaveBeenCalledWith('home', 'openstack', 'infomaniak', 'subnets');
  });

  it('refuses when the subnets of the project cannot be read', async () => {
    const { svc } = service({ lookupError: new Error('timeout') });
    const err = await svc.usedAddresses('home', 'openstack', 'infomaniak').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(502);
    expect((err as HttpException).message).toContain('subnets of credentials infomaniak');
  });

  it('refuses when the infrastructure clusters cannot be read, but not when CAPO is missing', async () => {
    const forbidden = Object.assign(new Error('forbidden'), { code: 403 });
    await expect(
      service({ listError: forbidden }).svc.usedAddresses('home', 'openstack', 'infomaniak'),
    ).rejects.toBeInstanceOf(HttpException);
    const missing = Object.assign(new Error('not found'), { code: 404 });
    expect(
      await service({ listError: missing }).svc.usedAddresses('home', 'openstack', 'infomaniak'),
    ).toEqual([]);
  });

  it('asks no cloud for providers without a lookup, and nothing for providers without a pool', async () => {
    const { svc, lookup, list } = service({});
    await svc.usedAddresses('home', 'proxmox', 'homelab');
    expect(lookup).not.toHaveBeenCalled();
    expect(await svc.usedAddresses('home', 'aws', 'aws-dev')).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
