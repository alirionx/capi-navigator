/**
 * Prerequisites of the CAPI Operator and CAPO (FP3-F-01..04a). Versions verified on 2026-10-17.
 */
export const CERT_MANAGER = {
  recommendedVersion: 'v1.21.2',
  crd: 'certificates.cert-manager.io',
  /** Deployments that must be available, matched by app.kubernetes.io/name. */
  deployments: ['cert-manager', 'cainjector', 'webhook'],
  installCommand: (version: string) =>
    [
      `helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \\`,
      `  --version ${version} --namespace cert-manager --create-namespace \\`,
      `  --set crds.enabled=true --wait`,
    ].join('\n'),
  docsUrl: 'https://cert-manager.io/docs/installation/helm/',
};

export const CAPI_OPERATOR = {
  recommendedVersion: 'v0.29.0',
  crd: 'coreproviders.operator.cluster.x-k8s.io',
  /** Matched by app.kubernetes.io/name on the operator deployment (Helm chart). */
  deploymentName: 'cluster-api-operator',
  imageRepository: 'registry.k8s.io/capi-operator/cluster-api-operator',
  installCommand: (version: string) =>
    [
      `helm upgrade --install capi-operator cluster-api-operator \\`,
      `  --repo https://kubernetes-sigs.github.io/cluster-api-operator \\`,
      `  --version ${version.replace(/^v/, '')} --namespace capi-operator-system --create-namespace --wait`,
    ].join('\n'),
  docsUrl: 'https://cluster-api-operator.sigs.k8s.io/',
};

/** OpenStack Resource Controller, installed from its release manifest. */
export const ORC = {
  crdGroup: 'openstack.k-orc.cloud',
  crd: 'servers.openstack.k-orc.cloud',
  namespace: 'orc-system',
  deploymentName: 'orc-controller-manager',
  imageRepository: 'quay.io/orc/openstack-resource-controller',
  repository: 'k-orc/openstack-resource-controller',
  /** Only release assets of this repository may be downloaded (FP-3 decision). */
  manifestUrl: (version: string) =>
    `https://github.com/k-orc/openstack-resource-controller/releases/download/${version}/install.yaml`,
  /** CRDs that need the clusterctl move label (CAPO docs, configuration.md). */
  moveLabelCrds: ['servers.openstack.k-orc.cloud', 'images.openstack.k-orc.cloud'],
  docsUrl: 'https://k-orc.cloud',
};

/**
 * ORC version per CAPO minor version: the ORC module version CAPO is built against (go.mod).
 * CAPO v0.15.0 → ORC v2.6.0, v0.14.8 → v2.4.0, v0.13.10 → v2.3.0.
 */
export const ORC_FOR_CAPO: Record<string, string> = {
  'v0.15': 'v2.6.0',
  'v0.14': 'v2.4.0',
  'v0.13': 'v2.3.0',
};

export function orcVersionForCapo(capoVersion: string): string | undefined {
  const minor = /^(v\d+\.\d+)/.exec(capoVersion)?.[1];
  return minor ? ORC_FOR_CAPO[minor] : undefined;
}

/** Compares "vX.Y.Z" versions; returns <0, 0, >0. Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[-+]/)[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
