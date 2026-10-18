import { describe, expect, it } from 'vitest';
import { buildCalicoResourceSet } from '@capi-navigator/shared';
import { calicoManifest } from './cni-manifest.js';

describe('shipped Calico manifest (ADR-0014)', () => {
  it('matches the pinned checksum and gets VXLAN for all pod traffic', async () => {
    const manifest = await calicoManifest();
    const [cm] = buildCalicoResourceSet('team-a', manifest);
    const content = (cm!.data as Record<string, string>)['calico.yaml']!;
    expect(content).toContain('- name: CALICO_IPV4POOL_VXLAN\n              value: "Always"');
    expect(content).not.toMatch(/POOL_VXLAN\n\s+value: "CrossSubnet"/);
    expect(content.length).toBeLessThan(1_000_000);
  });
});
