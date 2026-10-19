import { VERSIONS } from '../versions.generated.js';

/**
 * Version catalog per Kubernetes distribution (FP3-F-07a), used by the cluster wizard (FP-5)
 * and upgrades (FP-7). The versions and how they were verified (releases, CAPI support matrix,
 * provider e2e configurations, live tests) live in versions.yaml (FP-20).
 */
export interface DistributionVersion {
  /** Full distribution version, e.g. "v1.35.9+rke2r1". */
  version: string;
  /** Kubernetes minor, e.g. "1.35". */
  minor: string;
  /** Provider version (bootstrap + control plane) this entry was verified with. */
  verifiedWithProvider: string;
  /** Default for new clusters. */
  default?: boolean;
  /** Supported by CAPI and the provider, but newer than the provider's own e2e tests. */
  untested?: boolean;
}

export interface DistributionCatalog {
  flavor: 'rke2' | 'k0s' | 'kubeadm';
  /** Catalog ids of the bootstrap and control plane providers. */
  providers: { bootstrap: string; controlPlane: string };
  versions: DistributionVersion[];
}

/** Catalog entries from versions.yaml (FP-20); the minor is derived from the version. */
function catalogVersions(flavor: DistributionCatalog['flavor']): DistributionVersion[] {
  return VERSIONS.kubernetes[flavor].versions.map((v) => ({
    version: v.version,
    minor: /^v(\d+\.\d+)\./.exec(v.version)![1]!,
    verifiedWithProvider: v.verifiedWithProvider,
    ...(v.default ? { default: true } : {}),
    ...(v.untested ? { untested: true } : {}),
  }));
}

export const KUBERNETES_VERSIONS: DistributionCatalog[] = [
  {
    flavor: 'rke2',
    providers: { bootstrap: 'rke2-bootstrap', controlPlane: 'rke2-control-plane' },
    versions: catalogVersions('rke2'),
  },
  {
    flavor: 'k0s',
    providers: { bootstrap: 'k0smotron-bootstrap', controlPlane: 'k0smotron-control-plane' },
    versions: catalogVersions('k0s'),
  },
  {
    flavor: 'kubeadm',
    providers: { bootstrap: 'kubeadm-bootstrap', controlPlane: 'kubeadm-control-plane' },
    versions: catalogVersions('kubeadm'),
  },
];

export function distributionCatalog(flavor: DistributionCatalog['flavor']) {
  return KUBERNETES_VERSIONS.find((d) => d.flavor === flavor);
}
