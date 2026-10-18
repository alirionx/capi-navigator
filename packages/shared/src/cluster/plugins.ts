import type { ManifestObject } from '../operator-manifests.js';
import type { ClusterSpec, Infrastructure, MachineGroup } from './spec.js';

/** Resolved, non-secret facts the transformation needs besides the spec. */
export interface TransformContext {
  credential: {
    /** OpenStack: entry of the clouds.yaml (identityRef.cloudName). */
    cloudName?: string;
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
  ): Record<string, unknown>;
  /** Failure domain for worker MachineDeployments, if any. */
  failureDomain?(infra: T): string | undefined;
  /**
   * Node identity from cloud-init instance data (ADR-0004): providerID and node name as
   * Jinja templates rendered on the node.
   */
  nodeIdentity: { providerId: string; nodeName: string };
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
  /** Display name and the fields node customization maps to, for help texts (POS-04). */
  displayName: string;
  customizationFields: { preCommands: string; postCommands: string };
  /**
   * Version for Machine/MachineDeployment as the kubelet reports it; CAPI compares both exactly
   * for the UpToDate condition. Defaults to the distribution version.
   */
  machineVersion?(version: string): string;
  /**
   * Fewest control plane nodes with which replacing control plane machines is safe (ADR-0013);
   * below it, changes that replace them are blocked. Unset: always safe.
   */
  safeControlPlaneReplacement?: { minReplicas: number; reason: string };
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
