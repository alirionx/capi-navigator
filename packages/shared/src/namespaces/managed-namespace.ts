import { z } from 'zod';
import type { AddonStatus } from '../helm/addon-status.js';
import { LabelsSchema, type ClusterSpec } from '../cluster/spec.js';
import { FLAVOR_PLUGINS } from '../cluster/transform.js';
import { shortHash, stableStringify } from '../cluster/util.js';
import {
  ADDON_TYPE_LABEL,
  buildManifestHelmChartProxy,
  manifestValuesTemplate,
  type ManifestChartSource,
} from '../helm/manifest-addon.js';
import { NamespacePersonSchema, personKey, type NamespacePerson } from './people.js';
import {
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  renderManifests,
  type ManifestObject,
} from '../operator-manifests.js';

/**
 * Managed namespaces of workload clusters (FP-36, ADR-0039): one HelmChartProxy of the generic
 * chart per namespace, generated from a form model that is kept as annotation on it.
 */

/**
 * Release namespace and home of all service accounts; teams have no rights there (FP36-F-07). Not
 * `capi-navigator-access`, which holds the app's own account on management clusters.
 */
export const ACCOUNTS_NAMESPACE = 'capi-navigator-accounts';
/** Form model on the HelmChartProxy (FP36-F-01). */
export const MANAGED_NAMESPACE_ANNOTATION = 'capi-navigator.io/managed-namespace';
/**
 * Assigned people per account (FP37-F-02). An annotation of its own, so everything that shows the
 * HelmChartProxy to readers can leave it out (ADR-0041).
 */
export const NAMESPACE_PEOPLE_ANNOTATION = 'capi-navigator.io/managed-namespace-people';
/** Value of {@link ADDON_TYPE_LABEL}. */
export const NAMESPACE_ADDON_TYPE = 'namespace';
/** On every object of a managed namespace: the namespace it belongs to. */
export const MANAGED_NAMESPACE_LABEL = 'capi-navigator.io/namespace';
/** Role of a service account, shown without reading the role bindings. */
export const ACCOUNT_ROLE_ANNOTATION = 'capi-navigator.io/role';
const KEEP = { 'helm.sh/resource-policy': 'keep' };
const OBJECT_NAME = 'capi-navigator';
const CLUSTER_NAME_LABEL = 'cluster.x-k8s.io/cluster-name';
const MAX_CLUSTER_SELECTOR = 10;

/** FP36-F-13: never managed by the app. Existing namespaces are refused in addition. */
export const isReservedNamespace = (name: string) =>
  name === 'default' || /^(kube|capi-navigator|calico|tigera)-/.test(name);

const DNS_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const NamespaceName = z
  .string()
  .min(1, 'Required')
  .max(40, 'At most 40 characters')
  .regex(DNS_LABEL, 'Lowercase letters, digits and "-"; must start with a letter')
  .refine((n) => !isReservedNamespace(n), 'This name is reserved');

/** Sums per namespace (ResourceQuota). */
export const NamespaceQuotaSchema = z
  .object({
    cpuRequests: z.number().min(0.1).max(1000),
    cpuLimits: z.number().min(0.1).max(1000),
    memoryRequestsGiB: z.int().min(1).max(4096),
    memoryLimitsGiB: z.int().min(1).max(4096),
    pods: z.int().min(1).max(1000),
    volumes: z.int().min(0).max(500),
    storageGiB: z.int().min(0).max(100_000),
    loadBalancers: z.int().min(0).max(50),
  })
  .superRefine((q, ctx) => {
    for (const [requests, limits] of [
      ['cpuRequests', 'cpuLimits'],
      ['memoryRequestsGiB', 'memoryLimitsGiB'],
    ] as const) {
      if (q[limits] < q[requests]) {
        ctx.addIssue({ code: 'custom', path: [limits], message: 'At least the requests' });
      }
    }
  });
export type NamespaceQuota = z.infer<typeof NamespaceQuotaSchema>;

/** Resource names of the quota values in the ResourceQuota. */
export const NAMESPACE_QUOTA_RESOURCES: Record<keyof NamespaceQuota, string> = {
  cpuRequests: 'requests.cpu',
  cpuLimits: 'limits.cpu',
  memoryRequestsGiB: 'requests.memory',
  memoryLimitsGiB: 'limits.memory',
  pods: 'pods',
  loadBalancers: 'services.loadbalancers',
  volumes: 'persistentvolumeclaims',
  storageGiB: 'requests.storage',
};

export const NAMESPACE_PROFILES = ['small', 'medium', 'large'] as const;
export type NamespaceProfile = (typeof NAMESPACE_PROFILES)[number];

const profile = (factor: 1 | 2 | 4, pods: number, loadBalancers: number): NamespaceQuota => ({
  cpuRequests: 2 * factor,
  cpuLimits: 4 * factor,
  memoryRequestsGiB: 4 * factor,
  memoryLimitsGiB: 8 * factor,
  pods,
  volumes: 5 * factor,
  storageGiB: { 1: 20, 2: 50, 4: 100 }[factor],
  loadBalancers,
});
/** FP36-F-02: presets, adjustable per namespace. */
export const NAMESPACE_PROFILE_QUOTAS: Record<NamespaceProfile, NamespaceQuota> = {
  small: profile(1, 20, 1),
  medium: profile(2, 50, 2),
  large: profile(4, 100, 4),
};
/** Defaults per container (LimitRange), the same in every profile. */
export const NAMESPACE_CONTAINER_DEFAULTS = {
  requests: { cpu: '100m', memory: '128Mi' },
  limits: { cpu: '500m', memory: '512Mi' },
} as const;

/** FP36-F-07: built-in ClusterRoles; `admin` could create tokens that never expire. */
export const NAMESPACE_ROLES = ['view', 'edit'] as const;
export type NamespaceRole = (typeof NAMESPACE_ROLES)[number];

export const NamespaceAccountSchema = z.object({
  name: z
    .string()
    .min(1, 'Required')
    .max(30, 'At most 30 characters')
    .regex(DNS_LABEL, 'Lowercase letters, digits and "-"; must start with a letter'),
  role: z.enum(NAMESPACE_ROLES).default('view'),
  /** People who issue tokens for this account themselves (FP37-F-02); not part of the manifests. */
  people: z.array(NamespacePersonSchema).max(50, 'At most 50 people').default([]),
});
export type NamespaceAccount = z.infer<typeof NamespaceAccountSchema>;

export const ManagedNamespaceSpecSchema = z
  .object({
    /** Namespace in the workload cluster. */
    name: NamespaceName,
    /** Namespace of the clusters and the HelmChartProxy in the management cluster. */
    namespace: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
    clusterSelector: LabelsSchema.refine(
      (l) => Object.keys(l).length > 0 && Object.keys(l).length <= MAX_CLUSTER_SELECTOR,
      'One to ten labels; an empty selector would select every cluster in the namespace',
    ),
    /** Where the quota values came from; only for display. */
    profile: z.enum(NAMESPACE_PROFILES).default('small'),
    quota: NamespaceQuotaSchema,
    /** Further namespaces whose pods may reach this one, e.g. of an ingress controller. */
    allowFrom: z
      .array(
        z
          .string()
          .max(63)
          .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'A namespace name'),
      )
      .max(20)
      .default([]),
    accounts: z.array(NamespaceAccountSchema).max(20).default([]),
    /** Raised to apply the objects again (FP36-F-06). */
    revision: z.int().min(1).default(1),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.accounts.forEach((a, i) => {
      if (seen.has(a.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['accounts', i, 'name'],
          message: `Account "${a.name}" is listed twice`,
        });
      }
      seen.add(a.name);
      if (new Set(a.people.map(personKey)).size !== a.people.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['accounts', i, 'people'],
          message: 'The same person or group is listed twice',
        });
      }
    });
  });
export type ManagedNamespaceSpec = z.infer<typeof ManagedNamespaceSpecSchema>;
export type ManagedNamespaceSpecInput = z.input<typeof ManagedNamespaceSpecSchema>;

/** Selector of exactly one cluster, the preset of the form. */
export const singleClusterSelector = (cluster: string) => ({ [CLUSTER_NAME_LABEL]: cluster });

/** With a dot, because two pairs could share a name with a hyphen (FP36-F-07). */
export const namespaceAccountName = (namespace: string, account: string) =>
  `${namespace}.${account}`;
const RELEASE_PREFIX = 'ns-';
export const namespaceReleaseName = (name: string) => `${RELEASE_PREFIX}${name}`;

/** A managed namespace on one cluster, for the overview of the home page (UX-17). */
export interface ClusterNamespace {
  name: string;
  /** The release on this cluster is installed. */
  ready: boolean;
}

/** Pure: managed namespaces per cluster ("namespace/name") from the add-on overview (UX-17). */
export function namespacesByCluster(
  addons: readonly Pick<
    AddonStatus,
    'type' | 'namespace' | 'releaseName' | 'matchingClusters' | 'releases'
  >[],
): Map<string, ClusterNamespace[]> {
  const result = new Map<string, ClusterNamespace[]>();
  for (const a of addons) {
    if (a.type !== NAMESPACE_ADDON_TYPE || !a.releaseName?.startsWith(RELEASE_PREFIX)) continue;
    const name = a.releaseName.slice(RELEASE_PREFIX.length);
    for (const cluster of a.matchingClusters) {
      const key = `${a.namespace}/${cluster}`;
      const ready = a.releases.some((r) => r.cluster === cluster && r.ready);
      result.set(
        key,
        [...(result.get(key) ?? []), { name, ready }].sort((x, y) => x.name.localeCompare(y.name)),
      );
    }
  }
  return result;
}
/** The selector is part of the name: the same namespace can be defined for several clusters. */
export const namespaceAddonName = (spec: Pick<ManagedNamespaceSpec, 'name' | 'clusterSelector'>) =>
  `ns-${spec.name}-${shortHash(spec.clusterSelector).slice(0, 8)}`;

/** FP36-F-03a: why a cluster cannot have managed namespaces, if so. */
export function namespacesUnsupported(
  kubernetes: Pick<ClusterSpec['kubernetes'], 'flavor'>,
): string | undefined {
  const plugin = FLAVOR_PLUGINS[kubernetes.flavor];
  if (plugin?.cni === 'calico') return undefined;
  return `The network isolation needs Calico; ${plugin?.displayName ?? kubernetes.flavor} uses ${plugin?.cni ?? 'an unknown CNI'}`;
}

/** Pure: the objects in the workload cluster (FP36-F-02, F-03, F-04, F-07). */
export function managedNamespaceObjects(spec: ManagedNamespaceSpec): ManifestObject[] {
  const { name, quota } = spec;
  const labels = { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [MANAGED_NAMESPACE_LABEL]: name };
  const kept = (objectName: string, namespace?: string) => ({
    name: objectName,
    ...(namespace ? { namespace } : {}),
    labels,
    annotations: KEEP,
  });
  const tier = `${OBJECT_NAME}-${name}`;
  const sources = [...new Set([name, ...spec.allowFrom])].sort();
  return [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        ...kept(name),
        labels: {
          ...labels,
          'pod-security.kubernetes.io/audit': 'restricted',
          'pod-security.kubernetes.io/enforce': 'baseline',
          'pod-security.kubernetes.io/warn': 'restricted',
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: kept(OBJECT_NAME, name),
      spec: {
        hard: {
          [NAMESPACE_QUOTA_RESOURCES.cpuLimits]: cpu(quota.cpuLimits),
          [NAMESPACE_QUOTA_RESOURCES.memoryLimitsGiB]: `${quota.memoryLimitsGiB}Gi`,
          [NAMESPACE_QUOTA_RESOURCES.volumes]: String(quota.volumes),
          [NAMESPACE_QUOTA_RESOURCES.pods]: String(quota.pods),
          [NAMESPACE_QUOTA_RESOURCES.cpuRequests]: cpu(quota.cpuRequests),
          [NAMESPACE_QUOTA_RESOURCES.memoryRequestsGiB]: `${quota.memoryRequestsGiB}Gi`,
          [NAMESPACE_QUOTA_RESOURCES.storageGiB]: `${quota.storageGiB}Gi`,
          [NAMESPACE_QUOTA_RESOURCES.loadBalancers]: String(quota.loadBalancers),
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'LimitRange',
      metadata: kept(OBJECT_NAME, name),
      spec: {
        limits: [
          {
            type: 'Container',
            default: { ...NAMESPACE_CONTAINER_DEFAULTS.limits },
            defaultRequest: { ...NAMESPACE_CONTAINER_DEFAULTS.requests },
          },
        ],
      },
    },
    {
      apiVersion: 'crd.projectcalico.org/v1',
      kind: 'Tier',
      metadata: kept(tier),
      spec: { order: 500, defaultAction: 'Pass' },
    },
    {
      apiVersion: 'crd.projectcalico.org/v1',
      kind: 'NetworkPolicy',
      // Calico expects the tier as prefix of the name.
      metadata: kept(`${tier}.isolation`, name),
      spec: {
        tier,
        order: 100,
        selector: 'all()',
        types: ['Ingress'],
        // Only pods belong to a namespace here: traffic from outside, also forwarded by another
        // node with its tunnel address, passes on to the standard NetworkPolicies of the team.
        ingress: [
          {
            action: 'Pass',
            source: {
              namespaceSelector: `projectcalico.org/name in {${sources.map((n) => `'${n}'`).join(', ')}}`,
            },
          },
          { action: 'Deny', source: { namespaceSelector: 'all()' } },
          { action: 'Pass' },
        ],
      },
    },
    ...spec.accounts.flatMap((a): ManifestObject[] => {
      const account = namespaceAccountName(name, a.name);
      const annotations = { [ACCOUNT_ROLE_ANNOTATION]: a.role };
      return [
        {
          apiVersion: 'v1',
          kind: 'ServiceAccount',
          metadata: { name: account, namespace: ACCOUNTS_NAMESPACE, labels, annotations },
          automountServiceAccountToken: false,
        } as ManifestObject,
        {
          apiVersion: 'rbac.authorization.k8s.io/v1',
          kind: 'RoleBinding',
          // The role is part of the name: the roleRef of a binding cannot be changed.
          metadata: { name: `${OBJECT_NAME}-${a.name}-${a.role}`, namespace: name, labels },
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: a.role },
          subjects: [{ kind: 'ServiceAccount', name: account, namespace: ACCOUNTS_NAMESPACE }],
        } as ManifestObject,
      ];
    }),
  ];
}

/** As the API server writes it back, so the drift check sees no difference. */
const cpu = (cores: number) =>
  Number.isInteger(cores) ? String(cores) : `${Math.round(cores * 1000)}m`;

/** Pure: the HelmChartProxy of a managed namespace (FP36-F-01). */
export function buildNamespaceHelmChartProxy(
  spec: ManagedNamespaceSpec,
  source: ManifestChartSource,
): ManifestObject {
  // The comment makes every revision a change of the values, which triggers the Helm upgrade.
  const manifests = `# Managed namespace ${spec.name}, revision ${spec.revision}\n${renderManifests(managedNamespaceObjects(spec))}`;
  const hcp = buildManifestHelmChartProxy(
    {
      name: namespaceAddonName(spec),
      namespace: spec.namespace,
      manifests,
      releaseNamespace: ACCOUNTS_NAMESPACE,
      clusterSelector: spec.clusterSelector,
      reconcileStrategy: 'Continuous',
      options: { wait: true, timeout: '5m0s', createNamespace: true },
    },
    source,
  );
  const people = Object.fromEntries(
    spec.accounts.filter((a) => a.people.length).map((a) => [a.name, a.people]),
  );
  return {
    ...hcp,
    metadata: {
      ...hcp.metadata,
      labels: {
        ...hcp.metadata.labels,
        [ADDON_TYPE_LABEL]: NAMESPACE_ADDON_TYPE,
        [MANAGED_NAMESPACE_LABEL]: spec.name,
      },
      annotations: {
        ...hcp.metadata.annotations,
        [MANAGED_NAMESPACE_ANNOTATION]: stableStringify(formModel(spec)),
        ...(Object.keys(people).length
          ? { [NAMESPACE_PEOPLE_ANNOTATION]: stableStringify(people) }
          : {}),
      },
    },
    spec: {
      ...(hcp.spec as Record<string, unknown>),
      releaseName: namespaceReleaseName(spec.name),
      valuesTemplate: manifestValuesTemplate(manifests),
    },
  };
}

/** The form model without the people, as it is shown to everybody who may read (ADR-0041). */
const formModel = (spec: ManagedNamespaceSpec) => ({
  ...spec,
  accounts: spec.accounts.map(({ name, role }) => ({ name, role })),
});

/** The spec without the assigned people, for readers without `clusters.access`. */
export const withoutPeople = (spec: ManagedNamespaceSpec): ManagedNamespaceSpec => ({
  ...spec,
  accounts: spec.accounts.map((a) => ({ ...a, people: [] })),
});

/**
 * Pure: revision of a changed spec. Every change of the objects is a new one, so CAAPH upgrades the
 * release (FP36-F-06); people are not part of the objects and keep it (FP37-F-02).
 */
export function nextRevision(
  next: ManagedNamespaceSpecInput,
  current: ManagedNamespaceSpec | undefined,
): number {
  if (!current) return 1;
  const same = ManagedNamespaceSpecSchema.safeParse({ ...next, revision: current.revision });
  const unchanged =
    same.success &&
    stableStringify(withoutPeople(same.data)) === stableStringify(withoutPeople(current));
  return current.revision + (unchanged ? 0 : 1);
}

interface HcpLike {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
}

export const isNamespaceAddon = (hcp: HcpLike) =>
  hcp.metadata.labels?.[ADDON_TYPE_LABEL] === NAMESPACE_ADDON_TYPE;

/** Pure: the form model from a HelmChartProxy, or undefined if it was not written by the app. */
export function managedNamespaceFromHelmChartProxy(hcp: HcpLike): ManagedNamespaceSpec | undefined {
  const raw = hcp.metadata.annotations?.[MANAGED_NAMESPACE_ANNOTATION];
  if (!isNamespaceAddon(hcp) || !raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = ManagedNamespaceSpecSchema.safeParse(value);
  // The annotation must describe this object, not one copied from elsewhere.
  if (
    !parsed.success ||
    parsed.data.namespace !== hcp.metadata.namespace ||
    namespaceAddonName(parsed.data) !== hcp.metadata.name
  ) {
    return undefined;
  }
  const people = assignedPeople(hcp.metadata.annotations?.[NAMESPACE_PEOPLE_ANNOTATION]);
  return {
    ...parsed.data,
    accounts: parsed.data.accounts.map((a) => ({ ...a, people: people.get(a.name) ?? [] })),
  };
}

const PeopleAnnotationSchema = z.record(z.string(), z.array(NamespacePersonSchema));

/** Fails closed: an annotation that cannot be read assigns nobody. */
function assignedPeople(raw: string | undefined): Map<string, NamespacePerson[]> {
  try {
    const parsed = PeopleAnnotationSchema.safeParse(JSON.parse(raw ?? '{}'));
    return new Map(parsed.success ? Object.entries(parsed.data) : []);
  } catch {
    return new Map();
  }
}

/** Paths of generated fields that differ from the live object (FP36-F-06). */
export function changedFields(expected: unknown, live: unknown, path = ''): string[] {
  if (Array.isArray(expected)) {
    return stableStringify(expected) === stableStringify(live) ? [] : [path];
  }
  if (expected && typeof expected === 'object') {
    const l = (live ?? {}) as Record<string, unknown>;
    return Object.entries(expected).flatMap(([k, v]) =>
      changedFields(v, l[k], path ? `${path}.${k}` : k),
    );
  }
  return expected === live ? [] : [path];
}
