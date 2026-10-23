import { PROVIDER_CATALOG, type ProviderKind } from '../catalog/providers.js';
import type { ClusterSummary, InfraSummary } from './api.js';
import type { ClusterSpec, MachineGroup } from './spec.js';
import { INFRA_PLUGINS } from './transform.js';

/** Labels that make CAAPH roll out add-ons to a cluster (FP5-F-09; FP-8 adds user charts). */
const ADDON_LABELS = [
  'capi-navigator.io/ccm',
  'capi-navigator.io/csi',
  'capi-navigator.io/reboot',
  'capi-navigator.io/cni',
];

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
    case 'IPAMProvider': {
      // Used by the clusters of the infrastructure providers that depend on it.
      const id = PROVIDER_CATALOG.find(
        (p) => p.kind === 'IPAMProvider' && p.name === provider.name,
      )?.id;
      const infra = PROVIDER_CATALOG.filter(
        (p) => p.kind === 'InfrastructureProvider' && !!id && p.dependsOn.includes(id),
      ).map((p) => p.name);
      return clusters.filter((c) => !!c.provider && infra.includes(c.provider));
    }
    default:
      return [];
  }
}

/**
 * Infrastructure card of the detail view (FP6-F-02): facts and machine groups with their effective
 * size, image and root disk, computed with the same plugin functions as the transformation.
 * Image names are added by the backend.
 */
export function infraSummary(spec: ClusterSpec): InfraSummary {
  const plugin = INFRA_PLUGINS[spec.infrastructure.provider];
  const group = (
    name: string,
    role: 'control-plane' | 'worker',
    replicas: number,
    g: MachineGroup,
  ): InfraSummary['groups'][number] => {
    const d = plugin.machineDetails(plugin.machineTemplateSpec(spec, spec.infrastructure, g, role));
    return {
      name,
      role,
      replicas,
      // Providers without flavors know the size's resources only with the credential.
      ...((d.size ?? g.machineSize) ? { size: d.size ?? g.machineSize } : {}),
      ...(d.image ? { image: { id: d.image } } : {}),
      ...(d.rootVolumeGB ? { rootVolumeGB: d.rootVolumeGB } : {}),
      ...(d.rootVolumeType ? { rootVolumeType: d.rootVolumeType } : {}),
    };
  };
  const cp = spec.topology.controlPlane;
  const infra = spec.infrastructure;
  return {
    provider: infra.provider,
    credentialRef: infra.credentialRef,
    ...('region' in infra ? { region: infra.region } : {}),
    ...('sshKeyName' in infra && infra.sshKeyName ? { sshKeyName: infra.sshKeyName } : {}),
    facts: plugin.infraFacts(infra),
    groups: [
      group('control plane', 'control-plane', cp.replicas, cp),
      ...spec.topology.workerPools.map((p) => group(p.name, 'worker', p.replicas, p)),
    ],
  };
}
