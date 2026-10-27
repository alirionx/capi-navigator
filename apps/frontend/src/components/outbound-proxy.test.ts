import { describe, expect, it } from 'vitest';
import type { InstalledProvider } from '@capi-navigator/shared';
import { providersWithoutProxy, proxySwitchDefault } from './outbound-proxy.js';

const provider = (
  catalogId: string,
  outboundProxy?: InstalledProvider['outboundProxy'],
): InstalledProvider => ({
  kind: 'AddonProvider',
  name: catalogId,
  namespace: `${catalogId}-system`,
  catalogId,
  phase: 'Ready',
  conditions: [],
  ...(outboundProxy ? { outboundProxy } : {}),
});

describe('outbound proxy hints (FP-29)', () => {
  it('lists providers that need the internet and do not use the proxy yet', () => {
    const list = [
      provider('helm'),
      provider('aws', 'current'),
      provider('gcp', 'outdated'),
      provider('core'),
      provider('proxmox'),
    ];
    expect(providersWithoutProxy(list).map((p) => p.catalogId)).toEqual(['helm']);
  });

  it('preselects the switch on update for those and for providers using the proxy', () => {
    expect(proxySwitchDefault(provider('helm'))).toBe(true);
    expect(proxySwitchDefault(provider('openstack', 'current'))).toBe(true);
    expect(proxySwitchDefault(provider('core'))).toBe(false);
  });
});
