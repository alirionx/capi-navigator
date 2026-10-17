import { CustomObjectsApi, type KubeConfig } from '@kubernetes/client-node';
import {
  catalogEntryFor,
  OPERATOR_GROUP,
  OPERATOR_VERSION,
  PROVIDER_KINDS,
  PROVIDER_PLURALS,
  type InstalledProvider,
  type ProviderCatalogEntry,
  type ProviderCondition,
  type ProviderKind,
} from '@capi-navigator/shared';
import { isNotFound } from '../kube/errors.js';

/** Raw provider CR as returned by the API server (operator.cluster.x-k8s.io/v1alpha2). */
export interface ProviderObject {
  apiVersion?: string;
  kind: ProviderKind;
  metadata: { name: string; namespace: string; deletionTimestamp?: string; generation?: number };
  spec?: {
    version?: string;
    configSecret?: { name: string; namespace?: string };
    manager?: { featureGates?: Record<string, boolean> };
    fetchConfig?: { url?: string };
  };
  status?: {
    installedVersion?: string;
    observedGeneration?: number;
    conditions?: ProviderCondition[];
  };
}

/** Condition reasons of the CAPI Operator v0.29 that mean the installation failed. */
const FAILURE_REASONS = new Set([
  'MoreThanOneExists',
  'IncorrectVersionFormat',
  'IncorrectCoreProviderNameReason',
  'EmptyVersionReason',
  'FetchConfigValidationError',
  'UnknownProvider',
  'CAPIVersionIncompatibility',
  'ComponentsFetchError',
  'ComponentsCustomizationError',
  'ComponentsPatchError',
  'ComponentsImageOverrideError',
  'ComponentsUpgradeError',
  'OldComponentsDeletionError',
  'InvalidGithubTokenError',
  'UnsupportedProviderDowngradeReason',
]);

export function providerPhase(p: ProviderObject): InstalledProvider['phase'] {
  if (p.metadata.deletionTimestamp) return 'Deleting';
  const conditions = p.status?.conditions ?? [];
  if (conditions.some((c) => c.status === 'False' && c.reason && FAILURE_REASONS.has(c.reason))) {
    return 'Failed';
  }
  const ready = conditions.some((c) => c.type === 'Ready' && c.status === 'True');
  const installed = p.status?.installedVersion;
  const upToDate =
    installed === p.spec?.version &&
    (p.status?.observedGeneration === undefined ||
      p.metadata.generation === undefined ||
      p.status.observedGeneration >= p.metadata.generation);
  if (ready && upToDate) return 'Ready';
  if (installed && installed !== p.spec?.version) return 'Upgrading';
  return 'Installing';
}

export function toInstalledProvider(p: ProviderObject): InstalledProvider {
  const entry = catalogEntryFor(p.kind, p.metadata.name);
  return {
    kind: p.kind,
    name: p.metadata.name,
    namespace: p.metadata.namespace,
    ...(entry ? { catalogId: entry.id } : {}),
    ...(p.spec?.version ? { version: p.spec.version } : {}),
    ...(p.status?.installedVersion ? { installedVersion: p.status.installedVersion } : {}),
    phase: providerPhase(p),
    conditions: (p.status?.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      ...(c.reason ? { reason: c.reason } : {}),
      ...(c.message ? { message: c.message } : {}),
      ...(c.lastTransitionTime ? { lastTransitionTime: String(c.lastTransitionTime) } : {}),
    })),
    ...(p.spec?.configSecret ? { configSecret: p.spec.configSecret } : {}),
    ...(p.spec?.manager?.featureGates ? { featureGates: p.spec.manager.featureGates } : {}),
    ...(p.spec?.fetchConfig?.url ? { fetchConfigUrl: p.spec.fetchConfig.url } : {}),
  };
}

/** Lists all provider CRs of all kinds (FP3-F-08). Missing CRDs mean: no providers. */
export async function listProviders(kc: KubeConfig): Promise<ProviderObject[]> {
  const api = kc.makeApiClient(CustomObjectsApi);
  const lists = await Promise.all(
    PROVIDER_KINDS.map(async (kind) => {
      try {
        const res = (await api.listClusterCustomObject({
          group: OPERATOR_GROUP,
          version: OPERATOR_VERSION,
          plural: PROVIDER_PLURALS[kind],
        })) as { items: Omit<ProviderObject, 'kind'>[] };
        return res.items.map((i) => ({ ...i, kind }) as ProviderObject);
      } catch (err) {
        if (isNotFound(err)) return [];
        throw err;
      }
    }),
  );
  return lists
    .flat()
    .sort(
      (a, b) =>
        PROVIDER_KINDS.indexOf(a.kind) - PROVIDER_KINDS.indexOf(b.kind) ||
        a.metadata.name.localeCompare(b.metadata.name),
    );
}

/** Which Cluster references show that a workload cluster uses a provider (FP3-F-12). */
function usesProvider(entry: ProviderCatalogEntry, cluster: ClusterObject): boolean {
  const infra = cluster.spec?.infrastructureRef?.kind ?? '';
  const cp = cluster.spec?.controlPlaneRef?.kind ?? '';
  switch (entry.id) {
    case 'core':
      return true;
    case 'openstack':
      return infra.startsWith('OpenStack');
    case 'aws':
      return infra.startsWith('AWS');
    case 'rke2-bootstrap':
    case 'rke2-control-plane':
      return cp === 'RKE2ControlPlane';
    case 'kubeadm-bootstrap':
    case 'kubeadm-control-plane':
      return cp === 'KubeadmControlPlane';
    case 'k0smotron-bootstrap':
    case 'k0smotron-control-plane':
      return cp.startsWith('K0s');
    default:
      return false;
  }
}

interface ClusterObject {
  metadata: { name: string; namespace: string };
  spec?: { infrastructureRef?: { kind?: string }; controlPlaneRef?: { kind?: string } };
}

export async function clustersUsing(
  kc: KubeConfig,
  entry: ProviderCatalogEntry,
): Promise<{ name: string; namespace: string }[]> {
  const api = kc.makeApiClient(CustomObjectsApi);
  let items: ClusterObject[];
  try {
    const res = (await api.listClusterCustomObject({
      group: 'cluster.x-k8s.io',
      version: 'v1beta2',
      plural: 'clusters',
    })) as { items: ClusterObject[] };
    items = res.items;
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return items
    .filter((c) => usesProvider(entry, c))
    .map((c) => ({ name: c.metadata.name, namespace: c.metadata.namespace }));
}
