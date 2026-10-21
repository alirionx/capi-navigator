import { describe, expect, it } from 'vitest';
import { renderManifests } from '../operator-manifests.js';
import { applySpecChange } from './changes.js';
import { ClusterSpecSchema, type ClusterSpecInput } from './spec.js';
import { transform, type TransformContext } from './transform.js';

const ctx: TransformContext = { credential: { cloudName: 'infomaniak' } };
const VERSIONS = { rke2: 'v1.35.9+rke2r1', k0s: 'v1.35.8+k0s.1', kubeadm: 'v1.35.9' } as const;

const aio = (flavor: keyof typeof VERSIONS, replicas: 1 | 3 | 5 = 3): ClusterSpecInput => ({
  name: `aio-${flavor}`,
  namespace: 'team-a',
  kubernetes: { flavor, version: VERSIONS[flavor] },
  topology: {
    mode: 'all-in-one',
    controlPlane: { replicas, machineSize: 'a4-ram8-disk50-perf1' },
    workerPools: [],
  },
  infrastructure: {
    provider: 'openstack',
    credentialRef: 'infomaniak',
    image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
    externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  },
});
const objects = (input: ClusterSpecInput) => transform(ClusterSpecSchema.parse(input), ctx);
// Deep manifest paths in assertions; a missing field fails the expectation anyway.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Manifest = Record<string, any>;
const find = (input: ClusterSpecInput, kind: string) =>
  objects(input).find((o) => o.kind === kind) as Manifest;

describe('all-in-one with three or five nodes (FP-26)', () => {
  for (const flavor of ['rke2', 'k0s', 'kubeadm'] as const) {
    it(`${flavor}: three schedulable control plane nodes, no workers (FP26-F-01)`, () => {
      expect(renderManifests(objects(aio(flavor)))).toMatchSnapshot();
    });
  }

  it('keeps every node schedulable and creates no worker pools', () => {
    expect(objects(aio('rke2')).some((o) => o.kind === 'MachineDeployment')).toBe(false);
    expect(find(aio('rke2'), 'RKE2ControlPlane').spec).toMatchObject({ replicas: 3 });
    expect(find(aio('rke2'), 'RKE2ControlPlane').spec.agentConfig).not.toHaveProperty('nodeTaints');
    expect(find(aio('k0s'), 'K0sControlPlane').spec.k0sConfigSpec.args).toContain('--no-taints');
    const kcp = find(aio('kubeadm'), 'KubeadmControlPlane').spec;
    expect(kcp.replicas).toBe(3);
    expect(kcp.kubeadmConfigSpec.joinConfiguration.nodeRegistration.taints).toEqual([]);
  });

  it('scales an all-in-one control plane as a day-2 change (FP26-F-02)', () => {
    const one = ClusterSpecSchema.parse(aio('rke2', 1));
    const three = applySpecChange(one, { type: 'scaleControlPlane', replicas: 3 }, new Date());
    expect(three.topology.controlPlane.replicas).toBe(3);
    const back = applySpecChange(three, { type: 'scaleControlPlane', replicas: 1 }, new Date());
    expect(back.topology.controlPlane.replicas).toBe(1);
  });
});
