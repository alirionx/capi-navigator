import type { ManifestObject } from '../operator-manifests.js';
import type { InfraTransformPlugin } from './plugins.js';
import type { ClusterSpec, MachineGroup, OpenStackInfra } from './spec.js';
import { compact } from './util.js';

/**
 * OpenStack (CAPO v0.15.0, infrastructure.cluster.x-k8s.io/v1beta2). Field names verified against
 * api/v1beta2/openstackcluster_types.go, openstackmachine_types.go and types.go.
 */
export const OPENSTACK_API_VERSION = 'infrastructure.cluster.x-k8s.io/v1beta2';

/** Name of the per-cluster Secret with the CCM/CSI cloud config (ADR-0004). */
export function openstackCloudConfigSecretName(clusterName: string): string {
  return `${clusterName}-cloud-config`;
}

export const openstackPlugin: InfraTransformPlugin<OpenStackInfra> = {
  provider: 'openstack',
  infraClusterKind: 'OpenStackCluster',
  machineTemplateKind: 'OpenStackMachineTemplate',
  apiVersion: OPENSTACK_API_VERSION,

  infraCluster(spec, infra, ctx, labels): ManifestObject {
    return {
      apiVersion: OPENSTACK_API_VERSION,
      kind: 'OpenStackCluster',
      metadata: { name: spec.name, namespace: spec.namespace, labels },
      spec: compact({
        // ADR-0002: credentials as cluster-scoped identity.
        identityRef: {
          type: 'ClusterIdentity',
          name: infra.credentialRef,
          cloudName: ctx.credential.cloudName,
        },
        externalNetwork: { id: infra.externalNetwork },
        // FP5-F-03: dedicated network, subnet and router per cluster.
        managedSubnets: [
          { cidr: infra.network.nodeCidr, dnsNameservers: infra.network.dnsNameservers },
        ],
        managedSecurityGroups: {
          allowAllInClusterTraffic: true,
          // CAPO opens NodePorts only on workers; all-in-one runs workloads on the control plane node.
          controlPlaneNodesSecurityGroupRules:
            spec.topology.mode === 'all-in-one'
              ? (['tcp', 'udp'] as const).map((protocol) => ({
                  name: `nodeport-${protocol}`,
                  description: `Kubernetes NodePort services (${protocol.toUpperCase()})`,
                  direction: 'ingress',
                  etherType: 'IPv4',
                  protocol,
                  portRangeMin: 30000,
                  portRangeMax: 32767,
                  remoteIPPrefix: '0.0.0.0/0',
                }))
              : undefined,
        },
        apiServer: infra.apiServerLoadBalancer
          ? { managedLoadBalancer: { enabled: true } }
          : { enableFloatingIP: true },
        controlPlaneAvailabilityZones: infra.failureDomain ? [infra.failureDomain] : undefined,
      }),
    };
  },

  machineTemplateSpec(spec, infra, group: MachineGroup) {
    return compact({
      flavor: { filter: { name: group.machineSize } },
      image: { id: group.image ?? infra.image },
      sshKeyName: infra.sshKeyName,
      // FP5-F-19: boot from a Cinder volume instead of the flavor's local disk; required for
      // flavors without local disk (e.g. Infomaniak "-disk0").
      rootVolume: group.rootVolumeSizeGB
        ? { sizeGiB: group.rootVolumeSizeGB, type: group.rootVolumeType }
        : undefined,
    });
  },

  failureDomain: (infra) => infra.failureDomain,

  resources: {
    infraClusterPlural: 'openstackclusters',
    machineKind: 'OpenStackMachine',
    machinePlural: 'openstackmachines',
  },

  machineDetails(s) {
    const flavor = s.flavor as { filter?: { name?: string }; id?: string } | undefined;
    const image = s.image as { id?: string; filter?: { name?: string } } | undefined;
    const root = s.rootVolume as { sizeGiB?: number; type?: string } | undefined;
    return compact({
      size: flavor?.filter?.name ?? flavor?.id,
      image: image?.id ?? image?.filter?.name,
      rootVolumeGB: root?.sizeGiB,
      rootVolumeType: root?.type,
    });
  },

  infraFacts: (infra) => [
    { label: 'Node network', value: infra.network.nodeCidr },
    { label: 'External network', value: infra.externalNetwork },
    {
      label: 'API server',
      value: infra.apiServerLoadBalancer ? 'Octavia load balancer' : 'Floating IP',
    },
    ...(infra.failureDomain ? [{ label: 'Availability zone', value: infra.failureDomain }] : []),
    ...(infra.sshKeyName ? [{ label: 'SSH key pair', value: infra.sshKeyName }] : []),
  ],

  nodeIdentity: {
    providerId: 'openstack:///{{ v1.instance_id }}',
    nodeName: '{{ v1.local_hostname }}',
  },

  addonLabels(spec) {
    return {
      ...(spec.addons.cloudControllerManager ? { 'capi-navigator.io/ccm': 'openstack' } : {}),
      ...(spec.addons.csiDriver ? { 'capi-navigator.io/csi': 'openstack' } : {}),
    };
  },

  extraObjects(spec, _infra, labels) {
    if (!spec.addons.cloudControllerManager && !spec.addons.csiDriver) return [];
    // Delivers kube-system/cloud-config into the workload cluster; the Secret with the content is
    // created by the backend from the stored credential (ADR-0004, hard rule 8).
    return [
      {
        apiVersion: 'addons.cluster.x-k8s.io/v1beta2',
        kind: 'ClusterResourceSet',
        metadata: {
          name: openstackCloudConfigSecretName(spec.name),
          namespace: spec.namespace,
          labels,
        },
        spec: {
          clusterSelector: { matchLabels: { 'cluster.x-k8s.io/cluster-name': spec.name } },
          resources: [{ kind: 'Secret', name: openstackCloudConfigSecretName(spec.name) }],
          strategy: 'Reconcile',
        },
      },
    ];
  },
};

/** For tests and type narrowing. */
export function isOpenStack(
  spec: ClusterSpec,
): spec is ClusterSpec & { infrastructure: OpenStackInfra } {
  return spec.infrastructure.provider === 'openstack';
}
