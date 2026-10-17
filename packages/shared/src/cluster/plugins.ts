import type { ManifestObject } from '../operator-manifests.js';
import type { ClusterSpec, Infrastructure, MachineGroup } from './spec.js';

/** Resolved, non-secret facts the transformation needs besides the spec. */
export interface TransformContext {
  credential: {
    /** OpenStack: entry of the clouds.yaml (identityRef.cloudName). */
    cloudName?: string;
  };
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
  resources: { infraClusterPlural: string; machineKind: string; machinePlural: string };
  /** Size, image and root disk of a running machine from its infra machine spec (FP6-F-02). */
  machineDetails(infraMachineSpec: Record<string, unknown>): MachineDetails;
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

/** Kubernetes distribution (section 5, `BootstrapFlavorPlugin`): RKE2 in FP-5. */
export interface BootstrapFlavorPlugin {
  flavor: ClusterSpec['kubernetes']['flavor'];
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
}
