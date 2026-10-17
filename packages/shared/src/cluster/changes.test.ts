import { describe, expect, it } from 'vitest';
import { scalePool, setBastion, setLabels, SpecChangeError } from './changes.js';
import { ClusterSpecSchema, type ClusterSpec } from './spec.js';
import { transform } from './transform.js';

const spec: ClusterSpec = ClusterSpecSchema.parse({
  name: 'demo',
  namespace: 'team-a',
  labels: { env: 'test' },
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'a2-ram4-disk50-perf1' },
    workerPools: [
      { name: 'default', replicas: 2, machineSize: 'a4-ram8-disk50-perf1' },
      { name: 'gpu', replicas: 1, machineSize: 'a8-ram32-disk80-perf1' },
    ],
  },
  infrastructure: {
    provider: 'openstack',
    credentialRef: 'infomaniak',
    image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
    externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  },
});
const ctx = { credential: { cloudName: 'infomaniak' } };
const byKey = (s: ClusterSpec) =>
  new Map(transform(s, ctx).map((o) => [`${o.kind}/${o.metadata.name}`, JSON.stringify(o)]));

describe('spec changes (FP6-F-05, FP6-F-07)', () => {
  it('scales one pool and changes only its MachineDeployment and the stored spec (hard rule 5)', () => {
    const scaled = scalePool(spec, 'default', 3);
    expect(scaled.topology.workerPools.map((p) => p.replicas)).toEqual([3, 1]);
    const before = byKey(spec);
    const after = byKey(scaled);
    expect([...after.keys()]).toEqual([...before.keys()]); // same template names
    const changed = [...after.keys()].filter((k) => after.get(k) !== before.get(k));
    expect(changed).toEqual(['Cluster/demo', 'MachineDeployment/demo-default']);
  });

  it('rejects unknown pools and all-in-one clusters', () => {
    expect(() => scalePool(spec, 'nope', 1)).toThrow(SpecChangeError);
    const aio = ClusterSpecSchema.parse({
      ...spec,
      topology: { mode: 'all-in-one', controlPlane: spec.topology.controlPlane, workerPools: [] },
    });
    expect(() => scalePool(aio, 'default', 1)).toThrow(/all-in-one/);
  });

  it('replaces user labels, changes only the Cluster and protects reserved prefixes', () => {
    const labelled = setLabels(spec, { env: 'prod', team: 'a' });
    expect(labelled.labels).toEqual({ env: 'prod', team: 'a' });
    const before = byKey(spec);
    const after = byKey(labelled);
    expect([...after.keys()].filter((k) => after.get(k) !== before.get(k))).toEqual([
      'Cluster/demo',
    ]);
    expect(setLabels(spec, {}).labels).toBeUndefined();
    expect(() => setLabels(spec, { 'capi-navigator.io/ccm': 'x' })).toThrow(/reserved/);
    expect(() => setLabels(spec, { 'cluster.x-k8s.io/cluster-name': 'x' })).toThrow(/reserved/);
  });

  it('enables and disables the bastion without touching machine templates (FP5-F-20)', () => {
    const withKey = ClusterSpecSchema.parse({
      ...spec,
      infrastructure: { ...spec.infrastructure, sshKeyName: 'my-keys' },
    });
    const on = setBastion(withKey, { enabled: true, machineSize: 'a1-ram2-disk20-perf1' });
    const before = byKey(withKey);
    const after = byKey(on);
    expect([...after.keys()].filter((k) => after.get(k) !== before.get(k))).toEqual([
      'Cluster/demo',
      'OpenStackCluster/demo',
    ]);
    // Disabling keeps the size, which CAPO needs while it deletes the bastion.
    const off = setBastion(on, { enabled: false });
    expect(off.infrastructure.bastion).toEqual({
      enabled: false,
      machineSize: 'a1-ram2-disk20-perf1',
    });
    expect(() => setBastion(on, { enabled: true, machineSize: 'a2-ram4-disk50-perf1' })).toThrow(
      /Disable the bastion first/,
    );
    expect(() => setBastion(spec, { enabled: true, machineSize: 'x' })).toThrow(/key pair/);
  });
});
