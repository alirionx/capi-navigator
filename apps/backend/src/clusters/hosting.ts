import { CoreV1Api, CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';
import {
  CLUSTER_SPEC_ANNOTATION,
  ClusterSpecSchema,
  HOSTED_ON_LABEL,
  freeAddresses,
  schedulableHostNodes,
  tenantRequests,
  type ClusterSpec,
  type HostFacts,
  type HostView,
  type TenantView,
} from '@capi-navigator/shared';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { conditions, type K8sObj } from './status.js';

/**
 * Reads between hosted control planes and their hosts (FP-24, ADR-0034). The host is reached with
 * its Cluster API kubeconfig, read-only; the app writes nothing into it (ADR-0034).
 */

const CAPI = { group: 'cluster.x-k8s.io', version: 'v1beta2', plural: 'clusters' };
const HOST_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms = HOST_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/** The stored spec of a cluster object, if the app created it and it is valid. */
export function specOf(cluster: K8sObj): ClusterSpec | undefined {
  const raw = cluster.metadata.annotations?.[CLUSTER_SPEC_ANNOTATION];
  if (!raw) return undefined;
  try {
    const parsed = ClusterSpecSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The Cluster API kubeconfig of a cluster, if CAPI created it already. */
export async function clusterKubeconfig(
  kc: KubeConfig,
  namespace: string,
  name: string,
): Promise<string | undefined> {
  try {
    const secret = await kc
      .makeApiClient(CoreV1Api)
      .readNamespacedSecret({ name: `${name}-kubeconfig`, namespace });
    const value = secret.data?.value;
    return value ? Buffer.from(value, 'base64').toString('utf8') : undefined;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw toHttpException(err, 'Read the kubeconfig Secret');
  }
}

/** FP24-F-03: what the checks of a tenant need to know about its host. */
export async function hostFacts(
  kc: KubeConfig,
  namespace: string,
  host: string,
): Promise<HostFacts | undefined> {
  let cluster: K8sObj;
  try {
    cluster = (await kc
      .makeApiClient(CustomObjectsApi)
      .getNamespacedCustomObject({ ...CAPI, namespace, name: host })) as K8sObj;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw toHttpException(err, 'Read the host cluster');
  }
  return {
    spec: specOf(cluster),
    available: conditions(cluster).some((c) => c.type === 'Available' && c.status === 'True'),
    deleting: !!(cluster.metadata as { deletionTimestamp?: string }).deletionTimestamp,
    kubeconfig: !!(await clusterKubeconfig(kc, namespace, host)),
  };
}

/** FP24-F-01, FP24-F-09: the tenants whose control planes run in a host. */
export async function tenantsOf(
  kc: KubeConfig,
  namespace: string,
  host: string,
): Promise<K8sObj[]> {
  try {
    const res = (await kc.makeApiClient(CustomObjectsApi).listNamespacedCustomObject({
      ...CAPI,
      namespace,
      labelSelector: `${HOSTED_ON_LABEL}=${host}`,
    })) as { items: K8sObj[] };
    return res.items;
  } catch (err) {
    if (isNotFound(err)) return [];
    throw toHttpException(err, 'List the tenants of the host');
  }
}

/** Core API of a host from its kubeconfig; replaced in tests. */
export const hostAccess = {
  api(kubeconfig: string): CoreV1Api {
    const kc = new KubeConfig();
    kc.loadFromString(kubeconfig);
    return kc.makeApiClient(CoreV1Api);
  },
};
const hostApi = (kubeconfig: string) => hostAccess.api(kubeconfig);

/** k0smotron's LoadBalancer Service of a tenant in the host (seen live: kmc-<name>-lb). */
const tenantServiceName = (tenant: string) => `kmc-${tenant}-lb`;

/**
 * FP24-F-06: addresses of LoadBalancer Services in the host (kube-vip), except the tenant's own,
 * so a new tenant address does not clash with them.
 */
export async function hostServiceAddresses(
  hostKubeconfig: string,
  except?: { namespace: string; tenant: string },
): Promise<string[]> {
  const res = await withTimeout(hostApi(hostKubeconfig).listServiceForAllNamespaces({}));
  return res.items
    .filter((s) => s.spec?.type === 'LoadBalancer')
    .filter(
      (s) =>
        !except ||
        s.metadata?.namespace !== except.namespace ||
        s.metadata?.name !== tenantServiceName(except.tenant),
    )
    .flatMap((s) => [
      ...(s.status?.loadBalancer?.ingress ?? []).map((i) => i.ip ?? ''),
      ...(s.metadata?.annotations?.['kube-vip.io/loadbalancerIPs']?.split(',') ?? []),
    ])
    .filter(Boolean);
}

/** Kubernetes quantities as millicores and MiB (the forms the API server reports). */
export function cpuMillis(q: string | undefined): number {
  if (!q) return 0;
  return q.endsWith('m') ? Number(q.slice(0, -1)) : Math.round(Number(q) * 1000);
}
const MEMORY_UNITS: Record<string, number> = {
  Ki: 1 / 1024,
  Mi: 1,
  Gi: 1024,
  Ti: 1024 * 1024,
  k: 1000 / 1024 / 1024,
  M: 1000_000 / 1024 / 1024,
  G: 1000_000_000 / 1024 / 1024,
};
export function memoryMiB(q: string | undefined): number {
  if (!q) return 0;
  const m = /^(\d+(?:\.\d+)?)([KMGT]i|[kMG])?$/.exec(q);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2] ? MEMORY_UNITS[m[2]]! : 1 / 1024 / 1024));
}

/** FP24-F-11, FP24-F-12: a host's tenants, their requests and the host's capacity. */
export async function readHostView(kc: KubeConfig, host: ClusterSpec): Promise<HostView> {
  const warnings: string[] = [];
  const tenantClusters = await tenantsOf(kc, host.namespace, host.name);
  const tenants = tenantClusters.map((c) => {
    const replicas = specOf(c)?.topology.controlPlane.replicas ?? 1;
    return {
      namespace: host.namespace,
      name: c.metadata.name,
      replicas,
      ...tenantRequests(replicas),
    };
  });
  const view: HostView = { tenants, schedulableNodes: schedulableHostNodes(host), warnings };
  const kubeconfig = await clusterKubeconfig(kc, host.namespace, host.name);
  if (!kubeconfig) {
    warnings.push('The host has no kubeconfig yet: its capacity is not known.');
    return view;
  }
  try {
    const nodes = (await withTimeout(hostApi(kubeconfig).listNode({}))).items.filter(
      (n) =>
        !n.spec?.unschedulable &&
        !(n.spec?.taints ?? []).some((t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute'),
    );
    view.allocatable = {
      cpuMillis: nodes.reduce((s, n) => s + cpuMillis(n.status?.allocatable?.cpu), 0),
      memoryMiB: nodes.reduce((s, n) => s + memoryMiB(n.status?.allocatable?.memory), 0),
    };
    if (host.infrastructure.provider === 'proxmox') {
      const used = [
        ...(await hostServiceAddresses(kubeconfig)),
        // Tenants that are not up yet have no Service, but their address is taken.
        ...tenantClusters.flatMap((c) => {
          const s = specOf(c);
          return s?.infrastructure.provider === 'proxmox' ? [s.infrastructure.apiEndpoint] : [];
        }),
      ];
      view.freeAddresses = freeAddresses(
        host.infrastructure.network.loadBalancerAddresses ?? [],
        used,
        5,
      );
    }
  } catch (err) {
    warnings.push(
      `The host cluster does not answer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return view;
}

/** FP24-F-11: where a tenant's control plane runs in its host. */
export async function readTenantView(kc: KubeConfig, tenant: ClusterSpec): Promise<TenantView> {
  const host = tenant.topology.hosted!.host;
  const ns = tenant.namespace;
  const view: TenantView = {
    host: { namespace: ns, name: host },
    pods: [],
    volumes: [],
    warnings: [],
  };
  const kubeconfig = await clusterKubeconfig(kc, ns, host);
  if (!kubeconfig) {
    view.warnings.push(`The host cluster ${ns}/${host} has no kubeconfig.`);
    return view;
  }
  try {
    const api = hostApi(kubeconfig);
    const selector = `app=k0smotron,cluster=${tenant.name}`;
    const [pods, pvcs] = await withTimeout(
      Promise.all([
        api.listNamespacedPod({ namespace: ns, labelSelector: selector }),
        api.listNamespacedPersistentVolumeClaim({ namespace: ns }),
      ]),
    );
    view.pods = pods.items
      .map((p) => ({
        name: p.metadata?.name ?? '',
        component: (p.metadata?.labels?.component === 'etcd' ? 'etcd' : 'controller') as
          'etcd' | 'controller',
        ...(p.spec?.nodeName ? { node: p.spec.nodeName } : {}),
        phase: p.status?.phase ?? 'Unknown',
        ready: (p.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // k0smotron's etcd StatefulSet volumes (etcd-data-kmc-<name>-etcd-<n>).
    view.volumes = pvcs.items
      .filter((v) => v.metadata?.name?.startsWith(`etcd-data-kmc-${tenant.name}-etcd-`))
      .map((v) => ({
        name: v.metadata!.name!,
        ...(v.status?.capacity?.storage ? { size: v.status.capacity.storage } : {}),
        phase: v.status?.phase ?? 'Unknown',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    try {
      const svc = await withTimeout(
        api.readNamespacedService({ namespace: ns, name: tenantServiceName(tenant.name) }),
      );
      const ingress = svc.status?.loadBalancer?.ingress?.[0];
      view.service = {
        name: svc.metadata?.name ?? '',
        ...(ingress?.ip || ingress?.hostname ? { address: ingress.ip ?? ingress.hostname } : {}),
        ports: (svc.spec?.ports ?? []).map((p) => p.port),
      };
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  } catch (err) {
    view.warnings.push(
      `The host cluster ${ns}/${host} does not answer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return view;
}
