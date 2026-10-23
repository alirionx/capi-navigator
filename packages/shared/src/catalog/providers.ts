import { z } from 'zod';
import { VERSIONS } from '../versions.generated.js';

/** Provider kinds of the CAPI Operator (operator.cluster.x-k8s.io/v1alpha2). */
export const PROVIDER_KINDS = [
  'CoreProvider',
  'BootstrapProvider',
  'ControlPlaneProvider',
  'InfrastructureProvider',
  'AddonProvider',
  'IPAMProvider',
] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const OPERATOR_GROUP = 'operator.cluster.x-k8s.io';
export const OPERATOR_VERSION = 'v1alpha2';
export const OPERATOR_API_VERSION = `${OPERATOR_GROUP}/${OPERATOR_VERSION}`;

export const PROVIDER_PLURALS: Record<ProviderKind, string> = {
  CoreProvider: 'coreproviders',
  BootstrapProvider: 'bootstrapproviders',
  ControlPlaneProvider: 'controlplaneproviders',
  InfrastructureProvider: 'infrastructureproviders',
  AddonProvider: 'addonproviders',
  IPAMProvider: 'ipamproviders',
};

export interface ProviderCatalogEntry {
  /** Unique id in the catalog, e.g. "rke2-bootstrap". */
  id: string;
  kind: ProviderKind;
  /** Provider name known to the CAPI Operator (clusterctl built-in list), used as CR name. */
  name: string;
  displayName: string;
  description: string;
  /** Recommended version, verified against the provider's releases and contract. */
  recommendedVersion: string;
  /** Default namespace for the provider CR and its components. */
  defaultNamespace: string;
  /** GitHub repository for the release list (FP3-F-07). */
  repository: string;
  docsUrl: string;
  /** Catalog ids that must be installed and ready first (FP3-F-11). */
  dependsOn: string[];
  /** Needs the OpenStack Resource Controller (FP3-F-04a). */
  requiresOrc?: boolean;
  /** Not yet selectable in the UI; enabled by a later feature pack. */
  availableFrom?: string;
  /** CAPI contract implemented by the recommended version. */
  contract: string;
  /**
   * Configuration variables the provider's components require; prefilled in the install dialog
   * and added with these defaults when missing (FP3-F-09).
   */
  defaultVariables?: Record<string, string>;
  /** Explanation shown next to the configuration variables. */
  variablesHint?: string;
  /**
   * The provider calls an infrastructure API whose certificate the app checks against the CAs of
   * the stored credentials (FP31-F-01): `env` is always set on the manager container; with CAs,
   * the bundle is mounted from a Secret and passed with `certFileArg`.
   */
  tls?: {
    deployment: string;
    /** Container name and its index in the components' Deployment (for the JSON patch). */
    container: string;
    containerIndex: number;
    env: Record<string, string>;
    certFileArg: string;
    mountPath: string;
  };
}

/**
 * Provider catalog (FP3-F-05, FP3-F-06). Verified on 2026-10-17 against the GitHub releases,
 * metadata.yaml and go.mod of each provider; names from clusterctl v1.14.3 providers_client.go.
 */
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'core',
    kind: 'CoreProvider',
    name: 'cluster-api',
    displayName: 'Cluster API (core)',
    description: 'Core controllers: Cluster, Machine, MachineDeployment and friends.',
    recommendedVersion: VERSIONS.providers['cluster-api'].version,
    defaultNamespace: 'capi-system',
    repository: 'kubernetes-sigs/cluster-api',
    docsUrl: 'https://cluster-api.sigs.k8s.io/',
    dependsOn: [],
    contract: 'v1beta2',
  },
  {
    id: 'kubeadm-bootstrap',
    kind: 'BootstrapProvider',
    name: 'kubeadm',
    displayName: 'kubeadm bootstrap',
    description: 'Generates kubeadm cloud-init for nodes (FP-10, experimental).',
    recommendedVersion: VERSIONS.providers['cluster-api'].version,
    defaultNamespace: 'capi-kubeadm-bootstrap-system',
    repository: 'kubernetes-sigs/cluster-api',
    docsUrl: 'https://cluster-api.sigs.k8s.io/tasks/bootstrap/kubeadm-bootstrap/',
    dependsOn: ['core'],
    contract: 'v1beta2',
  },
  {
    id: 'kubeadm-control-plane',
    kind: 'ControlPlaneProvider',
    name: 'kubeadm',
    displayName: 'kubeadm control plane',
    description: 'Manages kubeadm-based control planes (KubeadmControlPlane).',
    recommendedVersion: VERSIONS.providers['cluster-api'].version,
    defaultNamespace: 'capi-kubeadm-control-plane-system',
    repository: 'kubernetes-sigs/cluster-api',
    docsUrl: 'https://cluster-api.sigs.k8s.io/tasks/control-plane/kubeadm-control-plane',
    dependsOn: ['core'],
    contract: 'v1beta2',
  },
  {
    id: 'rke2-bootstrap',
    kind: 'BootstrapProvider',
    name: 'rke2',
    displayName: 'RKE2 bootstrap',
    description: 'Installs RKE2 on stock cloud images via cloud-init (RKE2Config).',
    recommendedVersion: VERSIONS.providers['rke2'].version,
    defaultNamespace: 'rke2-bootstrap-system',
    repository: 'rancher/cluster-api-provider-rke2',
    docsUrl: 'https://rancher.github.io/cluster-api-provider-rke2/',
    dependsOn: ['core'],
    contract: 'v1beta2',
  },
  {
    id: 'rke2-control-plane',
    kind: 'ControlPlaneProvider',
    name: 'rke2',
    displayName: 'RKE2 control plane',
    description: 'Manages RKE2 control planes (RKE2ControlPlane).',
    recommendedVersion: VERSIONS.providers['rke2'].version,
    defaultNamespace: 'rke2-control-plane-system',
    repository: 'rancher/cluster-api-provider-rke2',
    docsUrl: 'https://rancher.github.io/cluster-api-provider-rke2/',
    dependsOn: ['core'],
    contract: 'v1beta2',
  },
  {
    id: 'openstack',
    kind: 'InfrastructureProvider',
    name: 'openstack',
    displayName: 'OpenStack (CAPO)',
    description: 'Creates networks, load balancers and servers on OpenStack. Requires ORC.',
    recommendedVersion: VERSIONS.providers['openstack'].version,
    defaultNamespace: 'capo-system',
    repository: 'kubernetes-sigs/cluster-api-provider-openstack',
    docsUrl: 'https://cluster-api-openstack.sigs.k8s.io/',
    dependsOn: ['core'],
    requiresOrc: true,
    contract: 'v1beta2',
  },
  {
    id: 'helm',
    kind: 'AddonProvider',
    name: 'helm',
    displayName: 'Helm add-ons (CAAPH)',
    description: 'Installs Helm charts into workload clusters (HelmChartProxy).',
    recommendedVersion: VERSIONS.providers['helm'].version,
    defaultNamespace: 'caaph-system',
    repository: 'kubernetes-sigs/cluster-api-addon-provider-helm',
    docsUrl: 'https://github.com/kubernetes-sigs/cluster-api-addon-provider-helm',
    dependsOn: ['core'],
    contract: 'v1beta2',
  },
  {
    id: 'k0smotron-bootstrap',
    kind: 'BootstrapProvider',
    name: 'k0sproject-k0smotron',
    displayName: 'k0smotron bootstrap',
    description: 'Installs k0s on stock cloud images (K0sWorkerConfig).',
    recommendedVersion: VERSIONS.providers['k0smotron'].version,
    defaultNamespace: 'k0smotron-bootstrap-system',
    repository: 'k0sproject/k0smotron',
    docsUrl: 'https://docs.k0smotron.io/',
    dependsOn: ['core'],
    contract: 'v1beta2',
  },
  {
    id: 'k0smotron-control-plane',
    kind: 'ControlPlaneProvider',
    name: 'k0sproject-k0smotron',
    displayName: 'k0smotron control plane',
    description: 'Manages k0s control planes on machines (K0sControlPlane).',
    recommendedVersion: VERSIONS.providers['k0smotron'].version,
    defaultNamespace: 'k0smotron-control-plane-system',
    repository: 'k0sproject/k0smotron',
    docsUrl: 'https://docs.k0smotron.io/',
    dependsOn: ['core'],
    contract: 'v1beta2',
  },
  {
    id: 'aws',
    kind: 'InfrastructureProvider',
    name: 'aws',
    displayName: 'AWS (CAPA)',
    description: 'Creates VPCs, load balancers and EC2 instances on Amazon Web Services.',
    recommendedVersion: VERSIONS.providers['aws'].version,
    defaultNamespace: 'capa-system',
    repository: 'kubernetes-sigs/cluster-api-provider-aws',
    docsUrl: 'https://cluster-api-aws.sigs.k8s.io/',
    dependsOn: ['core'],
    contract: 'v1beta2',
    // The CAPA components reference this variable; it must exist but may stay empty because
    // CAPI Navigator uses an AWSClusterStaticIdentity per credential (FP-4, multitenancy docs).
    defaultVariables: { AWS_B64ENCODED_CREDENTIALS: '' },
    variablesHint:
      'AWS_B64ENCODED_CREDENTIALS can stay empty: clusters use the AWS credentials stored in CAPI Navigator (AWSClusterStaticIdentity).',
  },
  {
    id: 'gcp',
    kind: 'InfrastructureProvider',
    name: 'gcp',
    displayName: 'Google Cloud (CAPG)',
    description: 'Creates networks, load balancers and Compute Engine instances on Google Cloud.',
    recommendedVersion: VERSIONS.providers['gcp'].version,
    defaultNamespace: 'capg-system',
    repository: 'kubernetes-sigs/cluster-api-provider-gcp',
    docsUrl: 'https://cluster-api-gcp.sigs.k8s.io/',
    dependsOn: ['core'],
    // CAPG v1.13 still implements the v1beta1 contract; CAPI v1.14 supports it (versions.yaml).
    contract: 'v1beta1',
    // The components put this variable into the controller's own credentials Secret; it may stay
    // empty because every cluster references the credential stored in CAPI Navigator
    // (GCPCluster.spec.credentialsRef, FP25-F-02).
    defaultVariables: { GCP_B64ENCODED_CREDENTIALS: '' },
    variablesHint:
      'GCP_B64ENCODED_CREDENTIALS can stay empty: clusters use the Google Cloud credentials stored in CAPI Navigator (credentialsRef).',
  },
  {
    id: 'ipam-in-cluster',
    kind: 'IPAMProvider',
    name: 'in-cluster',
    displayName: 'In-cluster IPAM',
    description:
      'Hands out node addresses from IP ranges, for providers without DHCP (Proxmox VE).',
    recommendedVersion: VERSIONS.providers['ipam-in-cluster'].version,
    defaultNamespace: 'capi-ipam-in-cluster-system',
    repository: 'kubernetes-sigs/cluster-api-ipam-provider-in-cluster',
    docsUrl: 'https://github.com/kubernetes-sigs/cluster-api-ipam-provider-in-cluster',
    dependsOn: ['core'],
    contract: 'v1beta2',
  },
  {
    id: 'proxmox',
    kind: 'InfrastructureProvider',
    name: 'proxmox',
    displayName: 'Proxmox VE (CAPMOX)',
    description:
      'Clones virtual machines from templates on Proxmox VE; addresses from in-cluster IPAM.',
    recommendedVersion: VERSIONS.providers['proxmox'].version,
    defaultNamespace: 'capmox-system',
    repository: 'ionos-cloud/cluster-api-provider-proxmox',
    docsUrl: 'https://github.com/ionos-cloud/cluster-api-provider-proxmox/tree/main/docs',
    dependsOn: ['core', 'ipam-in-cluster'],
    contract: 'v1beta2',
    variablesHint:
      'PROXMOX_URL, PROXMOX_TOKEN and PROXMOX_SECRET can stay empty: clusters use the Proxmox credentials stored in CAPI Navigator (credentialsRef).',
    // CAPMOX skips TLS verification unless told otherwise (ADR-0027).
    tls: {
      deployment: 'capmox-controller-manager',
      container: 'manager',
      containerIndex: 0,
      env: { PROXMOX_INSECURE: 'false' },
      certFileArg: '--proxmox-root-cert-file',
      mountPath: '/var/lib/capi-navigator/ca',
    },
  },
];

export function catalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

export function catalogEntryFor(
  kind: ProviderKind,
  name: string,
): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.kind === kind && p.name === name);
}
