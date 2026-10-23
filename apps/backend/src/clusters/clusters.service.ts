import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CoreV1Api,
  CustomObjectsApi,
  type KubeConfig,
  type KubernetesObject,
} from '@kubernetes/client-node';
import {
  buildAddonPreset,
  catalogEntry,
  compareVersions,
  distributionCatalog,
  CLUSTER_SPEC_ANNOTATION,
  ClusterSpecSchema,
  infraSummary,
  SpecChangeError,
  objectKey,
  objectsTouchedBy,
  stableStringify,
  type ClusterChangePreview,
  type Drift,
  type ObjectDiff,
  FLAVOR_PLUGINS,
  buildCalicoResourceSet,
  buildManifestAddonResourceSet,
  CALICO_MANIFEST,
  manifestAddonsFor,
  INFRA_PLUGINS,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  presetsFor,
  transform,
  type ClusterPreview,
  type ClusterSpec,
  type ClusterStatus,
  type ClusterSummary,
  type ManifestObject,
} from '@capi-navigator/shared';
import { stringify } from 'yaml';
import { ZodError } from 'zod';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { CredentialsService } from '../credentials/credentials.service.js';
import {
  buildCloudConf,
  buildCloudConfigResourceSetSecret,
} from '../infra-providers/openstack/cloud-config.js';
import { readStoredCloud } from '../infra-providers/openstack/clouds-yaml.js';
import {
  deleteObjects,
  dryRunApply,
  normalizeForDiff,
  readLive,
  serverSideApply,
} from '../kube/apply.js';
import { FIELD_MANAGER } from '../store/custom-resource.client.js';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';
import { calicoManifest, shippedManifest } from './cni-manifest.js';
import { OperatorService } from '../operator/operator.service.js';
import { ImageNameCache } from './image-names.js';
import { analyzeRollouts, type PlannedObject } from './rollouts.js';

/** Extra checks of a change (FP7-F-09). */
export interface ChangeOptions {
  upgrade?: boolean;
  /** The rollout controller lets the workers follow an upgrade (FP7-F-08). */
  finishUpgrade?: boolean;
  /**
   * FP7-F-19: apply every generated object that differs from the live one, including differences
   * from a newer app version (the explicit update action of ADR-0025).
   */
  all?: boolean;
}
import {
  CLUSTER_NAME_LABEL,
  infraPluginFor,
  toStatus,
  toSummary,
  type K8sEvent,
  type K8sObj,
} from './status.js';

const CAPI = { group: 'cluster.x-k8s.io', version: 'v1beta2' };
const INFRA_GROUP = { group: 'infrastructure.cluster.x-k8s.io', version: 'v1beta2' };

/** Control plane resources of all distributions (hard rule 10: from the plugins). */
export const CONTROL_PLANE_RESOURCES = Object.values(FLAVOR_PLUGINS).flatMap((p) =>
  p ? [p.controlPlaneResource] : [],
);

/** Plurals and versions of referenced control plane and infrastructure kinds. */
const KINDS: Record<string, { group: string; version: string; plural: string }> =
  Object.fromEntries([
    ...CONTROL_PLANE_RESOURCES.map((r) => [
      r.kind,
      { group: r.group, version: r.version, plural: r.plural },
    ]),
    ...Object.values(INFRA_PLUGINS).map((p) => [
      p.infraClusterKind,
      { ...INFRA_GROUP, plural: p.resources.infraClusterPlural },
    ]),
  ]);

/** Watch paths for the live status of the clusters in one namespace (NF-11). */
export function namespaceWatchPaths(ns: string): string[] {
  return [
    `/apis/cluster.x-k8s.io/v1beta2/namespaces/${ns}/clusters`,
    `/apis/cluster.x-k8s.io/v1beta2/namespaces/${ns}/machines`,
    `/apis/cluster.x-k8s.io/v1beta2/namespaces/${ns}/machinedeployments`,
    ...CONTROL_PLANE_RESOURCES.map(
      (r) => `/apis/${r.group}/${r.version}/namespaces/${ns}/${r.plural}`,
    ),
    ...Object.values(INFRA_PLUGINS).flatMap((p) => [
      `/apis/infrastructure.cluster.x-k8s.io/v1beta2/namespaces/${ns}/${p.resources.infraClusterPlural}`,
      `/apis/infrastructure.cluster.x-k8s.io/v1beta2/namespaces/${ns}/${p.resources.machinePlural}`,
    ]),
    `/api/v1/namespaces/${ns}/events`,
  ];
}

/** Watch paths for the cluster list of a management cluster (FP6-F-01). */
export function listWatchPaths(): string[] {
  return [
    '/apis/cluster.x-k8s.io/v1beta2/clusters',
    '/apis/cluster.x-k8s.io/v1beta2/machinedeployments',
    ...CONTROL_PLANE_RESOURCES.map((r) => `/apis/${r.group}/${r.version}/${r.plural}`),
  ];
}

interface Plan {
  kc: KubeConfig;
  objects: KubernetesObject[];
  /** Same objects for the preview, Secret values masked. */
  previewObjects: KubernetesObject[];
  warnings: string[];
  blockers: string[];
  credentialNamespaceMissing: boolean;
  /** Older versions of the namespace's add-on resource sets, replaced by the new ones. */
  removed: KubernetesObject[];
  /** Keys of the objects from the transformation (not namespace, presets or resource sets). */
  generated: Set<string>;
  /** With a baseline spec: the generated objects the change touches (ADR-0025). */
  touched?: Set<string>;
}

/**
 * Workload clusters (FP-5): preview, create, list and status. Manifests come from the pure
 * transformation; the backend only adds what needs I/O (namespace, presets, cloud config Secret).
 */
@Injectable()
export class ClustersService {
  /** Image names per credential, cached (read-only cloud lookups, FP6-F-02). */
  private readonly imageNames = new ImageNameCache();

  constructor(
    private readonly clients: ManagementClusterClients,
    private readonly credentials: CredentialsService,
    private readonly operator: OperatorService,
    private readonly store: StoreService,
  ) {}

  /** FP5-F-08 and hard rule 6: generated YAML, dry run errors, blockers. */
  async preview(
    connection: string,
    spec: ClusterSpec,
    grantNamespace: boolean,
  ): Promise<ClusterPreview> {
    const plan = await this.plan(connection, spec, grantNamespace);
    await this.dryRun(plan);
    return {
      yaml: plan.previewObjects.map((o) => stringify(o, { lineWidth: 0 })).join('---\n'),
      objects: plan.objects.map((o) => ({
        kind: o.kind ?? '',
        name: o.metadata?.name ?? '',
        ...(o.metadata?.namespace ? { namespace: o.metadata.namespace } : {}),
      })),
      warnings: plan.warnings,
      blockers: plan.blockers,
      credentialNamespaceMissing: plan.credentialNamespaceMissing,
    };
  }

  /** Server-side apply with field manager capi-navigator (hard rule 6). */
  async create(
    connection: string,
    spec: ClusterSpec,
    grantNamespace: boolean,
  ): Promise<ClusterSummary> {
    const plan = await this.plan(connection, spec, grantNamespace);
    if (plan.blockers.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: plan.blockers[0],
        hint: plan.blockers.slice(1).join(' ') || undefined,
      });
    }
    const existing = await this.getCluster(plan.kc, spec.namespace, spec.name);
    if (existing) {
      throw new ConflictException({
        statusCode: 409,
        message: `Cluster ${spec.namespace}/${spec.name} already exists`,
      });
    }
    if (plan.credentialNamespaceMissing && grantNamespace) {
      await this.credentials.allowNamespace(
        connection,
        spec.infrastructure.provider,
        spec.infrastructure.credentialRef,
        spec.namespace,
      );
    }
    await this.kube(`Create cluster ${spec.name}`, async () => {
      await serverSideApply(plan.kc, plan.objects);
      await deleteObjects(plan.kc, plan.removed);
    });
    // Read back for status; right after creation the applied object is good enough.
    const applied = plan.objects.find((o) => o.kind === 'Cluster') as unknown as K8sObj;
    const cluster =
      (await this.getCluster(plan.kc, spec.namespace, spec.name).catch(() => undefined)) ?? applied;
    return toSummary(cluster);
  }

  async list(connection: string): Promise<ClusterSummary[]> {
    const kc = await this.clients.forConnection(connection);
    return this.kube('List clusters', async () => {
      const api = kc.makeApiClient(CustomObjectsApi);
      const clusters = await listAll(api, 'clusters');
      if (clusters.length === 0) return [];
      const mds = await listAll(api, 'machinedeployments');
      const cps = (
        await Promise.all(
          CONTROL_PLANE_RESOURCES.map(async (r) =>
            (await listAll(api, r.plural, r)).map((o) => ({ ...o, kind: r.kind })),
          ),
        )
      ).flat();
      return clusters
        .map((c) => {
          const ns = c.metadata.namespace;
          const ref = c.spec?.controlPlaneRef as { kind?: string; name?: string } | undefined;
          const cp = cps.find(
            (x) =>
              x.metadata.namespace === ns && x.metadata.name === ref?.name && x.kind === ref.kind,
          );
          const pools = mds.filter(
            (md) =>
              md.metadata.namespace === ns &&
              md.metadata.labels?.[CLUSTER_NAME_LABEL] === c.metadata.name,
          );
          return toSummary(c, cp, pools);
        })
        .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
    });
  }

  async status(connection: string, namespace: string, name: string): Promise<ClusterStatus> {
    const kc = await this.clients.forConnection(connection);
    const cluster = await this.getCluster(kc, namespace, name);
    if (!cluster) throw new NotFoundException(`Cluster ${namespace}/${name} not found`);
    return this.kube('Read cluster status', async () => {
      const api = kc.makeApiClient(CustomObjectsApi);
      const ref = (key: 'controlPlaneRef' | 'infrastructureRef') =>
        cluster.spec?.[key] as { kind?: string; name?: string } | undefined;
      const read = async (r?: { kind?: string; name?: string }) => {
        const def = r?.kind ? KINDS[r.kind] : undefined;
        if (!def || !r?.name) return undefined;
        try {
          const o = (await api.getNamespacedCustomObject({
            ...def,
            namespace,
            name: r.name,
          })) as K8sObj;
          return { ...o, kind: r.kind };
        } catch (err) {
          if (isNotFound(err)) return undefined;
          throw err;
        }
      };
      const selector = `${CLUSTER_NAME_LABEL}=${name}`;
      const infraPlugin = infraPluginFor(ref('infrastructureRef')?.kind);
      const items = (res: unknown, kind: string) =>
        ((res as { items: K8sObj[] }).items ?? []).map((o) => ({ ...o, kind }));
      const [cp, infra, mds, machines, infraMachines, events, kubeconfig] = await Promise.all([
        read(ref('controlPlaneRef')),
        read(ref('infrastructureRef')),
        api.listNamespacedCustomObject({
          ...CAPI,
          namespace,
          plural: 'machinedeployments',
          labelSelector: selector,
        }),
        api.listNamespacedCustomObject({
          ...CAPI,
          namespace,
          plural: 'machines',
          labelSelector: selector,
        }),
        infraPlugin
          ? api
              .listNamespacedCustomObject({
                ...INFRA_GROUP,
                namespace,
                plural: infraPlugin.resources.machinePlural,
                labelSelector: selector,
              })
              .then((r) => items(r, infraPlugin.resources.machineKind))
              .catch(() => [] as K8sObj[])
          : Promise.resolve([] as K8sObj[]),
        // Events are best effort: missing permissions must not break the status view.
        kc
          .makeApiClient(CoreV1Api)
          .listNamespacedEvent({ namespace })
          .then((r) => r.items as K8sEvent[])
          .catch(() => [] as K8sEvent[]),
        kc
          .makeApiClient(CoreV1Api)
          .readNamespacedSecret({ name: `${name}-kubeconfig`, namespace })
          .then(
            () => true,
            () => false,
          ),
      ]);
      const status = toStatus({
        cluster: { ...cluster, kind: 'Cluster' },
        infra,
        cp,
        mds: items(mds, 'MachineDeployment'),
        machines: items(machines, 'Machine'),
        infraMachines,
        events,
        kubeconfigAvailable: kubeconfig,
      });
      return this.withImageNames(connection, cluster, status, infra);
    });
  }

  /**
   * Adds the infrastructure summary of managed clusters and resolves image names with the
   * cluster's credentials (read-only, cached). Best effort: without names the IDs are shown.
   */
  private async withImageNames(
    connection: string,
    cluster: K8sObj,
    status: ClusterStatus,
    infraObj?: K8sObj,
  ): Promise<ClusterStatus> {
    const raw = cluster.metadata.annotations?.[CLUSTER_SPEC_ANNOTATION];
    const parsed = raw ? ClusterSpecSchema.safeParse(safeJson(raw)) : undefined;
    if (!parsed?.success) return status;
    const spec = parsed.data;
    // FP5-F-20: bastion from the spec plus address and state from the provider.
    const b = 'bastion' in spec.infrastructure ? spec.infrastructure.bastion : undefined;
    const bastion =
      b && (b.enabled || infraObj?.status?.bastion)
        ? {
            enabled: b.enabled,
            ...(b.allowedCidrs ? { allowedCidrs: b.allowedCidrs } : {}),
            ...(b.machineSize ? { machineSize: b.machineSize } : {}),
            ...INFRA_PLUGINS[spec.infrastructure.provider].bastionStatus(infraObj?.status ?? {}),
            openToAll: spec.infrastructure.provider === 'openstack',
          }
        : undefined;
    const summary = infraSummary(spec);
    const ids = [
      ...new Set([
        ...summary.groups.flatMap((g) => (g.image ? [g.image.id] : [])),
        ...status.machines.flatMap((m) => (m.image ? [m.image] : [])),
      ]),
    ];
    const infra = spec.infrastructure;
    const names = await this.imageNames.resolve(
      `${connection}|${infra.provider}|${infra.credentialRef}|${'region' in infra ? infra.region : ''}`,
      ids,
      (missing) =>
        this.credentials.imageNames(
          connection,
          infra.provider,
          infra.credentialRef,
          missing,
          'region' in infra ? infra.region : undefined,
        ),
    );
    const ref = (id: string) =>
      names.has(id)
        ? { id, ...(names.get(id) ? { name: names.get(id)! } : { notFound: true }) }
        : { id };
    return {
      ...status,
      ...(bastion ? { bastion } : {}),
      machines: status.machines.map((m) =>
        m.image && names.get(m.image) ? { ...m, imageName: names.get(m.image)! } : m,
      ),
      infraSummary: {
        ...summary,
        groups: summary.groups.map((g) => (g.image ? { ...g, image: ref(g.image.id) } : g)),
      },
    };
  }

  /**
   * Kubeconfig of a workload cluster from the CAPI Secret `<name>-kubeconfig` (FP6-F-04). The one
   * deliberate exception to NF-01 (ADR-0005): only for operators, audited, never cached or logged.
   */
  async kubeconfig(connection: string, namespace: string, name: string): Promise<string> {
    const kc = await this.clients.forConnection(connection);
    if (!(await this.getCluster(kc, namespace, name))) {
      throw new NotFoundException(`Cluster ${namespace}/${name} not found`);
    }
    let value: string | undefined;
    try {
      const secret = await kc
        .makeApiClient(CoreV1Api)
        .readNamespacedSecret({ name: `${name}-kubeconfig`, namespace });
      value = secret.data?.value;
    } catch (err) {
      if (!isNotFound(err)) throw toHttpException(err, 'Read the kubeconfig Secret');
    }
    if (!value) {
      throw new NotFoundException({
        message: `The kubeconfig of ${namespace}/${name} is not available yet`,
        hint: 'CAPI creates it once the control plane is initialized.',
      });
    }
    return Buffer.from(value, 'base64').toString('utf8');
  }

  // ---- spec changes (FP6-F-05, FP6-F-07; hard rules 4 and 6) ----

  /** The stored spec of a cluster created by the app; external clusters are read-only. */
  async storedSpec(connection: string, namespace: string, name: string): Promise<ClusterSpec> {
    const kc = await this.clients.forConnection(connection);
    const cluster = await this.getCluster(kc, namespace, name);
    if (!cluster) throw new NotFoundException(`Cluster ${namespace}/${name} not found`);
    const raw = cluster.metadata.annotations?.[CLUSTER_SPEC_ANNOTATION];
    if (!raw) {
      throw new ConflictException({
        message: `Cluster ${namespace}/${name} was created outside CAPI Navigator`,
        hint: 'Clusters without a stored cluster spec are shown read-only.',
      });
    }
    const parsed = ClusterSpecSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new ConflictException({
        message: `The stored cluster spec of ${namespace}/${name} is invalid`,
        hint: 'It was probably edited outside the app; restore the annotation or recreate the cluster.',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    return parsed.data;
  }

  /**
   * Preview of a spec change: the manifests are regenerated and dry-run applied object by object;
   * only objects that change are shown (and later applied). Fields owned by other managers are
   * reported as drift (hard rule 4).
   */
  async changePreview(
    connection: string,
    namespace: string,
    name: string,
    mutate: (spec: ClusterSpec) => ClusterSpec,
    opts: ChangeOptions = {},
  ): Promise<ClusterChangePreview> {
    const { preview } = await this.changePlan(connection, namespace, name, mutate, opts);
    return preview;
  }

  /** Applies only the changed objects; drift on them needs `takeOver` (hard rule 4). */
  async applyChange(
    connection: string,
    namespace: string,
    name: string,
    mutate: (spec: ClusterSpec) => ClusterSpec,
    takeOver: boolean,
    opts: ChangeOptions = {},
  ): Promise<ClusterChangePreview> {
    const { preview, changed, removed, kc } = await this.changePlan(
      connection,
      namespace,
      name,
      mutate,
      opts,
    );
    if (preview.blockers.length > 0) {
      throw new ConflictException({
        message: 'The change cannot be applied',
        hint: preview.blockers.join(' '),
      });
    }
    if (preview.drift.some((d) => d.blocking) && !takeOver) {
      throw new ConflictException({
        message: 'Fields of this change were modified outside CAPI Navigator',
        hint: 'Review the drift in the preview and confirm taking the fields over.',
      });
    }
    await this.kube('Apply the change', async () => {
      await serverSideApply(kc, changed, { force: takeOver });
      // FP7-F-06: pools removed from the spec; their templates are cleaned up after the rollout.
      await deleteObjects(kc, removed);
    });
    return preview;
  }

  private async changePlan(
    connection: string,
    namespace: string,
    name: string,
    mutate: (spec: ClusterSpec) => ClusterSpec,
    opts: ChangeOptions,
  ) {
    const current = await this.storedSpec(connection, namespace, name);
    let next: ClusterSpec;
    try {
      next = mutate(current);
    } catch (err) {
      if (err instanceof SpecChangeError || err instanceof ZodError) {
        throw new BadRequestException({
          message: err instanceof ZodError ? 'The change is not valid' : err.message,
          ...(err instanceof ZodError
            ? { details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
            : {}),
        });
      }
      throw err;
    }
    // ADR-0025: only what the change itself touches; older generated objects stay as they are.
    const plan = await this.plan(connection, next, false, opts.all ? undefined : current);
    const outdated: string[] = [];
    const diffs: ObjectDiff[] = [];
    const drift: Drift[] = [];
    const changed: KubernetesObject[] = [];
    const planned: PlannedObject[] = [];
    const removed: KubernetesObject[] = [];
    const removedDeployments: { name: string; before: Record<string, unknown> }[] = [];
    let machines: K8sObj[] = [];
    await this.kube('Compare with the cluster (dry run)', async () => {
      for (const obj of plan.objects) {
        const live = await readLive(plan.kc, obj);
        const { result, conflict } = await dryRunApply(plan.kc, obj);
        const before = live ? normalizeForDiff(live) : undefined;
        const after = normalizeForDiff(result);
        const key = objectKey(obj);
        if (live && plan.touched && plan.generated.has(key) && !plan.touched.has(key)) {
          // Not part of this change: compared as unchanged, reported if this app version would
          // generate it differently (e.g. after an app update).
          planned.push({
            kind: obj.kind ?? '',
            name: obj.metadata?.name ?? '',
            before: { ...before, status: (live as { status?: unknown }).status },
            after: before!,
          });
          if (stableStringify(before) !== stableStringify(after)) {
            outdated.push(`${obj.kind} ${obj.metadata?.name}`);
          }
          continue;
        }
        planned.push({
          kind: obj.kind ?? '',
          name: obj.metadata?.name ?? '',
          // Status is part of the live object for rollout checks.
          ...(live ? { before: { ...before, status: (live as { status?: unknown }).status } } : {}),
          after,
        });
        const differs = !before || stableStringify(before) !== stableStringify(after);
        const ref = { kind: obj.kind ?? '', name: obj.metadata?.name ?? '' };
        if (conflict) drift.push({ ...ref, ...conflict, blocking: differs });
        if (!differs) continue;
        changed.push(obj);
        diffs.push({
          ...ref,
          ...(obj.metadata?.namespace ? { namespace: obj.metadata.namespace } : {}),
          change: live ? 'update' : 'create',
          before: before ? stringify(before, { lineWidth: 0 }) : '',
          after: stringify(after, { lineWidth: 0 }),
        });
      }
      // Older add-on resource sets replaced by the new ones (warned about in the plan).
      for (const obj of plan.removed) {
        removed.push(obj);
        diffs.push({
          kind: obj.kind ?? '',
          name: obj.metadata?.name ?? '',
          namespace,
          change: 'delete',
          before: '',
          after: '',
        });
      }
      // Prune: MachineDeployments of pools that are no longer in the spec (FP7-F-06).
      const custom = plan.kc.makeApiClient(CustomObjectsApi);
      const selector = `${CLUSTER_NAME_LABEL}=${name},${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`;
      const liveMds = (
        (await custom.listNamespacedCustomObject({
          ...CAPI,
          namespace,
          plural: 'machinedeployments',
          labelSelector: selector,
        })) as { items: (KubernetesObject & K8sObj)[] }
      ).items;
      const desired = new Set(
        plan.objects.filter((o) => o.kind === 'MachineDeployment').map((o) => o.metadata?.name),
      );
      for (const md of liveMds.filter((m) => !desired.has(m.metadata.name))) {
        const before = normalizeForDiff({
          ...md,
          apiVersion: 'cluster.x-k8s.io/v1beta2',
          kind: 'MachineDeployment',
        });
        removed.push({
          apiVersion: 'cluster.x-k8s.io/v1beta2',
          kind: 'MachineDeployment',
          metadata: { name: md.metadata.name, namespace },
        });
        removedDeployments.push({ name: md.metadata.name, before });
        diffs.push({
          kind: 'MachineDeployment',
          name: md.metadata.name,
          namespace,
          change: 'delete',
          before: stringify(before, { lineWidth: 0 }),
          after: '',
        });
      }
      machines = (
        (await custom.listNamespacedCustomObject({
          ...CAPI,
          namespace,
          plural: 'machines',
          labelSelector: `${CLUSTER_NAME_LABEL}=${name}`,
        })) as { items: K8sObj[] }
      ).items;
    });
    const { rollouts, running } = analyzeRollouts({
      controlPlaneKinds: CONTROL_PLANE_RESOURCES.map((r) => r.kind),
      objects: planned,
      removedDeployments,
      machines,
      workerVersionPending: !!next.kubernetes.workerVersion && !current.kubernetes.workerVersion,
      inPlaceVersionKinds: Object.values(FLAVOR_PLUGINS)
        .filter((p) => p?.controlPlaneUpdates?.versionInPlace)
        .map((p) => p!.controlPlaneResource.kind),
    });
    const blockers = [...plan.blockers];
    const replaces = rollouts.some((r) => r.action === 'replace');
    // FP7-F-17: one rollout at a time.
    if ((replaces || opts.upgrade) && running.length > 0) {
      blockers.push(
        `A rollout is still running (${running.join(', ')}); wait until it has finished.`,
      );
    }
    if (current.kubernetes.workerVersion && replaces && !opts.finishUpgrade) {
      blockers.push('An upgrade is still running; wait until the worker pools have followed.');
    }
    // ADR-0013: some distributions cannot replace control plane machines, or only from a fixed
    // provider version on.
    const cpUpdates = FLAVOR_PLUGINS[next.kubernetes.flavor]?.controlPlaneUpdates;
    const cpReplaced = rollouts.some(
      (r) => r.action === 'replace' && CONTROL_PLANE_RESOURCES.some((c) => c.kind === r.kind),
    );
    if (cpUpdates?.replacementBlocked && cpReplaced) {
      const fixed = cpUpdates.replacementFixedIn;
      const installed = fixed ? await this.installedVersion(connection, fixed.provider) : undefined;
      const nodes = Math.max(
        current.topology.controlPlane.replicas,
        next.topology.controlPlane.replicas,
      );
      if (!fixed || !installed || compareVersions(installed, fixed.version) < 0) {
        blockers.push(cpUpdates.replacementBlocked);
      } else if (fixed.maxReplicas !== undefined && nodes > fixed.maxReplicas) {
        blockers.push(fixed.multiNodeReason ?? cpUpdates.replacementBlocked);
      }
    }
    // FP7-F-09: pre-checks before an upgrade.
    if (opts.upgrade) blockers.push(...(await this.upgradeChecks(connection, next, machines)));
    const warnings = [...plan.warnings];
    if (replaces) {
      const onlyNode =
        next.topology.mode === 'all-in-one' && next.topology.controlPlane.replicas === 1;
      warnings.unshift(
        onlyNode
          ? 'This change replaces the only node of the cluster: all workloads restart, and volumes bound to another availability zone cannot follow.'
          : 'This change replaces machines (see the rollout plan); workloads move to the new nodes.',
      );
    }
    if (outdated.length) {
      warnings.push(
        `Not part of this change: ${outdated.join(', ')} ${outdated.length > 1 ? 'differ' : 'differs'} from what this app version generates (e.g. after an app update) and ${outdated.length > 1 ? 'are' : 'is'} left as is, since applying ${outdated.length > 1 ? 'them' : 'it'} may replace machines.`,
      );
    }
    const scaleDown = FLAVOR_PLUGINS[next.kubernetes.flavor]?.controlPlaneUpdates?.scaleDownWarning;
    if (scaleDown && next.topology.controlPlane.replicas < current.topology.controlPlane.replicas) {
      warnings.push(scaleDown);
    }
    for (const d of drift.filter((x) => !x.blocking)) {
      warnings.push(
        `${d.kind} ${d.name} was changed outside the app (${d.fields.join(', ') || 'fields'} by ${d.managers.join(', ')}); this change does not touch it.`,
      );
    }
    const preview: ClusterChangePreview = {
      diffs,
      rollouts,
      drift,
      warnings,
      blockers,
    };
    return { preview, changed, removed, kc: plan.kc };
  }

  /** Version of an installed provider by catalog ID, as the operator reports it. */
  private async installedVersion(
    connection: string,
    provider: string,
  ): Promise<string | undefined> {
    const p = (await this.operator.state(connection)).providers.find(
      (x) => x.catalogId === provider,
    );
    return p?.installedVersion ?? p?.version;
  }

  /** FP7-F-09: all machines healthy; the providers support the target version. */
  private async upgradeChecks(
    connection: string,
    spec: ClusterSpec,
    machines: K8sObj[],
  ): Promise<string[]> {
    const problems: string[] = [];
    for (const m of machines) {
      const ready = (m.status?.conditions as { type: string; status: string }[] | undefined)?.some(
        (c) => c.type === 'Ready' && c.status === 'True',
      );
      if (m.status?.phase !== 'Running' || !ready) {
        problems.push(
          `Machine ${m.metadata.name} is not healthy (${String(m.status?.phase ?? 'Pending')}).`,
        );
      }
    }
    const catalog = distributionCatalog(spec.kubernetes.flavor);
    const entry = catalog?.versions.find((v) => v.version === spec.kubernetes.version);
    if (!entry) {
      problems.push(`${spec.kubernetes.version} is not in the version catalog.`);
    } else if (catalog) {
      const state = await this.operator.state(connection);
      for (const id of [catalog.providers.bootstrap, catalog.providers.controlPlane]) {
        const p = state.providers.find((x) => x.catalogId === id);
        const installed = p?.installedVersion ?? p?.version;
        if (installed && compareVersions(installed, entry.verifiedWithProvider) < 0) {
          problems.push(
            `${catalogEntry(id)?.displayName ?? id} ${installed} is older than ${entry.verifiedWithProvider}, which supports ${spec.kubernetes.version} (Providers page).`,
          );
        }
      }
    }
    return problems;
  }

  // ---- helpers ----

  private async plan(
    connection: string,
    spec: ClusterSpec,
    grantNamespace: boolean,
    /** The stored spec before a change; limits the change to what it touches (ADR-0025). */
    baseline?: ClusterSpec,
  ): Promise<Plan> {
    const kc = await this.clients.forConnection(connection);
    const infra = spec.infrastructure;
    const blockers: string[] = [];
    const warnings: string[] = [];

    // FP5-F-05, FP5-F-18: required providers installed and ready.
    const state = await this.operator.state(connection);
    const distribution = distributionCatalog(spec.kubernetes.flavor);
    const needed = [
      'core',
      ...(distribution
        ? [distribution.providers.bootstrap, distribution.providers.controlPlane]
        : []),
      infra.provider,
    ];
    const cniPreset =
      !!FLAVOR_PLUGINS[spec.kubernetes.flavor]?.needsCni && spec.addons.cni !== 'none';
    if (
      spec.addons.cloudControllerManager ||
      spec.addons.csiDriver ||
      spec.addons.rebootDaemon ||
      cniPreset
    ) {
      needed.push('helm');
    }
    for (const id of needed) {
      const p = state.providers.find((x) => x.catalogId === id);
      if (!p || p.phase !== 'Ready') {
        blockers.push(
          `${catalogEntry(id)?.displayName ?? id} must be installed and ready (Providers page).`,
        );
      }
    }
    if (infra.provider === 'openstack' && !state.prerequisites.orc.ready) {
      blockers.push('ORC must be installed and ready (Providers page).');
    }

    // Credentials (FP-4): tested successfully; namespace allowed (ADR-0002).
    let resolved: Awaited<ReturnType<CredentialsService['resolve']>> | undefined;
    try {
      resolved = await this.credentials.resolve(connection, infra.provider, infra.credentialRef);
    } catch (err) {
      if (err instanceof NotFoundException)
        blockers.push(`Credential "${infra.credentialRef}" not found (Credentials page).`);
      else throw err;
    }
    let credentialNamespaceMissing = false;
    if (resolved) {
      if (resolved.credential.lastTest?.ok !== true) {
        blockers.push(
          `Credential "${infra.credentialRef}" has not passed its test (Credentials page → Test).`,
        );
      }
      if (!resolved.credential.allowedNamespaces.includes(spec.namespace)) {
        credentialNamespaceMissing = true;
        if (!grantNamespace) {
          blockers.push(
            `Credential "${infra.credentialRef}" may not be used in namespace ${spec.namespace}.`,
          );
        } else {
          warnings.push(
            `Namespace ${spec.namespace} will be added to the allowed namespaces of credential "${infra.credentialRef}".`,
          );
        }
      }
    }

    const cloudName = resolved?.credential.summary.cloudName;
    const machineSizes = resolved?.credential.summary.machineSizes;
    const transformContext = {
      credential: {
        ...(cloudName ? { cloudName } : {}),
        ...(resolved ? { secret: resolved.credential.secret } : {}),
        // FP31-F-04: sizes of providers without flavors.
        ...(machineSizes ? { machineSizes } : {}),
      },
    };
    const infraPlugin = INFRA_PLUGINS[infra.provider];
    if (resolved) blockers.push(...(infraPlugin.validate?.(spec, infra, transformContext) ?? []));
    const generated = transform(spec, transformContext);
    const objects = generated as KubernetesObject[];
    const touched = baseline
      ? objectsTouchedBy(transform(baseline, transformContext), generated)
      : undefined;
    const extra: KubernetesObject[] = [];
    const extraPreview: KubernetesObject[] = [];
    const removed: KubernetesObject[] = [];
    /**
     * Older ClusterResourceSets of an add-on in the namespace, removed with their ConfigMaps when a
     * new version is added: otherwise new clusters would get every version. Clusters that already
     * got an older one keep its objects (ApplyOnce, upstream ClusterResourceSetBinding).
     */
    const supersede = async (selector: string, keep: string, what: string) => {
      const sets = (
        (await kc.makeApiClient(CustomObjectsApi).listNamespacedCustomObject({
          group: 'addons.cluster.x-k8s.io',
          version: 'v1beta2',
          namespace: spec.namespace,
          plural: 'clusterresourcesets',
          labelSelector: `${selector},${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
        })) as { items: K8sObj[] }
      ).items.filter((o) => o.metadata.name !== keep);
      for (const set of sets) {
        const name = set.metadata.name;
        removed.push(
          {
            apiVersion: 'addons.cluster.x-k8s.io/v1beta2',
            kind: 'ClusterResourceSet',
            metadata: { name, namespace: spec.namespace },
          },
          { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: spec.namespace } },
        );
        warnings.push(
          `Replaces ${what} ${name} in namespace ${spec.namespace} with ${keep}; clusters that already got it keep its objects.`,
        );
      }
    };

    // Namespace (created if missing).
    if (!(await this.namespaceExists(kc, spec.namespace))) {
      const ns = {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: spec.namespace, labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE } },
      };
      extra.push(ns);
      extraPreview.push(ns);
      warnings.push(
        `Namespace ${spec.namespace} will be created; its objects are validated when applied.`,
      );
    }

    // OpenStack cloud config for CCM/CSI via ClusterResourceSet (ADR-0004).
    if (
      infra.provider === 'openstack' &&
      resolved &&
      (spec.addons.cloudControllerManager || spec.addons.csiDriver)
    ) {
      const { cloud } = readStoredCloud(resolved.data['clouds.yaml'] ?? '');
      const conf = buildCloudConf(cloud, infra, !!resolved.data.cacert);
      const secret = buildCloudConfigResourceSetSecret(spec, conf, resolved.data.cacert);
      extra.push(secret);
      extraPreview.push({
        ...secret,
        data: { 'cloud-config.yaml': '********' },
      } as KubernetesObject);
    }

    // CCM/CSI presets, created on first use in the namespace (FP5-F-09, FP5-F-17). Presets that
    // only the app manages are brought up to date, so fixes reach namespaces with older presets;
    // presets changed by someone else are left alone and reported.
    const clusterObj = objects.find((o) => o.kind === 'Cluster') as ManifestObject | undefined;
    const overrides = await this.store.addonPresetOverrides();
    for (const preset of presetsFor(clusterObj?.metadata.labels ?? {}, overrides)) {
      const hcp = buildAddonPreset(preset, spec.namespace) as unknown as KubernetesObject & {
        spec: unknown;
      };
      const current = await this.getCustom(
        kc,
        'addons.cluster.x-k8s.io',
        'v1alpha1',
        'helmchartproxies',
        spec.namespace,
        hcp.metadata!.name!,
      );
      if (!current) {
        extra.push(hcp);
        extraPreview.push(hcp);
        continue;
      }
      if (presetUpToDate(current, hcp)) continue;
      if (onlyManagedByApp(current)) {
        extra.push(hcp);
        extraPreview.push(hcp);
        warnings.push(
          `Updates the add-on preset ${hcp.metadata!.name} in namespace ${spec.namespace} to the current version; clusters already using it are updated by CAAPH.`,
        );
      } else {
        warnings.push(
          `The add-on preset ${hcp.metadata!.name} in namespace ${spec.namespace} differs from the current version and was changed outside the app; it is left as is.`,
        );
      }
    }

    // FP25-F-08 (ADR-0023): add-ons without a Helm chart, selected by the Cluster's labels, once
    // per namespace via ClusterResourceSet; existing ones are left as they are (versioned names).
    for (const addon of manifestAddonsFor(clusterObj?.metadata.labels ?? {})) {
      const manifest = await shippedManifest(addon.dir, addon.file, addon.sha256);
      const [configMap, resourceSet] = buildManifestAddonResourceSet(
        addon,
        spec.namespace,
        manifest,
      ) as unknown as [KubernetesObject, KubernetesObject];
      const existing = await this.getCustom(
        kc,
        'addons.cluster.x-k8s.io',
        'v1beta2',
        'clusterresourcesets',
        spec.namespace,
        resourceSet.metadata!.name!,
      );
      if (!existing) {
        await this.kube('List add-on resource sets', () =>
          supersede(
            `capi-navigator.io/addon=${addon.id}`,
            resourceSet.metadata!.name!,
            `the ${addon.displayName} resource set`,
          ),
        );
        extra.push(configMap, resourceSet);
        extraPreview.push(
          {
            ...configMap,
            data: {
              [`${addon.id}.yaml`]: `# ${addon.displayName} ${addon.version} (upstream manifest ${addon.file}, sha256 ${addon.sha256.slice(0, 12)}…, adapted by the app), shortened in the preview`,
            },
          } as KubernetesObject,
          resourceSet,
        );
      }
    }

    // FP10-F-04 (ADR-0014): Calico for distributions without a built-in CNI, once per namespace
    // via ClusterResourceSet; existing ones are left as they are (versioned names for upgrades).
    if (FLAVOR_PLUGINS[spec.kubernetes.flavor]?.needsCni && spec.addons.cni !== 'none') {
      const manifest = await calicoManifest();
      const [configMap, resourceSet] = buildCalicoResourceSet(
        spec.namespace,
        manifest,
      ) as unknown as [KubernetesObject, KubernetesObject];
      const existing = await this.getCustom(
        kc,
        'addons.cluster.x-k8s.io',
        'v1beta2',
        'clusterresourcesets',
        spec.namespace,
        resourceSet.metadata!.name!,
      );
      if (!existing) {
        await this.kube('List Calico resource sets', () =>
          supersede(
            'capi-navigator.io/cni=calico',
            resourceSet.metadata!.name!,
            'the Calico resource set',
          ),
        );
        extra.push(configMap, resourceSet);
        extraPreview.push(
          {
            ...configMap,
            data: {
              'calico.yaml': `# Official Calico ${CALICO_MANIFEST.version} manifest (calico-vxlan.yaml, ${Math.round(manifest.length / 1024)} KB, sha256 ${CALICO_MANIFEST.sha256.slice(0, 12)}…) with VXLAN Always, shortened in the preview`,
            },
          } as KubernetesObject,
          resourceSet,
        );
      }
    }

    // FP26-F-04: every node of a multi-node all-in-one cluster carries workloads and etcd.
    if (spec.topology.mode === 'all-in-one' && spec.topology.controlPlane.replicas > 1) {
      warnings.push(
        `All ${spec.topology.controlPlane.replicas} nodes run the control plane, etcd and the workloads: choose machines with room for both, and SSD disks for etcd.`,
      );
    }
    if (spec.infrastructure.provider === 'aws') {
      warnings.push(
        'AWS: node user data is not stored in Secrets Manager (stock images, ADR-0003); IMDSv2 with hop limit 2 lets pods read the user data (join token) and instance profile credentials.',
      );
    }
    const hasCustomization = [spec.topology.controlPlane, ...spec.topology.workerPools].some(
      (g) =>
        (g.customization?.preCommands.length ?? 0) +
          (g.customization?.postCommands.length ?? 0) +
          (g.customization?.files.length ?? 0) >
        0,
    );
    if (hasCustomization) {
      warnings.push(
        'Node customization runs as root on every node of the group. Do not put secrets into inline file content (FP5-F-14).',
      );
    }

    return {
      kc,
      objects: [
        ...extra.filter((o) => o.kind === 'Namespace'),
        ...extra.filter((o) => o.kind !== 'Namespace'),
        ...objects,
      ],
      previewObjects: [
        ...extraPreview.filter((o) => o.kind === 'Namespace'),
        ...extraPreview.filter((o) => o.kind !== 'Namespace'),
        ...objects,
      ],
      warnings,
      blockers,
      credentialNamespaceMissing,
      removed,
      generated: new Set(generated.map(objectKey)),
      ...(touched ? { touched } : {}),
    };
  }

  private async dryRun(plan: Plan): Promise<void> {
    const nsMissing = plan.objects.some((o) => o.kind === 'Namespace');
    const checkable = nsMissing ? plan.objects.filter((o) => !o.metadata?.namespace) : plan.objects;
    try {
      await serverSideApply(plan.kc, checkable, { dryRun: true });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      const e = toHttpException(err, 'Validate the manifests (dry run)');
      const body = e.getResponse() as { message: string; details?: string };
      plan.blockers.push(`${body.message}${body.details ? `: ${body.details}` : ''}`);
    }
  }

  private async getCluster(
    kc: KubeConfig,
    namespace: string,
    name: string,
  ): Promise<K8sObj | undefined> {
    try {
      return (await kc
        .makeApiClient(CustomObjectsApi)
        .getNamespacedCustomObject({ ...CAPI, namespace, plural: 'clusters', name })) as K8sObj;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw toHttpException(err, 'Read cluster');
    }
  }

  private async namespaceExists(kc: KubeConfig, name: string): Promise<boolean> {
    try {
      await kc.makeApiClient(CoreV1Api).readNamespace({ name });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw toHttpException(err, 'Read namespace');
    }
  }

  private async getCustom(
    kc: KubeConfig,
    group: string,
    version: string,
    plural: string,
    namespace: string,
    name: string,
  ): Promise<K8sObject | undefined> {
    try {
      return (await kc
        .makeApiClient(CustomObjectsApi)
        .getNamespacedCustomObject({ group, version, plural, namespace, name })) as K8sObject;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw toHttpException(err, `Read ${plural}`);
    }
  }

  private async exists(
    kc: KubeConfig,
    group: string,
    version: string,
    plural: string,
    namespace: string,
    name: string,
  ) {
    try {
      await kc
        .makeApiClient(CustomObjectsApi)
        .getNamespacedCustomObject({ group, version, plural, namespace, name });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw toHttpException(err, `Read ${plural}`);
    }
  }

  private async kube<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw toHttpException(err, context);
    }
  }
}

async function listAll(
  api: CustomObjectsApi,
  plural: string,
  def: { group: string; version: string } = CAPI,
): Promise<K8sObj[]> {
  try {
    const res = (await api.listClusterCustomObject({ ...def, plural })) as { items: K8sObj[] };
    return res.items;
  } catch (err) {
    if (isNotFound(err)) return []; // CRD not installed yet
    throw err;
  }
}

interface K8sObject {
  metadata?: { managedFields?: { manager?: string; fieldsV1?: Record<string, unknown> }[] };
  spec?: unknown;
}

/** The stored preset matches the generated one (CAAPH defaults may add fields, so compare ours). */
export function presetUpToDate(current: K8sObject, desired: { spec: unknown }): boolean {
  const contains = (have: unknown, want: unknown): boolean => {
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      if (!have || typeof have !== 'object') return false;
      return Object.entries(want).every(([k, v]) =>
        contains((have as Record<string, unknown>)[k], v),
      );
    }
    return JSON.stringify(have) === JSON.stringify(want);
  };
  return contains(current.spec, desired.spec);
}

/** Nobody but the app (field manager capi-navigator) owns fields of the spec. */
export function onlyManagedByApp(current: K8sObject): boolean {
  return (current.metadata?.managedFields ?? []).every(
    (f) => f.manager === FIELD_MANAGER || !('f:spec' in (f.fieldsV1 ?? {})),
  );
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
