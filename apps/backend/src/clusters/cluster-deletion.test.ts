import { CoreV1Api } from '@kubernetes/client-node';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClusterDeletionService, DELETION_TIMING } from './cluster-deletion.service.js';
import {
  inventory,
  isSystemNamespace,
  remaining,
  startCleanup,
  type WorkloadApi,
} from './workload-cleanup.js';

/** In-memory workload cluster: deleting claims releases their volumes, like the CSI driver. */
function fakeWorkload() {
  const state = {
    namespaces: ['default', 'kube-system', 'calico-system', 'shop', 'monitoring'],
    lbs: [
      { namespace: 'shop', name: 'web' },
      { namespace: 'default', name: 'echo' },
    ],
    claims: [
      { namespace: 'shop', name: 'data', volume: 'pv-1', size: '10Gi' },
      { namespace: 'default', name: 'keep', volume: 'pv-2' },
    ],
    volumes: [
      { name: 'pv-1', reclaimPolicy: 'Delete', claim: 'shop/data' },
      { name: 'pv-2', reclaimPolicy: 'Retain', claim: 'default/keep' },
    ],
    calls: [] as string[],
  };
  const api: WorkloadApi = {
    listNamespaces: async () => [...state.namespaces],
    deleteNamespace: async (n) => {
      state.calls.push(`ns:${n}`);
    },
    deleteWorkloads: async (n) => {
      state.calls.push(`workloads:${n}`);
    },
    listLoadBalancers: async () => [...state.lbs],
    deleteService: async (ns, n) => {
      state.calls.push(`svc:${ns}/${n}`);
      state.lbs = state.lbs.filter((s) => !(s.namespace === ns && s.name === n));
    },
    listClaims: async () => [...state.claims],
    deleteClaim: async (ns, n) => {
      state.calls.push(`pvc:${ns}/${n}`);
      const claim = state.claims.find((c) => c.namespace === ns && c.name === n);
      state.claims = state.claims.filter((c) => c !== claim);
      state.volumes = state.volumes.filter(
        (v) => v.name !== claim?.volume || v.reclaimPolicy === 'Retain',
      );
    },
    listVolumes: async () => [...state.volumes],
  };
  return { api, state };
}

describe('workload cleanup (FP6-F-06)', () => {
  it('keeps system namespaces', () => {
    expect(
      ['default', 'kube-system', 'calico-system', 'tigera-operator', 'shop'].filter(
        isSystemNamespace,
      ),
    ).toEqual(['default', 'kube-system', 'calico-system', 'tigera-operator']);
  });

  it('keeps the namespaces of manifest add-ons such as the GCP CSI driver (ADR-0023)', () => {
    // Removed before the volumes, the CSI driver left a pod terminating and its disk behind.
    expect(isSystemNamespace('gce-pd-csi-driver')).toBe(true);
  });

  it('lists what will be removed and what stays (Retain)', async () => {
    const { api } = fakeWorkload();
    expect(await inventory(api)).toEqual({
      namespaces: ['shop', 'monitoring'],
      loadBalancers: ['shop/web', 'default/echo'],
      volumes: ['shop/data (10Gi)'],
      retainedVolumes: ['default/keep'],
    });
  });

  it('deletes namespaces, default workloads, LoadBalancer services and claims', async () => {
    const { api, state } = fakeWorkload();
    expect(await remaining(api)).toEqual([
      'Service shop/web',
      'Service default/echo',
      'PersistentVolume pv-1',
    ]);
    await startCleanup(api);
    expect(state.calls).toEqual([
      'ns:shop',
      'ns:monitoring',
      'workloads:default',
      'svc:shop/web',
      'svc:default/echo',
      'pvc:shop/data',
      'pvc:default/keep',
    ]);
    expect(await remaining(api)).toEqual([]);
  });
});

describe('cluster deletion (FP6-F-06)', () => {
  afterEach(() => {
    vi.useRealTimers();
    DELETION_TIMING.pollMs = 10_000;
    DELETION_TIMING.timeoutMs = 600_000;
  });

  function service(opts: { managed?: boolean; workload?: WorkloadApi | null } = {}) {
    const events: string[] = [];
    const svc = new ClusterDeletionService(
      { forConnection: async () => ({}) } as never,
      {
        kubeconfig: async () => {
          if (opts.workload === null) throw new Error('none');
          return 'kubeconfig';
        },
      } as never,
    );
    const internals = svc as unknown as Record<string, unknown>;
    internals.readCluster = async () => ({
      metadata: {
        annotations:
          opts.managed === false ? {} : { 'capi-navigator.io/cluster-spec': '{"name":"demo"}' },
      },
    });
    internals.annotate = async (_kc: unknown, _ns: string, _n: string, s: { phase: string }) => {
      events.push(`phase:${s.phase}`);
    };
    internals.deleteObjects = async () => {
      events.push('deleted');
    };
    internals.skipDrain = async () => {
      events.push('skip-drain');
    };
    svc.workloadApiFor = () => opts.workload ?? fakeWorkload().api;
    return { svc, events };
  }

  it('requires the cluster name and refuses external clusters', async () => {
    const { svc } = service();
    await expect(
      svc.delete('home', 'team-a', 'demo', { confirmName: 'dem', cleanup: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const external = service({ managed: false }).svc;
    await expect(
      external.delete('home', 'team-a', 'demo', { confirmName: 'demo', cleanup: true }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cleans up first and deletes once the cloud resources are released', async () => {
    DELETION_TIMING.pollMs = 5;
    const { svc, events } = service();
    const status = await svc.delete('home', 'team-a', 'demo', {
      confirmName: 'demo',
      cleanup: true,
    });
    expect(status.phase).toBe('cleanup');
    await vi.waitFor(() => expect(events).toEqual(['phase:cleanup', 'phase:deleting', 'deleted']));
  });

  it('stops with cleanup-timeout while resources remain', async () => {
    DELETION_TIMING.pollMs = 5;
    DELETION_TIMING.timeoutMs = 20;
    const stuck = fakeWorkload();
    stuck.api.deleteService = async () => undefined; // the CCM never releases the load balancer
    const { svc, events } = service({ workload: stuck.api });
    await svc.delete('home', 'team-a', 'demo', { confirmName: 'demo', cleanup: true });
    await vi.waitFor(() => expect(events).toEqual(['phase:cleanup', 'phase:cleanup-timeout']));
  });

  it('deletes right away without cleanup or without a reachable workload cluster', async () => {
    const { svc, events } = service({ workload: null });
    const status = await svc.delete('home', 'team-a', 'demo', {
      confirmName: 'demo',
      cleanup: true,
    });
    expect(status.phase).toBe('deleting');
    expect(events).toEqual(['phase:deleting', 'deleted']);
  });

  it('skips draining before deleting when asked, e.g. for an unreachable cluster', async () => {
    const { svc, events } = service({ workload: null });
    await svc.delete('home', 'team-a', 'demo', {
      confirmName: 'demo',
      cleanup: false,
      skipDrain: true,
    });
    expect(events).toEqual(['phase:deleting', 'skip-drain', 'deleted']);
  });

  it('removes the Cluster and its helper objects, drain rules included', async () => {
    const deleted: string[] = [];
    const listed: Record<string, string[]> = {
      clusterresourcesets: ['demo-proxmox-cloud-config'],
      machinedrainrules: ['demo-skip-tigera-operator'],
    };
    const custom = {
      listNamespacedCustomObject: async ({ plural }: { plural: string }) => ({
        items: (listed[plural] ?? []).map((name) => ({ metadata: { name } })),
      }),
      deleteNamespacedCustomObject: async ({ plural, name }: { plural: string; name: string }) => {
        deleted.push(`${plural}/${name}`);
      },
    };
    const core = {
      listNamespacedSecret: async () => ({ items: [{ metadata: { name: 'demo-cloud-config' } }] }),
      deleteNamespacedSecret: async ({ name }: { name: string }) => {
        deleted.push(`secrets/${name}`);
      },
    };
    const kc = { makeApiClient: (api: unknown) => (api === CoreV1Api ? core : custom) };
    const svc = new ClusterDeletionService({} as never, {} as never);
    await (
      svc as unknown as { deleteObjects(kc: unknown, ns: string, n: string): Promise<void> }
    ).deleteObjects(kc, 'team-a', 'demo');
    expect(deleted).toEqual([
      'clusters/demo',
      'clusterresourcesets/demo-proxmox-cloud-config',
      'machinedrainrules/demo-skip-tigera-operator',
      'secrets/demo-cloud-config',
    ]);
  });
});
