/**
 * Version catalog per Kubernetes distribution (FP3-F-07a), used by the cluster wizard (FP-5)
 * and upgrades (FP-7). Verified on 2026-10-17 against the rancher/rke2 and k0sproject/k0s
 * releases (latest patch per minor), the CAPI v1.14 support matrix (workload clusters 1.31–1.37)
 * and the provider e2e configurations.
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

export const KUBERNETES_VERSIONS: DistributionCatalog[] = [
  {
    flavor: 'rke2',
    providers: { bootstrap: 'rke2-bootstrap', controlPlane: 'rke2-control-plane' },
    versions: [
      { version: 'v1.37.1+rke2r1', minor: '1.37', verifiedWithProvider: 'v0.26.0', untested: true },
      { version: 'v1.36.5+rke2r1', minor: '1.36', verifiedWithProvider: 'v0.26.0', untested: true },
      // RKE2 provider v0.26.0 runs its e2e tests with Kubernetes v1.35.
      { version: 'v1.35.9+rke2r1', minor: '1.35', verifiedWithProvider: 'v0.26.0', default: true },
      { version: 'v1.34.12+rke2r1', minor: '1.34', verifiedWithProvider: 'v0.26.0' },
      { version: 'v1.33.13+rke2r3', minor: '1.33', verifiedWithProvider: 'v0.26.0' },
    ],
  },
  // Verified on 2026-10-18 against the k0sproject/k0s releases (latest patch per minor). k0smotron
  // v2.2.0 runs its e2e tests with v1.31 only; 1.34 and 1.35 were verified live in FP-9.
  {
    flavor: 'k0s',
    providers: { bootstrap: 'k0smotron-bootstrap', controlPlane: 'k0smotron-control-plane' },
    versions: [
      { version: 'v1.36.4+k0s.1', minor: '1.36', verifiedWithProvider: 'v2.2.0', untested: true },
      { version: 'v1.35.8+k0s.1', minor: '1.35', verifiedWithProvider: 'v2.2.0', default: true },
      { version: 'v1.34.11+k0s.1', minor: '1.34', verifiedWithProvider: 'v2.2.0' },
      { version: 'v1.33.13+k0s.1', minor: '1.33', verifiedWithProvider: 'v2.2.0' },
    ],
  },

  // Verified on 2026-10-18 against dl.k8s.io/release/stable-1.XX.txt and the pkgs.k8s.io deb and
  // rpm repositories (FP10-F-02); Cluster API v1.14 supports Kubernetes v1.33 to v1.37 for kubeadm
  // (docs/book reference/versions.md).
  {
    flavor: 'kubeadm',
    providers: { bootstrap: 'kubeadm-bootstrap', controlPlane: 'kubeadm-control-plane' },
    versions: [
      { version: 'v1.37.1', minor: '1.37', verifiedWithProvider: 'v1.14.3' },
      { version: 'v1.36.5', minor: '1.36', verifiedWithProvider: 'v1.14.3' },
      { version: 'v1.35.9', minor: '1.35', verifiedWithProvider: 'v1.14.3', default: true },
      { version: 'v1.34.12', minor: '1.34', verifiedWithProvider: 'v1.14.3' },
      { version: 'v1.33.13', minor: '1.33', verifiedWithProvider: 'v1.14.3' },
    ],
  },
];

export function distributionCatalog(flavor: DistributionCatalog['flavor']) {
  return KUBERNETES_VERSIONS.find((d) => d.flavor === flavor);
}
