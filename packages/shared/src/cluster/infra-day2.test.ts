import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXMOX_MACHINE_SIZES } from '../credentials.js';
import { applySpecChange, objectsTouchedBy, SpecChangeError } from './changes.js';
import { ipv4RangesCover } from './cidr.js';
import { day2Fields, day2Request, day2Values } from './infra-form.js';
import { ClusterSpecSchema, type ClusterSpec } from './spec.js';
import { INFRA_PLUGINS, transform, type TransformContext } from './transform.js';

const ctx: TransformContext = {
  credential: { machineSizes: DEFAULT_PROXMOX_MACHINE_SIZES, cloudName: 'infomaniak' },
};
const now = new Date('2026-10-24T10:00:00Z');

const pve: ClusterSpec = ClusterSpecSchema.parse({
  name: 'pve',
  namespace: 'proxmox',
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'medium' },
    workerPools: [{ name: 'default', replicas: 1, machineSize: 'medium' }],
  },
  infrastructure: {
    provider: 'proxmox',
    credentialRef: 'homelab',
    sourceNode: 'homeserver',
    image: '7112',
    storage: 'local-zfs',
    network: {
      nodeCidr: '10.20.0.0/24',
      gateway: '10.20.0.1',
      addresses: ['10.20.0.71-10.20.0.80'],
    },
    apiEndpoint: '10.20.0.89',
    allowedNodes: ['homeserver'],
  },
});
const openstack: ClusterSpec = ClusterSpecSchema.parse({
  name: 'demo',
  namespace: 'team-a',
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'a2-ram4-disk50-perf1' },
    workerPools: [{ name: 'default', replicas: 2, machineSize: 'a4-ram8-disk50-perf1' }],
  },
  infrastructure: {
    provider: 'openstack',
    credentialRef: 'infomaniak',
    image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
    externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  },
});

const change = (spec: ClusterSpec, values: Record<string, unknown>) =>
  applySpecChange(spec, { type: 'infrastructure', values } as never, now);
/** The Cluster always changes: it carries the stored spec as annotation. */
const touched = (before: ClusterSpec, after: ClusterSpec) =>
  [...objectsTouchedBy(transform(before, ctx), transform(after, ctx))].sort();

describe('day-2 changes of infrastructure settings (FP-33)', () => {
  it('declares changeable fields per plugin (FP33-F-01)', () => {
    const paths = (p: keyof typeof INFRA_PLUGINS) =>
      day2Fields(INFRA_PLUGINS[p].form).map((f) => f.path);
    expect(paths('proxmox')).toEqual([
      'memoryAdjustment',
      'network.dnsNameservers',
      'network.addresses',
      'network.loadBalancerAddresses',
      'allowedNodes',
    ]);
    expect(paths('openstack')).toEqual(['network.dnsNameservers']);
    expect(paths('aws')).toEqual([]);
    expect(paths('gcp')).toEqual([]);
  });

  it('changes Proxmox memory scheduling on the ProxmoxCluster only, no machine replaced (FP33-F-03)', () => {
    const next = change(pve, { memoryAdjustment: 120 });
    expect(next.infrastructure).toMatchObject({ memoryAdjustment: 120 });
    expect(touched(pve, next)).toEqual(['Cluster/pve', 'ProxmoxCluster/pve']);
  });

  it('adds node addresses and DNS servers without touching templates', () => {
    const next = change(pve, {
      'network.addresses': ['10.20.0.71-10.20.0.80', '10.20.0.81-10.20.0.85'],
      'network.dnsNameservers': ['10.20.0.1'],
    });
    expect(next.infrastructure).toMatchObject({
      network: {
        addresses: ['10.20.0.71-10.20.0.80', '10.20.0.81-10.20.0.85'],
        dnsNameservers: ['10.20.0.1'],
      },
    });
    expect(touched(pve, next)).toEqual(['Cluster/pve', 'ProxmoxCluster/pve']);
  });

  it('accepts a different notation of the same addresses but refuses to drop any (FP33-F-02)', () => {
    expect(() =>
      change(pve, {
        'network.addresses': ['10.20.0.71-10.20.0.75', '10.20.0.76-10.20.0.84'],
      }),
    ).not.toThrow();
    expect(() => change(pve, { 'network.addresses': ['10.20.0.71-10.20.0.79'] })).toThrow(
      /can only be added: 10\.20\.0\.71-10\.20\.0\.80 must stay/,
    );
  });

  it('still validates the whole spec (addresses inside the network, not the VIP)', () => {
    expect(() =>
      change(pve, { 'network.addresses': ['10.20.0.71-10.20.0.80', '10.20.0.89'] }),
    ).toThrow();
  });

  it('removes an emptied optional value', () => {
    const next = change(pve, { allowedNodes: null });
    expect(next.infrastructure).not.toHaveProperty('allowedNodes');
  });

  it('refuses fields the plugin does not declare', () => {
    expect(() => change(pve, { apiEndpoint: '10.20.0.90' })).toThrow(SpecChangeError);
    expect(() => change(pve, { 'network.gateway': '10.20.0.254' })).toThrow(
      '"network.gateway" cannot be changed after creation',
    );
  });

  it('changes the OpenStack DNS servers on the OpenStackCluster only', () => {
    const next = change(openstack, { 'network.dnsNameservers': ['9.9.9.9'] });
    expect(touched(openstack, next)).toEqual(['Cluster/demo', 'OpenStackCluster/demo']);
  });

  it('turns stored values into form values and back', () => {
    const form = INFRA_PLUGINS.proxmox.form;
    const values = day2Values(form, pve.infrastructure as Record<string, unknown>);
    expect(values).toEqual({
      memoryAdjustment: 0,
      'network.dnsNameservers': '1.1.1.1, 8.8.8.8',
      'network.addresses': '10.20.0.71-10.20.0.80',
      'network.loadBalancerAddresses': '',
      allowedNodes: 'homeserver',
    });
    expect(day2Request(form, { ...values, allowedNodes: '' })).toEqual({
      memoryAdjustment: 0,
      'network.dnsNameservers': ['1.1.1.1', '8.8.8.8'],
      'network.addresses': ['10.20.0.71-10.20.0.80'],
      'network.loadBalancerAddresses': null,
      allowedNodes: null,
    });
  });
});

describe('ipv4RangesCover', () => {
  it('covers addresses, ranges and networks across adjacent entries', () => {
    expect(ipv4RangesCover(['10.0.0.0/28'], '10.0.0.3-10.0.0.9')).toBe(true);
    expect(ipv4RangesCover(['10.0.0.1-10.0.0.4', '10.0.0.5'], '10.0.0.1-10.0.0.5')).toBe(true);
    expect(ipv4RangesCover(['10.0.0.1-10.0.0.3', '10.0.0.5'], '10.0.0.1-10.0.0.5')).toBe(false);
    expect(ipv4RangesCover([], '10.0.0.1')).toBe(false);
  });
});
