import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  CoreV1Api,
  CustomObjectsApi,
  KubernetesObjectApi,
  PatchStrategy,
  type KubeConfig,
} from '@kubernetes/client-node';
import {
  CLUSTER_SPEC_ANNOTATION,
  DELETION_ANNOTATION,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  type DeletePreview,
  type DeletionStatus,
} from '@capi-navigator/shared';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { ClustersService } from './clusters.service.js';
import { CLUSTER_NAME_LABEL } from './status.js';
import {
  inventory,
  remaining,
  startCleanup,
  workloadApi,
  type WorkloadApi,
} from './workload-cleanup.js';

const CAPI = { group: 'cluster.x-k8s.io', version: 'v1beta2', plural: 'clusters' };
const CRS = { group: 'addons.cluster.x-k8s.io', version: 'v1beta2', plural: 'clusterresourcesets' };
const DRAIN_RULES = { group: 'cluster.x-k8s.io', version: 'v1beta2', plural: 'machinedrainrules' };
/** Separate field manager, so the deletion annotation is not attributed to the applied spec. */
const DELETION_MANAGER = 'capi-navigator-deletion';
const REACH_TIMEOUT_MS = 10_000;

/** Timing of the cleanup; overridable in tests. */
export const DELETION_TIMING = { pollMs: 10_000, timeoutMs: 10 * 60_000 };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/**
 * Deletion of a workload cluster (FP6-F-06): confirmed by name, optionally after cleaning up
 * workloads, load balancers and volumes inside the cluster, then the CAPI Cluster (CAPI deletes
 * machines and infrastructure) and the app's own helper objects. Progress lives in an annotation
 * on the Cluster, so the backend stays stateless (STATE-04).
 */
@Injectable()
export class ClusterDeletionService {
  private readonly logger = new Logger(ClusterDeletionService.name);
  /** Factory for the workload API; replaced in tests. */
  workloadApiFor: (kubeconfig: string) => WorkloadApi = workloadApi;

  constructor(
    private readonly clients: ManagementClusterClients,
    private readonly clusters: ClustersService,
  ) {}

  async preview(connection: string, namespace: string, name: string): Promise<DeletePreview> {
    const kc = await this.clients.forConnection(connection);
    const cluster = await this.readCluster(kc, namespace, name);
    const managed = !!cluster.metadata?.annotations?.[CLUSTER_SPEC_ANNOTATION];
    const warnings: string[] = [];
    const api = await this.workload(connection, namespace, name);
    let inv = { namespaces: [], loadBalancers: [], volumes: [], retainedVolumes: [] } as Awaited<
      ReturnType<typeof inventory>
    >;
    let reachable = false;
    if (api) {
      try {
        inv = await withTimeout(inventory(api), REACH_TIMEOUT_MS);
        reachable = true;
      } catch {
        warnings.push(
          'The workload cluster does not answer: load balancers and volumes created inside it cannot be removed and may stay in the cloud.',
        );
      }
    } else {
      warnings.push('No kubeconfig yet: nothing inside the cluster needs to be cleaned up.');
    }
    if (inv.retainedVolumes.length > 0) {
      warnings.push(
        `Volumes with reclaim policy Retain stay in the cloud: ${inv.retainedVolumes.join(', ')}.`,
      );
    }
    const helpers = await this.helperObjects(kc, namespace, name);
    return {
      managed,
      workloadReachable: reachable,
      ...inv,
      objects: [{ kind: 'Cluster', name }, ...helpers.map((h) => ({ kind: h.kind, name: h.name }))],
      warnings,
    };
  }

  async delete(
    connection: string,
    namespace: string,
    name: string,
    req: { confirmName: string; cleanup: boolean; skipDrain?: boolean },
  ): Promise<DeletionStatus> {
    if (req.confirmName !== name) {
      throw new BadRequestException({
        message: 'The confirmation does not match the cluster name',
        hint: `Type "${name}" to confirm.`,
      });
    }
    const kc = await this.clients.forConnection(connection);
    const cluster = await this.readCluster(kc, namespace, name);
    if (!cluster.metadata?.annotations?.[CLUSTER_SPEC_ANNOTATION]) {
      throw new ConflictException({
        message: `Cluster ${namespace}/${name} was created outside CAPI Navigator`,
        hint: 'External clusters are read-only; delete them with kubectl or clusterctl.',
      });
    }
    const api = req.cleanup ? await this.workload(connection, namespace, name) : undefined;
    let cleanup = false;
    if (api) {
      try {
        await withTimeout(startCleanup(api), 60_000);
        cleanup = true;
      } catch (err) {
        this.logger.warn(`Cleanup of ${namespace}/${name} could not start: ${String(err)}`);
      }
    }
    const status: DeletionStatus = cleanup
      ? { phase: 'cleanup', startedAt: new Date().toISOString() }
      : { phase: 'deleting', startedAt: new Date().toISOString() };
    await this.annotate(kc, namespace, name, status);
    if (req.skipDrain) await this.skipDrain(kc, namespace, name);
    if (cleanup) void this.finishAfterCleanup(connection, namespace, name, api!, status.startedAt);
    else await this.deleteObjects(kc, namespace, name);
    return status;
  }

  /** Waits until the cloud resources are released, then deletes; on timeout it stops and reports. */
  private async finishAfterCleanup(
    connection: string,
    namespace: string,
    name: string,
    api: WorkloadApi,
    startedAt: string,
  ): Promise<void> {
    const deadline = Date.now() + DELETION_TIMING.timeoutMs;
    try {
      for (;;) {
        const left = await remaining(api).catch(() => ['(workload cluster not reachable)']);
        if (left.length === 0) break;
        if (Date.now() > deadline) {
          const kc = await this.clients.forConnection(connection);
          await this.annotate(kc, namespace, name, {
            phase: 'cleanup-timeout',
            startedAt,
            message: `Still present: ${left.slice(0, 5).join(', ')}${left.length > 5 ? ', …' : ''}`,
          });
          return;
        }
        await new Promise((r) => setTimeout(r, DELETION_TIMING.pollMs));
      }
      const kc = await this.clients.forConnection(connection);
      await this.annotate(kc, namespace, name, { phase: 'deleting', startedAt });
      await this.deleteObjects(kc, namespace, name);
    } catch (err) {
      this.logger.error(`Deletion of ${namespace}/${name} failed: ${String(err)}`);
    }
  }

  /**
   * Upstream CAPI annotations on all machines of the cluster: delete without draining the node or
   * waiting for volume detach, which never finish while the cluster API is down.
   */
  private async skipDrain(kc: KubeConfig, namespace: string, name: string): Promise<void> {
    const custom = kc.makeApiClient(CustomObjectsApi);
    const machines = (await custom.listNamespacedCustomObject({
      ...CAPI,
      plural: 'machines',
      namespace,
      labelSelector: `${CLUSTER_NAME_LABEL}=${name}`,
    })) as { items: { metadata: { name: string } }[] };
    const objects = KubernetesObjectApi.makeApiClient(kc);
    for (const m of machines.items) {
      await objects.patch(
        {
          apiVersion: 'cluster.x-k8s.io/v1beta2',
          kind: 'Machine',
          metadata: {
            name: m.metadata.name,
            namespace,
            annotations: {
              'machine.cluster.x-k8s.io/exclude-node-draining': '',
              'machine.cluster.x-k8s.io/exclude-wait-for-node-volume-detach': '',
            },
          },
        },
        undefined,
        undefined,
        DELETION_MANAGER,
        undefined,
        PatchStrategy.MergePatch,
      );
    }
  }

  /**
   * The Cluster (CAPI cascades) and the app's helper objects (cloud config, ClusterResourceSet,
   * MachineDrainRule).
   */
  private async deleteObjects(kc: KubeConfig, namespace: string, name: string): Promise<void> {
    const custom = kc.makeApiClient(CustomObjectsApi);
    try {
      await custom.deleteNamespacedCustomObject({ ...CAPI, namespace, name });
    } catch (err) {
      if (!isNotFound(err)) throw toHttpException(err, 'Delete the cluster');
    }
    for (const h of await this.helperObjects(kc, namespace, name)) {
      try {
        if (h.kind === 'Secret') {
          await kc.makeApiClient(CoreV1Api).deleteNamespacedSecret({ namespace, name: h.name });
        } else if (h.kind === 'MachineDrainRule') {
          await custom.deleteNamespacedCustomObject({ ...DRAIN_RULES, namespace, name: h.name });
        } else {
          await custom.deleteNamespacedCustomObject({ ...CRS, namespace, name: h.name });
        }
      } catch (err) {
        if (!isNotFound(err)) throw toHttpException(err, `Delete ${h.kind} ${h.name}`);
      }
    }
  }

  private async helperObjects(
    kc: KubeConfig,
    namespace: string,
    name: string,
  ): Promise<{ kind: string; name: string }[]> {
    const labelSelector = `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${CLUSTER_NAME_LABEL}=${name}`;
    const names = (r: unknown) =>
      (r as { items: { metadata: { name: string } }[] }).items.map((o) => o.metadata.name);
    const [secrets, sets, drainRules] = await Promise.all([
      kc
        .makeApiClient(CoreV1Api)
        .listNamespacedSecret({ namespace, labelSelector })
        .then((r) => r.items.map((s) => s.metadata!.name!))
        .catch(() => [] as string[]),
      kc
        .makeApiClient(CustomObjectsApi)
        .listNamespacedCustomObject({ ...CRS, namespace, labelSelector })
        .then(names)
        .catch(() => [] as string[]),
      kc
        .makeApiClient(CustomObjectsApi)
        .listNamespacedCustomObject({ ...DRAIN_RULES, namespace, labelSelector })
        .then(names)
        .catch(() => [] as string[]),
    ]);
    return [
      ...sets.map((n) => ({ kind: 'ClusterResourceSet', name: n })),
      ...drainRules.map((n) => ({ kind: 'MachineDrainRule', name: n })),
      ...secrets.map((n) => ({ kind: 'Secret', name: n })),
    ];
  }

  private async workload(
    connection: string,
    namespace: string,
    name: string,
  ): Promise<WorkloadApi | undefined> {
    try {
      return this.workloadApiFor(await this.clusters.kubeconfig(connection, namespace, name));
    } catch {
      return undefined;
    }
  }

  private async readCluster(kc: KubeConfig, namespace: string, name: string) {
    try {
      return (await kc
        .makeApiClient(CustomObjectsApi)
        .getNamespacedCustomObject({ ...CAPI, namespace, name })) as {
        metadata?: { annotations?: Record<string, string> };
      };
    } catch (err) {
      throw toHttpException(err, `Read cluster ${namespace}/${name}`);
    }
  }

  private async annotate(
    kc: KubeConfig,
    namespace: string,
    name: string,
    status: DeletionStatus,
  ): Promise<void> {
    // Merge patch, not apply: it must never re-create a Cluster that is already gone.
    await KubernetesObjectApi.makeApiClient(kc)
      .patch(
        {
          apiVersion: 'cluster.x-k8s.io/v1beta2',
          kind: 'Cluster',
          metadata: {
            name,
            namespace,
            annotations: { [DELETION_ANNOTATION]: JSON.stringify(status) },
          },
        },
        undefined,
        undefined,
        DELETION_MANAGER,
        undefined,
        PatchStrategy.MergePatch,
      )
      .catch((err: unknown) => {
        if (!isNotFound(err)) throw toHttpException(err, 'Record the deletion progress');
      });
  }
}
