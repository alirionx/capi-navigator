import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, type ManifestObject } from '../operator-manifests.js';
import { CNI_LABEL } from './addons.js';
import { modificationNotice } from './manifest-addons.js';
import { shortHash } from './util.js';
import { VERSIONS } from '../versions.generated.js';

/**
 * Calico for distributions without a built-in CNI (kubeadm, FP10-F-04; ADR-0014). The official
 * manifest calico-vxlan.yaml (no operator, VXLAN, pod CIDR detected from the kubeadm
 * configuration) is delivered by an upstream ClusterResourceSet: since Calico v3.32 its CRDs
 * exceed the 1 MiB size limit of a Helm release, so CAAPH cannot install Calico.
 * The manifest is shipped with the backend (assets/calico) and verified by its checksum.
 */
export const CALICO_MANIFEST = {
  version: VERSIONS.cni.calico.version,
  file: VERSIONS.cni.calico.manifest,
  /** sha256 of manifests/calico-vxlan.yaml of the Calico release (versions.yaml, cni.calico). */
  sha256: VERSIONS.cni.calico.sha256,
};

/**
 * The official manifest with VXLAN for all pod traffic: its default "CrossSubnet" routes pod IPs
 * natively within a subnet, which OpenStack port security and the AWS source/destination check
 * drop (seen live: no pod traffic between nodes). Fails if the setting is not found.
 */
export function calicoManifestForCluster(manifest: string): string {
  let out = manifest;
  for (const name of ['CALICO_IPV4POOL_VXLAN', 'CALICO_IPV6POOL_VXLAN']) {
    const from = `- name: ${name}\n              value: "CrossSubnet"`;
    if (!out.includes(from)) throw new Error(`Calico manifest: ${name} not found`);
    out = out.replace(from, `- name: ${name}\n              value: "Always"`);
  }
  return (
    modificationNotice(
      `Project Calico ${CALICO_MANIFEST.version}, manifests/calico-vxlan.yaml`,
      'VXLAN mode "Always" for all pod traffic (CALICO_IPV4POOL_VXLAN, CALICO_IPV6POOL_VXLAN).',
    ) + out
  );
}

/**
 * Name of the ConfigMap and ClusterResourceSet per namespace: version plus content hash, so a
 * changed manifest never reuses an existing ConfigMap.
 */
export function calicoResourceSetName(content: string): string {
  return `capi-navigator-calico-${CALICO_MANIFEST.version.replace(/\./g, '-')}-${shortHash(content).slice(0, 6)}`;
}

/**
 * Pure: ConfigMap with the manifest and the ClusterResourceSet that applies it once to every
 * cluster of the namespace with the CNI label. Shared by the clusters of a namespace, so they carry
 * no cluster label and stay when one cluster is deleted (like the add-on presets).
 */
export function buildCalicoResourceSet(namespace: string, manifest: string): ManifestObject[] {
  const content = calicoManifestForCluster(manifest);
  const name = calicoResourceSetName(content);
  const labels = { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, 'capi-navigator.io/cni': 'calico' };
  return [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name, namespace, labels },
      data: { 'calico.yaml': content },
    },
    {
      apiVersion: 'addons.cluster.x-k8s.io/v1beta2',
      kind: 'ClusterResourceSet',
      metadata: { name, namespace, labels },
      spec: {
        clusterSelector: { matchLabels: Object.fromEntries([CNI_LABEL]) },
        resources: [{ kind: 'ConfigMap', name }],
        strategy: 'ApplyOnce',
      },
    },
  ];
}
