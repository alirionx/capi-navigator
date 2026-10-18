import { describe, expect, it } from 'vitest';
import { analyzeRollouts } from './rollouts.js';

const md = (status: Record<string, number>, replicas = 2) => ({
  kind: 'MachineDeployment',
  name: 'demo-default',
  before: { spec: { replicas, template: { spec: { version: 'v1' } } }, status },
  after: { spec: { replicas, template: { spec: { version: 'v1' } } } },
});
const machine = (name: string, set: string) => ({
  metadata: {
    name,
    labels: {
      'cluster.x-k8s.io/deployment-name': 'demo-default',
      'cluster.x-k8s.io/set-name': set,
    },
  },
});
const run = (objects: ReturnType<typeof md>[], machines: ReturnType<typeof machine>[]) =>
  analyzeRollouts({
    controlPlaneKinds: ['RKE2ControlPlane', 'K0sControlPlane'],
    objects,
    removedDeployments: [],
    machines,
    workerVersionPending: false,
  }).running;

describe('running rollouts (FP7-F-17)', () => {
  it('reports a MachineDeployment with machines of two MachineSets', () => {
    expect(
      run(
        [md({ replicas: 2, readyReplicas: 2, upToDateReplicas: 1 })],
        [machine('a', 'old'), machine('b', 'new')],
      ),
    ).toEqual(['MachineDeployment demo-default']);
  });

  it('reports a surge or machines that are not ready yet', () => {
    expect(run([md({ replicas: 3, readyReplicas: 2, upToDateReplicas: 1 })], [])).toHaveLength(1);
    expect(run([md({ replicas: 2, readyReplicas: 1, upToDateReplicas: 1 })], [])).toHaveLength(1);
  });

  it('reports a control plane while old machines still exist', () => {
    const cp = {
      kind: 'K0sControlPlane',
      name: 'demo-control-plane',
      before: { spec: { replicas: 1 }, status: { replicas: 2, upToDateReplicas: 1 } },
      after: { spec: { replicas: 1 } },
    };
    expect(run([cp as never], [])).toEqual(['K0sControlPlane demo-control-plane']);
  });

  it('marks version-only control plane changes as in place when the provider supports it', () => {
    const cp = (version: string, extra: Record<string, unknown> = {}) => ({
      spec: { replicas: 3, version, k0sConfigSpec: { args: ['--enable-worker'] }, ...extra },
      status: { replicas: 3, readyReplicas: 3, upToDateReplicas: 3 },
    });
    const plan = (after: Record<string, unknown>) =>
      analyzeRollouts({
        controlPlaneKinds: ['K0sControlPlane'],
        objects: [{ kind: 'K0sControlPlane', name: 'cp', before: cp('v1.35.8+k0s.1'), after }],
        removedDeployments: [],
        machines: [],
        workerVersionPending: false,
        inPlaceVersionKinds: ['K0sControlPlane'],
      }).rollouts;
    expect(plan(cp('v1.36.4+k0s.1'))[0]?.action).toBe('inPlace');
    expect(
      plan(cp('v1.36.4+k0s.1', { machineTemplate: { infrastructureRef: { name: 'new' } } }))[0]
        ?.action,
    ).toBe('replace');
  });

  it('does not block on ready machines that never count as up to date (FP9: kubelet version)', () => {
    expect(
      run(
        [md({ replicas: 2, readyReplicas: 2, upToDateReplicas: 0 })],
        [machine('a', 'only'), machine('b', 'only')],
      ),
    ).toEqual([]);
  });
});
