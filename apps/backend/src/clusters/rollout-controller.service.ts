import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CoordinationV1Api, CustomObjectsApi, type KubeConfig } from '@kubernetes/client-node';
import {
  groupVersion,
  CLUSTER_SPEC_ANNOTATION,
  ClusterSpecSchema,
  FLAVOR_PLUGINS,
  INFRA_PLUGINS,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  type ClusterSpec,
} from '@capi-navigator/shared';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { deleteObjects } from '../kube/apply.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { acquireLease } from '../kube/lease.js';
import { StoreService } from '../store/store.service.js';
import { ClustersService, CONTROL_PLANE_RESOURCES } from './clusters.service.js';
import type { K8sObj } from './status.js';

const LEASE_NAME = 'capi-navigator-rollout-controller';
const INTERVAL_MS = 20_000;
const LEASE_SECONDS = 60;
/** Templates younger than this are never deleted (they may be about to be referenced). */
const TEMPLATE_MIN_AGE_MS = 10 * 60_000;
const CLUSTER_NAME_LABEL = 'cluster.x-k8s.io/cluster-name';
const CAPI = { group: 'cluster.x-k8s.io', version: 'v1beta2' };

/**
 * Same version; providers may report it without the distribution suffix (K0sControlPlane
 * status.version is the minimum Kubernetes version of its machines, e.g. "v1.35.8").
 */
export function sameVersion(reported: string | undefined, wanted: string): boolean {
  if (!reported) return false;
  if (reported === wanted) return true;
  const core = (v: string) => v.split('+')[0];
  return !reported.includes('+') && core(reported) === core(wanted);
}

/** Control plane state relevant for an upgrade. */
export function controlPlaneAt(cp: K8sObj | undefined, version: string): boolean {
  if (!cp) return false;
  const replicas = Number(cp.spec?.replicas ?? 0);
  const st = cp.status ?? {};
  return (
    sameVersion(st.version as string | undefined, version) &&
    Number(st.upToDateReplicas ?? -1) === replicas &&
    // Old machines must be gone, not only new ones be ready (seen with K0sControlPlane).
    Number(st.replicas ?? replicas) === replicas &&
    Number(st.readyReplicas ?? st.availableReplicas ?? -1) >= replicas
  );
}

/** Templates nobody references anymore (no CP, MachineDeployment or MachineSet). */
export function unusedTemplates(
  templates: K8sObj[],
  referencing: unknown[],
  now: number,
): K8sObj[] {
  const refs = JSON.stringify(referencing);
  return templates.filter((t) => {
    const created = new Date(t.metadata.creationTimestamp ?? now).getTime();
    return now - created > TEMPLATE_MIN_AGE_MS && !refs.includes(`"${t.metadata.name}"`);
  });
}

/**
 * Background rollout controller (FP7-F-08, FP7-F-15; ADR-0010): lets the worker pools follow
 * an upgrade once the control plane runs the new version, and deletes machine and bootstrap
 * templates no longer referenced after a rollout. One replica at a time (Lease); the state
 * lives in the stored cluster spec, so the backend stays stateless.
 */
@Injectable()
export class RolloutControllerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RolloutControllerService.name);
  private readonly leases: CoordinationV1Api;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    kube: KubeClientFactory,
    private readonly store: StoreService,
    private readonly clients: ManagementClusterClients,
    private readonly clusters: ClustersService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.leases = kube.homeCluster().makeApiClient(CoordinationV1Api);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.warn(`Rollout controller run failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  async runOnce(now = new Date()): Promise<void> {
    const leader = await acquireLease(
      this.leases,
      {
        namespace: this.store.namespace,
        name: LEASE_NAME,
        holder: this.config.POD_NAME,
        durationSeconds: LEASE_SECONDS,
      },
      now,
    );
    if (!leader) return;
    for (const conn of this.store.connectionCache.list()) {
      const connection = conn.metadata.name;
      try {
        const kc = await this.clients.forConnection(connection);
        const list = (await kc.makeApiClient(CustomObjectsApi).listClusterCustomObject({
          ...CAPI,
          plural: 'clusters',
        })) as { items: K8sObj[] };
        for (const cluster of list.items) {
          const raw = cluster.metadata.annotations?.[CLUSTER_SPEC_ANNOTATION];
          if (!raw || (cluster.metadata as { deletionTimestamp?: string }).deletionTimestamp)
            continue;
          const parsed = ClusterSpecSchema.safeParse(JSON.parse(raw));
          if (!parsed.success) continue;
          await this.reconcile(connection, kc, parsed.data, now).catch((err: unknown) =>
            this.logger.warn(
              `${connection}/${parsed.data.namespace}/${parsed.data.name}: ${String(err)}`,
            ),
          );
        }
      } catch (err) {
        this.logger.debug(`Connection ${connection} skipped: ${String(err)}`);
      }
    }
  }

  private async reconcile(connection: string, kc: KubeConfig, spec: ClusterSpec, now: Date) {
    const custom = kc.makeApiClient(CustomObjectsApi);
    const { namespace, name } = spec;
    const flavor = FLAVOR_PLUGINS[spec.kubernetes.flavor];
    if (!flavor) return;
    const cpRes = flavor.controlPlaneResource;
    const cps = (await custom.listNamespacedCustomObject({
      group: cpRes.group,
      version: cpRes.version,
      plural: cpRes.plural,
      namespace,
      labelSelector: `${CLUSTER_NAME_LABEL}=${name}`,
    })) as { items: K8sObj[] };
    const cp = cps.items[0];

    // 1. Upgrade: the workers follow once the control plane runs the new version.
    if (spec.kubernetes.workerVersion) {
      if (!controlPlaneAt(cp, spec.kubernetes.version)) return;
      this.logger.log(
        `${namespace}/${name}: control plane at ${spec.kubernetes.version}; upgrading workers`,
      );
      try {
        await this.clusters.applyChange(
          connection,
          namespace,
          name,
          (s) => {
            const next = structuredClone(s);
            delete next.kubernetes.workerVersion;
            return next;
          },
          false,
          { finishUpgrade: true },
        );
        await this.record(connection, name, 'cluster.upgrade.workers', 'success');
      } catch (err) {
        await this.record(
          connection,
          name,
          'cluster.upgrade.workers',
          'failure',
          String(err).slice(0, 300),
        );
        throw err;
      }
      return;
    }

    // 2. Cleanup after rollouts: only when nothing is rolling.
    const mds = (await custom.listNamespacedCustomObject({
      ...CAPI,
      namespace,
      plural: 'machinedeployments',
      labelSelector: `${CLUSTER_NAME_LABEL}=${name}`,
    })) as { items: K8sObj[] };
    const rolling = [cp, ...mds.items].some(
      (o) => o && Number(o.status?.upToDateReplicas ?? -1) < Number(o.spec?.replicas ?? 0),
    );
    if (rolling) return;
    const sets = (await custom.listNamespacedCustomObject({
      ...CAPI,
      namespace,
      plural: 'machinesets',
      labelSelector: `${CLUSTER_NAME_LABEL}=${name}`,
    })) as { items: K8sObj[] };
    const selector = `${CLUSTER_NAME_LABEL}=${name},${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`;
    const infra = INFRA_PLUGINS[spec.infrastructure.provider];
    const kinds = [
      {
        ...groupVersion(infra.apiVersion),
        plural: infra.resources.machineTemplatePlural,
        kind: infra.machineTemplateKind,
      },
      {
        group: flavor.bootstrapResources.group,
        version: flavor.bootstrapResources.version,
        plural: flavor.bootstrapResources.templatePlural,
        kind: flavor.bootstrapResources.templateKind,
      },
    ];
    const referencing = [
      cp?.spec,
      ...mds.items.map((m) => m.spec),
      ...sets.items.map((m) => m.spec),
    ];
    for (const k of kinds) {
      const templates = (await custom.listNamespacedCustomObject({
        group: k.group,
        version: k.version,
        plural: k.plural,
        namespace,
        labelSelector: selector,
      })) as { items: K8sObj[] };
      const unused = unusedTemplates(templates.items, referencing, now.getTime());
      if (unused.length === 0) continue;
      this.logger.log(
        `${namespace}/${name}: deleting unused ${k.kind}(s) ${unused.map((t) => t.metadata.name).join(', ')}`,
      );
      await deleteObjects(
        kc,
        unused.map((t) => ({
          apiVersion: `${k.group}/${k.version}`,
          kind: k.kind,
          metadata: { name: t.metadata.name, namespace },
        })),
      );
    }
  }

  private record(
    connection: string,
    cluster: string,
    action: string,
    outcome: 'success' | 'failure',
    message?: string,
  ) {
    return this.audit
      .record({
        actor: 'system:rollout-controller',
        action,
        outcome,
        target: { kind: 'Cluster', name: cluster },
        managementCluster: connection,
        ...(message ? { message } : {}),
      })
      .catch(() => undefined);
  }
}

export { CONTROL_PLANE_RESOURCES };
