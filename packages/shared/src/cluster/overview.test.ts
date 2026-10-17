import { describe, expect, it } from 'vitest';
import type { ClusterSummary } from './api.js';
import { clustersUsing } from './overview.js';

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
});
