import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_SPEC_ANNOTATION,
  ClusterSpecSchema,
  FLAVOR_PLUGINS,
  INFRA_PLUGINS,
  type ClusterSpec,
} from '@capi-navigator/shared';
import { deleteObjects } from '../kube/apply.js';
import { acquireLease } from '../kube/lease.js';
import { RolloutControllerService } from './rollout-controller.service.js';

vi.mock('../kube/apply.js', () => ({ deleteObjects: vi.fn(async () => undefined) }));
vi.mock('../kube/lease.js', () => ({ acquireLease: vi.fn(async () => true) }));

const NOW = new Date('2026-10-18T12:00:00Z');
const OLD = new Date(NOW.getTime() - 60 * 60_000).toISOString();
const SPEC = ClusterSpecSchema.parse({
  name: 'demo',
  namespace: 'team-a',
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'a2-ram4-disk50' },
    workerPools: [{ name: 'default', replicas: 2, machineSize: 'a2-ram4-disk50' }],
  },
  infrastructure: {
    provider: 'openstack',
    credentialRef: 'infomaniak',
    image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
    externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  },
});
const flavor = FLAVOR_PLUGINS.rke2!;
const infra = INFRA_PLUGINS.openstack;

const cluster = (spec: ClusterSpec | string | undefined, extra: Record<string, unknown> = {}) => ({
  metadata: {
    name: 'demo',
    namespace: 'team-a',
    annotations:
      spec === undefined
        ? {}
        : { [CLUSTER_SPEC_ANNOTATION]: typeof spec === 'string' ? spec : JSON.stringify(spec) },
    ...extra,
  },
});
const controlPlane = (status: Record<string, unknown>) => ({
  metadata: { name: 'demo-control-plane' },
  spec: {
    replicas: 1,
    machineTemplate: { spec: { infrastructureRef: { name: 'demo-cp-new' } } },
  },
  status,
});
const pool = (upToDate: number) => ({
  metadata: { name: 'demo-default' },
  spec: { replicas: 2, template: { spec: { infrastructureRef: { name: 'demo-default-new' } } } },
  status: { upToDateReplicas: upToDate },
});
const template = (name: string) => ({ metadata: { name, creationTimestamp: OLD } });

/** Management cluster with the given objects per plural. */
function setup(objects: { clusters: unknown[]; byPlural?: Record<string, unknown[]> }) {
  const api = {
    listClusterCustomObject: vi.fn(async () => ({ items: objects.clusters })),
    listNamespacedCustomObject: vi.fn(async ({ plural }: { plural: string }) => ({
      items: objects.byPlural?.[plural] ?? [],
    })),
  };
  const applyChange = vi.fn(async () => undefined);
  const record = vi.fn(async () => undefined);
  const controller = new RolloutControllerService(
    { homeCluster: () => ({ makeApiClient: () => ({}) }) } as never,
    {
      namespace: 'capi-navigator-system',
      connectionCache: { list: () => [{ metadata: { name: 'home' } }] },
    } as never,
    { forConnection: async () => ({ makeApiClient: () => api }) } as never,
    { applyChange } as never,
    { record } as never,
    { POD_NAME: 'pod-a' } as never,
  );
  return { api, applyChange, record, controller };
}

describe('rollout controller run (FP7-F-08, FP7-F-15, ADR-0010)', () => {
  beforeEach(() => {
    vi.mocked(deleteObjects).mockClear();
    vi.mocked(acquireLease).mockResolvedValue(true);
  });

  it('does nothing on replicas that do not hold the lease', async () => {
    vi.mocked(acquireLease).mockResolvedValue(false);
    const { api, controller } = setup({ clusters: [cluster(SPEC)] });
    await controller.runOnce(NOW);
    expect(api.listClusterCustomObject).not.toHaveBeenCalled();
  });

  it('lets the workers follow once the control plane runs the new version', async () => {
    const upgrading = {
      ...SPEC,
      kubernetes: {
        ...SPEC.kubernetes,
        workerVersion: 'v1.34.12+rke2r1',
        workerImage: SPEC.infrastructure.image,
      },
    };
    const at = (version: string) =>
      controlPlane({ version, replicas: 1, upToDateReplicas: 1, readyReplicas: 1 });

    const waiting = setup({
      clusters: [cluster(upgrading)],
      byPlural: { [flavor.controlPlaneResource.plural]: [at('v1.34.12+rke2r1')] },
    });
    await waiting.controller.runOnce(NOW);
    expect(waiting.applyChange).not.toHaveBeenCalled();

    const ready = setup({
      clusters: [cluster(upgrading)],
      byPlural: { [flavor.controlPlaneResource.plural]: [at('v1.35.9+rke2r1')] },
    });
    await ready.controller.runOnce(NOW);
    expect(ready.applyChange).toHaveBeenCalledWith(
      'home',
      'team-a',
      'demo',
      expect.any(Function),
      false,
      { finishUpgrade: true },
    );
    const mutate = (ready.applyChange.mock.calls[0] as unknown[])[3] as (
      s: ClusterSpec,
    ) => ClusterSpec;
    expect(mutate(upgrading).kubernetes.workerVersion).toBeUndefined();
    // FP29-F-16: the workers take the new image together with the new version.
    expect(mutate(upgrading).kubernetes.workerImage).toBeUndefined();
    expect(upgrading.kubernetes.workerVersion).toBe('v1.34.12+rke2r1');
    expect(ready.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'system:rollout-controller',
        action: 'cluster.upgrade.workers',
        outcome: 'success',
        managementCluster: 'home',
      }),
    );
  });

  it('audits a failed worker upgrade and carries on with other clusters', async () => {
    const upgrading = {
      ...SPEC,
      kubernetes: { ...SPEC.kubernetes, workerVersion: 'v1.34.12+rke2r1' },
    };
    const { applyChange, record, controller } = setup({
      clusters: [cluster(upgrading)],
      byPlural: {
        [flavor.controlPlaneResource.plural]: [
          controlPlane({ version: 'v1.35.9+rke2r1', upToDateReplicas: 1, readyReplicas: 1 }),
        ],
      },
    });
    applyChange.mockRejectedValueOnce(new Error('drift on MachineDeployment'));
    await expect(controller.runOnce(NOW)).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', message: 'Error: drift on MachineDeployment' }),
    );
  });

  it('deletes unreferenced templates once nothing rolls', async () => {
    const byPlural = {
      [flavor.controlPlaneResource.plural]: [
        controlPlane({ version: 'v1.35.9+rke2r1', upToDateReplicas: 1, readyReplicas: 1 }),
      ],
      machinedeployments: [pool(2)],
      [infra.resources.machineTemplatePlural]: [
        template('demo-cp-new'),
        template('demo-cp-old'),
        template('demo-default-new'),
      ],
      [flavor.bootstrapResources.templatePlural]: [template('demo-default-old')],
    };
    const { controller } = setup({ clusters: [cluster(SPEC)], byPlural });
    await controller.runOnce(NOW);
    const deleted = vi.mocked(deleteObjects).mock.calls.map((c) => c[1]);
    expect(deleted).toEqual([
      [
        {
          apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta2',
          kind: infra.machineTemplateKind,
          metadata: { name: 'demo-cp-old', namespace: 'team-a' },
        },
      ],
      [
        expect.objectContaining({
          kind: flavor.bootstrapResources.templateKind,
          metadata: { name: 'demo-default-old', namespace: 'team-a' },
        }),
      ],
    ]);
  });

  it('keeps templates while a pool still rolls', async () => {
    const { controller } = setup({
      clusters: [cluster(SPEC)],
      byPlural: {
        [flavor.controlPlaneResource.plural]: [
          controlPlane({ version: 'v1.35.9+rke2r1', upToDateReplicas: 1 }),
        ],
        machinedeployments: [pool(1)],
        [infra.resources.machineTemplatePlural]: [template('demo-cp-old')],
      },
    });
    await controller.runOnce(NOW);
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it('skips clusters without a valid spec, clusters being deleted and broken connections', async () => {
    const { api, controller } = setup({
      clusters: [
        cluster(undefined),
        cluster('{"name": 1}'),
        cluster(SPEC, { deletionTimestamp: OLD }),
      ],
    });
    await controller.runOnce(NOW);
    expect(api.listNamespacedCustomObject).not.toHaveBeenCalled();

    api.listClusterCustomObject.mockRejectedValueOnce(new Error('connection refused'));
    await expect(controller.runOnce(NOW)).resolves.toBeUndefined();
  });

  it('starts and stops its timer with the application', () => {
    vi.useFakeTimers();
    try {
      const { controller } = setup({ clusters: [] });
      const run = vi.spyOn(controller, 'runOnce').mockResolvedValue(undefined);
      controller.onApplicationBootstrap();
      vi.advanceTimersByTime(20_000);
      expect(run).toHaveBeenCalledTimes(1);
      controller.onApplicationShutdown();
      vi.advanceTimersByTime(60_000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
