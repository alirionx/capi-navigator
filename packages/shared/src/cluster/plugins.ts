import type { ProxmoxMachineSize } from '../credentials.js';
import type { ManifestObject } from '../operator-manifests.js';
import type { AirGapArtifact } from './air-gap.js';
import type { InfraForm } from './infra-form.js';
import type { ClusterSpec, Infrastructure, MachineGroup } from './spec.js';

/** Resolved, non-secret facts the transformation needs besides the spec. */
export interface TransformContext {
  credential: {
    /** OpenStack: entry of the clouds.yaml (identityRef.cloudName). */
    cloudName?: string;
    /** The credential's Secret, for providers that reference it directly (CAPG credentialsRef). */
    secret?: { name: string; namespace: string };
    /** Machine sizes kept with the credential, for providers without flavors (FP31-F-04). */
    machineSizes?: ProxmoxMachineSize[];
  };
}

/**
 * Network needs of a Kubernetes distribution (ADR-0012). Infrastructure plugins turn them into
 * load balancer listeners and security group rules, so a new distribution needs no change in
 * the infrastructure plugins.
 */
export interface FlavorNetwork {
  /** Ports the control plane accepts from all nodes, besides the Kubernetes API (6443). */
  controlPlanePorts: {
    port: number;
    description: string;
    /** Reached through the API load balancer (listener on the load balancer). */
    viaLoadBalancer: boolean;
  }[];
  /** Traffic between all nodes, e.g. of the CNI; for providers without in-cluster allow-all. */
  nodeTraffic: {
    /** IP protocol: tcp, udp or a protocol number like "4" (IP-in-IP). */
    protocol: 'tcp' | 'udp' | '4';
    fromPort: number;
    toPort: number;
    description: string;
  }[];
}

export interface ObjectRef {
  apiGroup: string;
  kind: string;
  name: string;
}

/**
 * Infrastructure part of a provider plugin (section 5, `InfraProviderPlugin`): everything that
 * is specific to the cloud. Pure functions; the generic transformation only uses this interface.
 */
export interface InfraTransformPlugin<T extends Infrastructure = Infrastructure> {
  provider: T['provider'];
  infraClusterKind: string;
  machineTemplateKind: string;
  apiVersion: string;
  /** The provider's forms in wizard, details and day 2 (FP25-F-05). */
  form: InfraForm;
  /** OpenStackCluster / AWSCluster. */
  infraCluster(
    spec: ClusterSpec,
    infra: T,
    ctx: TransformContext,
    labels: Record<string, string>,
    network: FlavorNetwork,
  ): ManifestObject;
  /** `spec.template.spec` of the machine template of one group. */
  machineTemplateSpec(
    spec: ClusterSpec,
    infra: T,
    group: MachineGroup,
    role: 'control-plane' | 'worker',
    ctx?: TransformContext,
  ): Record<string, unknown>;
  /**
   * Virtual IP of the API server when the infrastructure has no load balancer (FP31-F-07): the
   * distribution runs kube-vip on its control plane nodes to hold it.
   */
  apiVip?(infra: T): string;
  /**
   * Address clashes with the other infrastructure clusters of the management cluster (blockers),
   * for providers where the user hands out addresses (FP31-F-08).
   */
  addressConflicts?(spec: ClusterSpec, infra: T, others: Record<string, unknown>[]): string[];
  /** Likely mistakes that do not block, shown in the preview, e.g. public DNS when air-gapped. */
  warnings?(spec: ClusterSpec, infra: T): string[];
  /** Problems the spec alone cannot show, e.g. a size the credential does not know (blockers). */
  validate?(spec: ClusterSpec, infra: T, ctx: TransformContext): string[];
  /** Failure domain for worker MachineDeployments, if any. */
  failureDomain?(infra: T): string | undefined;
  /**
   * Node identity from cloud-init instance data (ADR-0004): providerID and node name as
   * Jinja templates rendered on the node.
   */
  nodeIdentity(infra: T): { providerId: string; nodeName: string };
  /** Commands every node runs first, before the distribution is installed (as root). */
  nodePreparation?: string[];
  /**
   * Further preparation that needs the internet, e.g. installing a package; left out for
   * air-gapped clusters, whose images must already contain it (FP29-F-15).
   */
  onlineNodePreparation?: string[];
  /**
   * Shell command printing the node's IPv4 address, for infrastructures whose CCM takes the node
   * address from the kubelet (`--node-ip`) instead of instance metadata (FP31-F-11). Kubelets
   * with an external cloud provider report none of their own (k0s from Kubernetes 1.36, FP-31
   * live test); distributions that do not set `--node-ip` themselves pass it on.
   */
  nodeAddressCommand?(infra: T): string;
  /**
   * Limits of the API load balancer the distributions adapt to (ADR-0022). Unset: it forwards
   * the ports a distribution asks for (`FlavorNetwork`) and checks the API server by TCP.
   */
  apiLoadBalancer?: {
    /** Port the load balancer listens on (Cluster.spec.clusterNetwork.apiServerPort). */
    port: number;
    /** Only the API port is forwarded; other control plane ports are not reachable through it. */
    apiPortOnly: boolean;
    /** Health check by HTTPS /readyz without credentials: the API server must allow anonymous. */
    anonymousHealthCheck: boolean;
  };
  /** Plurals for reading and watching the provider's objects (FP-6). */
  resources: {
    infraClusterPlural: string;
    machineKind: string;
    machinePlural: string;
    machineTemplatePlural: string;
  };
  /** Size, image and root disk of a running machine from its infra machine spec (FP6-F-02). */
  machineDetails(infraMachineSpec: Record<string, unknown>): MachineDetails;
  /** Bastion address and state from the infra cluster status (FP5-F-20). */
  bastionStatus(infraClusterStatus: Record<string, unknown>): {
    publicIP?: string;
    privateIP?: string;
    state?: string;
  };
  /** Facts for the infrastructure card of the detail view (region, network, …), from the spec. */
  infraFacts(infra: T): { label: string; value: string }[];
  /** Labels on the Cluster that select the CCM/CSI presets (FP5-F-09, FP5-F-17). */
  addonLabels(spec: ClusterSpec): Record<string, string>;
  /** Extra objects, e.g. the ClusterResourceSet that delivers the OpenStack cloud config. */
  extraObjects(spec: ClusterSpec, infra: T, labels: Record<string, string>): ManifestObject[];
}

/** What the cluster detail view shows per machine (FP6-F-02). */
export interface MachineDetails {
  size?: string;
  image?: string;
  rootVolumeGB?: number;
  rootVolumeType?: string;
}

/** Kubernetes distribution (section 5, `BootstrapFlavorPlugin`): RKE2 in FP-5, k0s in FP-9. */
export interface BootstrapFlavorPlugin {
  flavor: ClusterSpec['kubernetes']['flavor'];
  /** Ports and node traffic the distribution needs (ADR-0012). */
  network: FlavorNetwork;
  /** The distribution ships no CNI; a CNI preset is rolled out unless switched off (FP10-F-04). */
  needsCni?: boolean;
  /** Installs Kubernetes from packages and release binaries at first boot; mirrors apply (FP10-F-09). */
  installsPackages?: boolean;
  /** Marked as experimental in the wizard, with its trade-offs (FP10-F-08). */
  experimental?: boolean;
  /**
   * Installation without internet from the internal registry (FP-29 part B): the artifact with
   * the binaries of a version. Unset: the distribution cannot run air-gapped.
   */
  airGap?: { artifact(version: string): AirGapArtifact };
  /** Display name and the fields node customization maps to, for help texts (POS-04). */
  displayName: string;
  customizationFields: { preCommands: string; postCommands: string };
  /**
   * Version for Machine/MachineDeployment as the kubelet reports it; CAPI compares both exactly
   * for the UpToDate condition. Defaults to the distribution version.
   */
  machineVersion?(version: string): string;
  /**
   * How the control plane takes changes (ADR-0013). `versionInPlace`: version upgrades update the
   * nodes in place; `replacementBlocked`: changes that replace control plane machines are refused
   * with this reason, unless the installed provider `replacementFixedIn.provider` (catalog ID) is at
   * least `replacementFixedIn.version` and the control plane has at most `maxReplicas` nodes;
   * larger control planes are refused with `multiNodeReason`. Unset: every change replaces
   * machines (template rotation).
   */
  controlPlaneUpdates?: {
    versionInPlace: boolean;
    /** Shown in the preview when the control plane shrinks (FP26-F-03). */
    scaleDownWarning?: string;
    replacementBlocked?: string;
    replacementFixedIn?: {
      provider: string;
      version: string;
      maxReplicas?: number;
      multiNodeReason?: string;
    };
  };
  controlPlaneRef(spec: ClusterSpec): ObjectRef;
  controlPlane(args: {
    spec: ClusterSpec;
    infra: InfraTransformPlugin;
    machineTemplate: ObjectRef;
    labels: Record<string, string>;
  }): ManifestObject;
  /** Worker bootstrap template `spec.template.spec`; the generic part names it by content hash. */
  workerBootstrapSpec(args: {
    spec: ClusterSpec;
    infra: InfraTransformPlugin;
    pool: ClusterSpec['topology']['workerPools'][number];
  }): Record<string, unknown>;
  bootstrapTemplate: { apiVersion: string; apiGroup: string; kind: string };
  /**
   * Further management cluster objects of the cluster, e.g. drain rules for components the
   * distribution ships (removed with the cluster by label).
   */
  extraObjects?(spec: ClusterSpec, labels: Record<string, string>): ManifestObject[];
  /** Control plane resource for reading and watching (FP-6). */
  controlPlaneResource: { group: string; version: string; kind: string; plural: string };
  /** Bootstrap templates and per-machine configs, for the resources tab (FP7-F-01). */
  bootstrapResources: {
    group: string;
    version: string;
    templateKind: string;
    templatePlural: string;
    configKind: string;
    configPlural: string;
  };
}
