import { ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CoreV1Api,
  CustomObjectsApi,
  type KubeConfig,
  type KubernetesObject,
} from '@kubernetes/client-node';
import {
  buildAddonPreset,
  catalogEntry,
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
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { CredentialsService } from '../credentials/credentials.service.js';
import {
  buildCloudConf,
  buildCloudConfigResourceSetSecret,
} from '../infra-providers/openstack/cloud-config.js';
import { readStoredCloud } from '../infra-providers/openstack/clouds-yaml.js';
import { serverSideApply } from '../kube/apply.js';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { OperatorService } from '../operator/operator.service.js';
import { CLUSTER_NAME_LABEL, toStatus, toSummary, type K8sObj } from './status.js';

const CAPI = { group: 'cluster.x-k8s.io', version: 'v1beta2' };
/** Plurals and versions of referenced control plane and infrastructure kinds. */
const KINDS: Record<string, { group: string; version: string; plural: string }> = {
  RKE2ControlPlane: {
    group: 'controlplane.cluster.x-k8s.io',
    version: 'v1beta2',
    plural: 'rke2controlplanes',
  },
  KubeadmControlPlane: {
    group: 'controlplane.cluster.x-k8s.io',
    version: 'v1beta2',
    plural: 'kubeadmcontrolplanes',
  },
  OpenStackCluster: {
    group: 'infrastructure.cluster.x-k8s.io',
    version: 'v1beta2',
    plural: 'openstackclusters',
  },
  AWSCluster: {
    group: 'infrastructure.cluster.x-k8s.io',
    version: 'v1beta2',
    plural: 'awsclusters',
  },
};

interface Plan {
  kc: KubeConfig;
  objects: KubernetesObject[];
  /** Same objects for the preview, Secret values masked. */
  previewObjects: KubernetesObject[];
  warnings: string[];
  blockers: string[];
  credentialNamespaceMissing: boolean;
}

/**
 * Workload clusters (FP-5): preview, create, list and status. Manifests come from the pure
 * transformation; the backend only adds what needs I/O (namespace, presets, cloud config Secret).
 */
@Injectable()
export class ClustersService {
  constructor(
    private readonly clients: ManagementClusterClients,
    private readonly credentials: CredentialsService,
    private readonly operator: OperatorService,
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
    await this.kube(`Create cluster ${spec.name}`, () => serverSideApply(plan.kc, plan.objects));
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
      const cps = await listAll(api, KINDS.RKE2ControlPlane!.plural, KINDS.RKE2ControlPlane);
      return clusters
        .map((c) => {
          const ns = c.metadata.namespace;
          const cpName = (c.spec?.controlPlaneRef as { name?: string } | undefined)?.name;
          const cp = cps.find((x) => x.metadata.namespace === ns && x.metadata.name === cpName);
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
      const [cp, infra, mds, machines, kubeconfig] = await Promise.all([
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
        kc
          .makeApiClient(CoreV1Api)
          .readNamespacedSecret({ name: `${name}-kubeconfig`, namespace })
          .then(
            () => true,
            () => false,
          ),
      ]);
      return toStatus({
        cluster,
        infra,
        cp,
        mds: (mds as { items: K8sObj[] }).items,
        machines: (machines as { items: K8sObj[] }).items,
        kubeconfigAvailable: kubeconfig,
      });
    });
  }

  // ---- helpers ----

  private async plan(
    connection: string,
    spec: ClusterSpec,
    grantNamespace: boolean,
  ): Promise<Plan> {
    const kc = await this.clients.forConnection(connection);
    const infra = spec.infrastructure;
    const blockers: string[] = [];
    const warnings: string[] = [];

    // FP5-F-05, FP5-F-18: required providers installed and ready.
    const state = await this.operator.state(connection);
    const needed = [
      'core',
      `${spec.kubernetes.flavor}-bootstrap`,
      `${spec.kubernetes.flavor}-control-plane`,
      infra.provider,
    ];
    if (spec.addons.cloudControllerManager || spec.addons.csiDriver) needed.push('helm');
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
    const objects: KubernetesObject[] = transform(spec, {
      credential: { ...(cloudName ? { cloudName } : {}) },
    }) as KubernetesObject[];
    const extra: KubernetesObject[] = [];
    const extraPreview: KubernetesObject[] = [];

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

    // CCM/CSI presets, created on first use in the namespace (FP5-F-09, FP5-F-17).
    const clusterObj = objects.find((o) => o.kind === 'Cluster') as ManifestObject | undefined;
    for (const preset of presetsFor(clusterObj?.metadata.labels ?? {})) {
      const hcp = buildAddonPreset(preset, spec.namespace) as KubernetesObject;
      if (
        !(await this.exists(
          kc,
          'addons.cluster.x-k8s.io',
          'v1alpha1',
          'helmchartproxies',
          spec.namespace,
          hcp.metadata!.name!,
        ))
      ) {
        extra.push(hcp);
        extraPreview.push(hcp);
      }
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
