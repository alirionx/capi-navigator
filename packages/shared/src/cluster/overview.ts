import type { ProviderKind } from '../catalog/providers.js';
import type { ClusterSummary } from './api.js';

/** Labels that make CAAPH roll out add-ons to a cluster (FP5-F-09; FP-8 adds user charts). */
const ADDON_LABELS = ['capi-navigator.io/ccm', 'capi-navigator.io/csi'];

/**
 * Clusters that use an installed provider (FP6-F-08, US-10), by provider name as the CAPI
 * Operator knows it: core serves all clusters, bootstrap and control plane providers the clusters
 * of their distribution, infrastructure providers the clusters on their cloud, the Helm add-on
 * provider the clusters selected by add-on labels.
 */
export function clustersUsing(
  provider: { kind: ProviderKind; name: string },
  clusters: ClusterSummary[],
): ClusterSummary[] {
  switch (provider.kind) {
    case 'CoreProvider':
      return clusters;
    case 'BootstrapProvider':
    case 'ControlPlaneProvider':
      return clusters.filter((c) => c.flavor === provider.name);
    case 'InfrastructureProvider':
      return clusters.filter((c) => c.provider === provider.name);
    case 'AddonProvider':
      return clusters.filter((c) => ADDON_LABELS.some((l) => l in c.labels));
    default:
      return [];
  }
}
