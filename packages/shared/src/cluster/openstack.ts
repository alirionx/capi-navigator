import { CHECK_NEUTRON_PAGING } from '../credentials.js';
import type { ManifestObject } from '../operator-manifests.js';
import { ubuntuImage } from './infra-form.js';
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

  form: {
    displayName: 'OpenStack',
    lookups: [
      { kind: 'flavors' },
      { kind: 'images' },
      { kind: 'externalNetworks' },
      { kind: 'availabilityZones' },
      { kind: 'keyPairs' },
      // Clouds without Cinder simply offer no volume types.
      { kind: 'volumeTypes', optional: true },
    ],
    fields: [
      {
        path: 'image',
        kind: 'autocomplete',
        lookup: 'images',
        label: 'wizard.image',
        hint: 'wizard.imageHint',
        preselect: ubuntuImage,
        testId: 'image',
      },
      {
        path: 'externalNetwork',
        kind: 'select',
        lookup: 'externalNetworks',
        label: 'wizard.externalNetwork',
        hint: 'wizard.externalNetworkHint',
        // The only or the "floating" external network.
        preselect: (nets) => (nets.find((n) => /float/i.test(n.label)) ?? nets[0])?.value,
      },
      {
        path: 'network.nodeCidr',
        kind: 'text',
        label: 'wizard.nodeCidr',
        hint: 'wizard.nodeCidrHint',
        default: '10.6.0.0/24',
        cols: 4,
      },
      {
        path: 'network.dnsNameservers',
        kind: 'list',
        label: 'wizard.dns',
        hint: 'wizard.dnsHint',
        default: '1.1.1.1, 8.8.8.8',
        cols: 4,
      },
      {
        path: 'apiServerLoadBalancer',
        kind: 'switch',
        label: 'wizard.apiLb',
        hint: 'wizard.apiLbHint',
        default: true,
        cols: 4,
      },
      {
        path: 'failureDomain',
        kind: 'select',
        lookup: 'availabilityZones',
        label: 'wizard.az',
        hint: 'wizard.azHint',
        clearable: true,
      },
      {
        path: 'sshKeyName',
        kind: 'select',
        lookup: 'keyPairs',
        label: 'wizard.sshKey',
        hint: 'wizard.sshKeyHint',
        clearable: true,
      },
    ],
    keyPairField: 'sshKeyName',
    machine: {
      sizeLookup: 'flavors',
      sizeLabel: 'wizard.machineSize.openstack',
      target: 'OpenStackMachineTemplate',
      sizeField: 'flavor.filter.name',
      rootVolume: {
        neededWithoutLocalDisk: true,
        typeNeedsSize: true,
        types: { lookup: 'volumeTypes' },
        typeHint: 'wizard.rootVolumeTypeOpenStack',
      },
    },
    bastion: {
      sizeLabel: 'bastion.size.openstack',
      sizeHint: 'bastion.sizeHintOs',
      sizeRequired: true,
      // CAPO v0.15 opens SSH to the bastion to everyone (not configurable).
      allowedCidrs: false,
      openWarning: 'bastion.openStackOpen',
      blockingCheck: CHECK_NEUTRON_PAGING,
    },
  },

  infraCluster(spec, infra, ctx, labels, network): ManifestObject {
    const lbPorts = network.controlPlanePorts.filter((p) => p.viaLoadBalancer).map((p) => p.port);
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
        // Node traffic needs no rules (allowAllInClusterTraffic); the distribution's ports behind
        // the API load balancer become listeners (ADR-0012).
        apiServer: infra.apiServerLoadBalancer
          ? {
              managedLoadBalancer: compact({
                enabled: true,
                additionalPorts: lbPorts.length ? lbPorts : undefined,
              }),
            }
          : { enableFloatingIP: true },
        controlPlaneAvailabilityZones: infra.failureDomain ? [infra.failureDomain] : undefined,
        // FP5-F-20: CAPO opens SSH to the bastion to everyone and SSH to the nodes from the
        // bastion. Disabling keeps the spec, as CAPO requires (enabled: false, then removal).
        bastion:
          infra.bastion && (infra.bastion.enabled || infra.bastion.machineSize)
            ? {
                enabled: infra.bastion.enabled,
                spec: compact({
                  flavor: infra.bastion.machineSize
                    ? { filter: { name: infra.bastion.machineSize } }
                    : undefined,
                  image: { id: infra.bastion.image ?? infra.image },
                  sshKeyName: infra.sshKeyName,
                }),
                ...(infra.failureDomain ? { availabilityZone: infra.failureDomain } : {}),
              }
            : undefined,
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
    machineTemplatePlural: 'openstackmachinetemplates',
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

  bastionStatus(st) {
    const b = st.bastion as { floatingIP?: string; ip?: string; state?: string } | undefined;
    return compact({ publicIP: b?.floatingIP, privateIP: b?.ip, state: b?.state });
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

  nodeIdentity: () => ({
    providerId: 'openstack:///{{ v1.instance_id }}',
    nodeName: '{{ v1.local_hostname }}',
  }),

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
