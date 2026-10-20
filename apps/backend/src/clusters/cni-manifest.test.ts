import { describe, expect, it } from 'vitest';
import {
  buildCalicoResourceSet,
  buildManifestAddonResourceSet,
  MANIFEST_ADDONS,
} from '@capi-navigator/shared';
import { calicoManifest, shippedManifest } from './cni-manifest.js';

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

describe('shipped add-on manifests (ADR-0023)', () => {
  it('loads every manifest add-on with its pinned checksum', async () => {
    for (const addon of MANIFEST_ADDONS) {
      const manifest = await shippedManifest(addon.dir, addon.file, addon.sha256);
      const [cm] = buildManifestAddonResourceSet(addon, 'team-a', manifest);
      expect(Object.keys(cm!.data as object)).toEqual([`${addon.id}.yaml`]);
    }
  });

  it('refuses a manifest whose checksum does not match', async () => {
    const addon = MANIFEST_ADDONS[0]!;
    await expect(shippedManifest(addon.dir, addon.file, '0'.repeat(64))).rejects.toThrow(
      /unexpected checksum/,
    );
  });
});
