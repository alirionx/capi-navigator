import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allCases, buildBodies, defaultVersion, merge, selectCases } from './cases.js';
import { loadConfig } from './config.js';

const example = loadConfig(fileURLToPath(new URL('../matrix.example.yaml', import.meta.url)));
const registry = {
  host: 'registry.example.com',
  mirrors: [{ upstream: 'docker.io', path: 'proxy-docker-io' }],
  artifactsPath: 'library',
};

describe('matrix cases', () => {
  it('has AIO and 1+1 per distribution, HCP where supported, air-gapped where configured', () => {
    const ids = allCases(example).map((c) => c.id);
    expect(ids.filter((i) => i.startsWith('mt-aw-'))).toEqual([
      'mt-aw-r-aio',
      'mt-aw-r-std',
      'mt-aw-k-aio',
      'mt-aw-k-std',
      'mt-aw-a-aio',
      'mt-aw-a-std',
      'mt-aw-hcp',
    ]);
    // Google Cloud has no hosted control planes (FP-24), and no airGapped block in the example.
    expect(ids.filter((i) => i.startsWith('mt-gc-'))).toHaveLength(6);
    expect(ids).toContain('mt-px-k-std-ag');
    expect(ids).toContain('mt-os-hcp-ag');
    expect(ids).toHaveLength(7 + 6 + 14 + 14);
  });

  it('selects by platform, flavor, mode, network and ID', () => {
    const all = allCases(example);
    expect(
      selectCases(all, { platforms: ['proxmox'], flavors: ['k0s'], network: 'airgap' }).map(
        (c) => c.id,
      ),
    ).toEqual(['mt-px-k-aio-ag', 'mt-px-k-std-ag', 'mt-px-hcp-ag']);
    expect(selectCases(all, { modes: ['hcp'], network: 'online' }).map((c) => c.id)).toEqual([
      'mt-aw-hcp',
      'mt-os-hcp',
      'mt-px-hcp',
    ]);
    expect(selectCases(all, { ids: ['mt-gc-a-std'] })).toHaveLength(1);
  });

  it('builds a valid spec for every case of the example, with the default versions', () => {
    for (const c of allCases(example)) {
      const p = example.platforms[c.platform]!;
      const bodies = buildBodies(c, {
        config: example,
        registry,
        ...(p.slots[0] ? { slot: p.slots[0] } : {}),
      });
      expect(bodies).toHaveLength(c.mode === 'hcp' ? 2 : 1);
      for (const b of bodies) {
        expect(b.spec.namespace).toBe('acc');
        expect((b.spec.kubernetes as { version: string }).version).toBe(
          defaultVersion((b.spec.kubernetes as { flavor: 'rke2' }).flavor),
        );
        expect(!!b.spec.airGapped).toBe(c.airGapped);
      }
    }
  });

  it('applies images, air-gap patches and the slot in this order', () => {
    const [b] = buildBodies(
      {
        id: 'mt-px-a-std-ag',
        platform: 'proxmox',
        flavor: 'kubeadm',
        mode: 'std',
        airGapped: true,
      },
      { config: example, registry, slot: example.platforms.proxmox!.slots[1]! },
    );
    expect(b!.spec.infrastructure).toMatchObject({
      image: '9001',
      apiEndpoint: '192.0.2.79',
      network: {
        nodeCidr: '192.0.2.0/24',
        gateway: '192.0.2.239',
        dnsNameservers: ['192.0.2.53'],
        addresses: ['192.0.2.76-192.0.2.78'],
      },
    });
    expect(b!.spec.airGapped).toEqual({ registry });
  });

  it('builds hosted control planes as a k0s host and a tenant on it', () => {
    const [host, tenant] = buildBodies(
      { id: 'mt-px-hcp', platform: 'proxmox', flavor: 'k0s', mode: 'hcp', airGapped: false },
      { config: example },
    );
    expect(host!.spec).toMatchObject({ name: 'mt-px-hcp-host', controlPlaneHost: true });
    expect(tenant!.spec).toMatchObject({
      name: 'mt-px-hcp-ten',
      topology: { mode: 'hosted', hosted: { host: 'mt-px-hcp-host' } },
      infrastructure: { apiEndpoint: '192.0.2.76' },
    });
  });

  it('refuses an air-gapped case without a registry, and invalid specs with the field', () => {
    const c = {
      id: 'x',
      platform: 'proxmox',
      flavor: 'k0s',
      mode: 'aio',
      airGapped: true,
    } as const;
    expect(() => buildBodies(c, { config: example })).toThrow(/no internal registry/);
    const broken = merge(example, { platforms: { proxmox: { sizes: { allInOne: '' } } } });
    expect(() => buildBodies({ ...c, airGapped: false }, { config: broken })).toThrow(
      /invalid spec: topology\.controlPlane\.machineSize/,
    );
  });

  it('merges deeply; arrays replace', () => {
    expect(merge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } }, undefined, { d: 1 })).toEqual({
      a: { b: 1, c: [3] },
      d: 1,
    });
  });
});
