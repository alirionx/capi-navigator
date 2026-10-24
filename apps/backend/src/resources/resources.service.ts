import {
  BadRequestException,
  Injectable,
  NotFoundException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  KubernetesObjectApi,
  type KubernetesObject,
  type V1APIResource,
} from '@kubernetes/client-node';
import {
  groupVersion,
  FLAVOR_PLUGINS,
  INFRA_PLUGINS,
  isViewable,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  type ClusterResourceList,
  type ResourceRef,
  type ResourceYaml,
} from '@capi-navigator/shared';
import { stringify } from 'yaml';
import { ClustersService } from '../clusters/clusters.service.js';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { LiveChannels, type LiveEvent } from '../kube/live-channels.js';
import type { Observable } from 'rxjs';

const CLUSTER_NAME_LABEL = 'cluster.x-k8s.io/cluster-name';
const HIDDEN = '<hidden>';

/** Removes managed fields (unless asked) and every Secret value (FP7-F-03, FP7-F-04). */
export function sanitize(
  obj: KubernetesObject & Record<string, unknown>,
  showManagedFields: boolean,
): { obj: Record<string, unknown>; masked: boolean } {
  const out: Record<string, unknown> = { ...obj };
  const metadata: Record<string, unknown> = { ...(obj.metadata ?? {}) };
  if (!showManagedFields) delete metadata.managedFields;
  let masked = false;
  if (obj.kind === 'Secret') {
    for (const key of ['data', 'stringData']) {
      const values = out[key] as Record<string, string> | undefined;
      if (values) {
        out[key] = Object.fromEntries(Object.keys(values).map((k) => [k, HIDDEN]));
        masked = true;
      }
    }
    // kubectl keeps the whole Secret (with values) in this annotation.
    const annotations = { ...((metadata.annotations as Record<string, string>) ?? {}) };
    if ('kubectl.kubernetes.io/last-applied-configuration' in annotations) {
      annotations['kubectl.kubernetes.io/last-applied-configuration'] = HIDDEN;
      metadata.annotations = annotations;
      masked = true;
    }
  }
  out.metadata = metadata;
  return { obj: out, masked };
}

interface Resolved {
  kc: KubeConfig;
  path: string;
  name: string;
}

/**
 * Read-only YAML of any object the app shows (FP7-F-01 to F-05), live via a watch on exactly
 * that object. Limited to the app's API groups (management cluster) and the dashboard kinds
 * (workload clusters); Secret values never leave the backend.
 */
@Injectable()
export class ResourcesService implements OnApplicationShutdown {
  private readonly resolved = new Map<string, Resolved>();
  private readonly live: LiveChannels<ResourceYaml>;

  constructor(
    private readonly clients: ManagementClusterClients,
    private readonly clusters: ClustersService,
  ) {
    this.live = new LiveChannels('resource-yaml', {
      kubeConfig: async (key) => this.resolved.get(key)!.kc,
      paths: (key) => {
        const r = this.resolved.get(key)!;
        return [{ path: r.path, query: { fieldSelector: `metadata.name=${r.name}` } }];
      },
      compute: (key) => {
        const { connection, ref, managedFields } = JSON.parse(key) as StreamKey;
        return this.yaml(connection, ref, managedFields);
      },
    });
  }

  onApplicationShutdown(): void {
    this.live.stopAll();
  }

  async yaml(connection: string, ref: ResourceRef, managedFields: boolean): Promise<ResourceYaml> {
    this.check(ref);
    const kc = await this.kubeConfig(connection, ref);
    let obj: KubernetesObject;
    try {
      obj = await KubernetesObjectApi.makeApiClient(kc).read({
        apiVersion: ref.apiVersion,
        kind: ref.kind,
        metadata: { name: ref.name, ...(ref.namespace ? { namespace: ref.namespace } : {}) },
      });
    } catch (err) {
      if (isNotFound(err)) {
        throw new NotFoundException(
          `${ref.kind} ${ref.namespace ? `${ref.namespace}/` : ''}${ref.name} not found`,
        );
      }
      throw toHttpException(err, `Read ${ref.kind} ${ref.name}`);
    }
    const { obj: clean, masked } = sanitize(
      obj as KubernetesObject & Record<string, unknown>,
      managedFields,
    );
    return { yaml: stringify(clean, { lineWidth: 0 }), masked };
  }

  async stream(
    connection: string,
    ref: ResourceRef,
    managedFields: boolean,
  ): Promise<Observable<LiveEvent<ResourceYaml>>> {
    this.check(ref);
    const key = JSON.stringify({ connection, ref, managedFields } satisfies StreamKey);
    if (!this.resolved.has(key)) {
      const kc = await this.kubeConfig(connection, ref);
      const resource = await this.apiResource(kc, ref);
      const base = ref.apiVersion.includes('/')
        ? `/apis/${ref.apiVersion}`
        : `/api/${ref.apiVersion}`;
      const path =
        resource.namespaced && ref.namespace
          ? `${base}/namespaces/${ref.namespace}/${resource.name}`
          : `${base}/${resource.name}`;
      this.resolved.set(key, { kc, path, name: ref.name });
    }
    return this.live.stream(key);
  }

  /** Everything the app created or CAPI derived for a cluster, for the resources tab. */
  async clusterResources(
    connection: string,
    namespace: string,
    name: string,
  ): Promise<ClusterResourceList> {
    const kc = await this.clients.forConnection(connection);
    const custom = kc.makeApiClient(CustomObjectsApi);
    const kinds: {
      group: string;
      version: string;
      plural: string;
      kind: string;
      selector?: string;
    }[] = [
      {
        group: 'cluster.x-k8s.io',
        version: 'v1beta2',
        plural: 'machinedeployments',
        kind: 'MachineDeployment',
      },
      { group: 'cluster.x-k8s.io', version: 'v1beta2', plural: 'machinesets', kind: 'MachineSet' },
      { group: 'cluster.x-k8s.io', version: 'v1beta2', plural: 'machines', kind: 'Machine' },
      ...Object.values(FLAVOR_PLUGINS).flatMap((p) =>
        p
          ? [
              { ...p.controlPlaneResource },
              {
                group: p.bootstrapResources.group,
                version: p.bootstrapResources.version,
                plural: p.bootstrapResources.templatePlural,
                kind: p.bootstrapResources.templateKind,
              },
              {
                group: p.bootstrapResources.group,
                version: p.bootstrapResources.version,
                plural: p.bootstrapResources.configPlural,
                kind: p.bootstrapResources.configKind,
              },
            ]
          : [],
      ),
      ...Object.values(INFRA_PLUGINS).flatMap((p) => [
        {
          ...groupVersion(p.apiVersion),
          plural: p.resources.infraClusterPlural,
          kind: p.infraClusterKind,
        },
        {
          ...groupVersion(p.apiVersion),
          plural: p.resources.machineTemplatePlural,
          kind: p.machineTemplateKind,
        },
        {
          ...groupVersion(p.apiVersion),
          plural: p.resources.machinePlural,
          kind: p.resources.machineKind,
        },
      ]),
      {
        group: 'addons.cluster.x-k8s.io',
        version: 'v1beta2',
        plural: 'clusterresourcesets',
        kind: 'ClusterResourceSet',
      },
      {
        group: 'addons.cluster.x-k8s.io',
        version: 'v1alpha1',
        plural: 'helmreleaseproxies',
        kind: 'HelmReleaseProxy',
      },
      // CCM/CSI presets of the namespace (selected by labels, not owned by one cluster).
      {
        group: 'addons.cluster.x-k8s.io',
        version: 'v1alpha1',
        plural: 'helmchartproxies',
        kind: 'HelmChartProxy',
        selector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
      },
    ];
    const selector = `${CLUSTER_NAME_LABEL}=${name}`;
    const out: ClusterResourceList = [
      { apiVersion: 'cluster.x-k8s.io/v1beta2', kind: 'Cluster', namespace, name },
    ];
    await Promise.all(
      kinds.map(async (k) => {
        try {
          const res = (await custom.listNamespacedCustomObject({
            group: k.group,
            version: k.version,
            plural: k.plural,
            namespace,
            labelSelector: k.selector ?? selector,
          })) as { items: { metadata: { name: string } }[] };
          for (const i of res.items) {
            out.push({
              apiVersion: `${k.group}/${k.version}`,
              kind: k.kind,
              namespace,
              name: i.metadata.name,
            });
          }
        } catch {
          // CRD not installed (e.g. other providers): nothing to list
        }
      }),
    );
    const secrets = await kc
      .makeApiClient(CoreV1Api)
      .listNamespacedSecret({ namespace, labelSelector: selector })
      .catch(() => ({ items: [] }));
    for (const s of secrets.items) {
      out.push({ apiVersion: 'v1', kind: 'Secret', namespace, name: s.metadata!.name! });
    }
    const order = new Map(kinds.map((k, i) => [k.kind, i + 1]));
    return out.sort(
      (a, b) =>
        (order.get(a.kind) ?? (a.kind === 'Cluster' ? 0 : 99)) -
          (order.get(b.kind) ?? (b.kind === 'Cluster' ? 0 : 99)) || a.name.localeCompare(b.name),
    );
  }

  private check(ref: ResourceRef): void {
    if (!isViewable(ref)) {
      throw new BadRequestException({
        message: `${ref.kind} (${ref.apiVersion}) cannot be shown`,
        hint: 'The YAML view covers the resources CAPI Navigator works with.',
      });
    }
  }

  private async kubeConfig(connection: string, ref: ResourceRef): Promise<KubeConfig> {
    if (!ref.cluster) return this.clients.forConnection(connection);
    const kc = new KubeConfig();
    kc.loadFromString(
      await this.clusters.kubeconfig(connection, ref.cluster.namespace, ref.cluster.name),
    );
    return kc;
  }

  private async apiResource(kc: KubeConfig, ref: ResourceRef): Promise<V1APIResource> {
    const api = KubernetesObjectApi.makeApiClient(kc) as unknown as {
      resource(apiVersion: string, kind: string): Promise<V1APIResource | undefined>;
    };
    const resource = await api.resource(ref.apiVersion, ref.kind).catch(() => undefined);
    if (!resource) throw new NotFoundException(`Unknown kind ${ref.kind} in ${ref.apiVersion}`);
    return resource;
  }
}

interface StreamKey {
  connection: string;
  ref: ResourceRef;
  managedFields: boolean;
}
