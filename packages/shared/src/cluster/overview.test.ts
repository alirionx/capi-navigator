import { describe, expect, it } from 'vitest';
import type { ClusterSummary } from './api.js';
import { clustersUsing, infraSummary } from './overview.js';
import { ClusterSpecSchema } from './spec.js';

const c = (name: string, provider: string, flavor: string, labels = {}): ClusterSummary => ({
  name,
  namespace: 'ns',
  provider,
  flavor,
  phase: 'Provisioned',
  ready: true,
  labels,
  managed: true,
});

describe('provider usage (FP6-F-08)', () => {
  const clusters = [
    c('os', 'openstack', 'rke2', { 'capi-navigator.io/ccm': 'openstack' }),
    c('aws', 'aws', 'rke2'),
    c('old', 'aws', 'kubeadm'),
  ];
  const names = (kind: never, name: string) =>
    clustersUsing({ kind, name }, clusters).map((x) => x.name);

  it('maps core, distribution, infrastructure and add-on providers to clusters', () => {
    expect(names('CoreProvider' as never, 'cluster-api')).toEqual(['os', 'aws', 'old']);
    expect(names('BootstrapProvider' as never, 'rke2')).toEqual(['os', 'aws']);
    expect(names('ControlPlaneProvider' as never, 'kubeadm')).toEqual(['old']);
    expect(names('InfrastructureProvider' as never, 'aws')).toEqual(['aws', 'old']);
    expect(names('AddonProvider' as never, 'helm')).toEqual(['os']);
  });

  it('counts the clusters of dependent infrastructure providers for the IPAM provider (FP31-F-01)', () => {
    const withPve = [...clusters, c('pve', 'proxmox', 'rke2')];
    expect(
      clustersUsing({ kind: 'IPAMProvider', name: 'in-cluster' }, withPve).map((x) => x.name),
    ).toEqual(['pve']);
    expect(clustersUsing({ kind: 'IPAMProvider', name: 'other' }, withPve)).toEqual([]);
  });
});

describe('infrastructure summary (FP6-F-02)', () => {
  it('shows effective size, image and root disk per group, with provider defaults', () => {
    const spec = ClusterSpecSchema.parse({
      name: 'demo',
      kubernetes: { version: 'v1.35.9+rke2r1' },
      topology: {
        mode: 'standard',
        controlPlane: { replicas: 1, machineSize: 't3.large' },
        workerPools: [
          {
            name: 'big',
            replicas: 2,
            machineSize: 't3.xlarge',
            image: 'ami-0123456789abcdef0',
            rootVolumeSizeGB: 200,
            rootVolumeType: 'gp2',
          },
        ],
      },
      infrastructure: {
        provider: 'aws',
        credentialRef: 'aws-dev',
        region: 'eu-central-1',
        image: 'ami-0e27250725fa51794',
      },
    });
    const s = infraSummary(spec);
    expect(s.groups).toEqual([
      {
        name: 'control plane',
        role: 'control-plane',
        replicas: 1,
        size: 't3.large',
        image: { id: 'ami-0e27250725fa51794' },
        rootVolumeGB: 50,
        rootVolumeType: 'gp3',
      },
      {
        name: 'big',
        role: 'worker',
        replicas: 2,
        size: 't3.xlarge',
        image: { id: 'ami-0123456789abcdef0' },
        rootVolumeGB: 200,
        rootVolumeType: 'gp2',
      },
    ]);
    expect(s.facts.map((f) => f.label)).toContain('Region');
  });
});
