import { CHECK_NEUTRON_PAGING } from '../credentials.js';
import type { ManifestObject } from '../operator-manifests.js';
import { VOLUME_TOPOLOGY_LABEL } from './addons.js';
import { airGapDnsWarnings, publicResolvers } from './air-gap.js';
import { cidrsOverlap, formatIpv4, freeCidr, freeCidrInPool, parseIpv4Cidr } from './cidr.js';
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
      // FP5-F-21: only a suggestion, the default stays if the list is not available.
      { kind: 'subnets', optional: true },
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
        lookup: 'subnets',
        suggest: (subnets) =>
          freeCidr(
            '10.6.0.0/24',
            subnets.map((s) => s.value),
          ),
        cols: 4,
      },
      {
        path: 'network.dnsNameservers',
        kind: 'list',
        airGapWarning: (v) =>
          publicResolvers(v as string[] | string).length ? 'wizard.dnsPublicAirGapped' : undefined,
        label: 'wizard.dns',
        hint: 'wizard.dnsHint',
        default: '1.1.1.1, 8.8.8.8',
        cols: 4,
        // FP-33: CAPO v0.15 allows it on managedSubnets and updates the Neutron subnet; nodes get
        // it with their next DHCP lease.
        day2: { note: 'day2.infraNoteDhcp' },
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
        path: 'zoneBoundVolumes',
        kind: 'switch',
        label: 'wizard.zoneBoundVolumes',
        hint: 'wizard.zoneBoundVolumesHint',
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
    const hosted = spec.topology.mode === 'hosted';
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
        // FP24-F-05: a hosted control plane's endpoint is in the host; without load balancer and
        // floating IP, CAPO waits for the one k0smotron writes (reconcileControlPlaneEndpoint,
        // CAPO v0.15.1).
        apiServer: hosted
          ? { enableFloatingIP: false }
          : infra.apiServerLoadBalancer
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

  // FP24-F-05, ADR-0034: the endpoint comes from k0smotron.
  hosted: {},

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

  // FP-29: the nodes resolve the internal registry with the subnet's DNS servers.
  warnings: (spec, infra) => airGapDnsWarnings(spec, infra.network.dnsNameservers),

  // FP5-F-21: every cluster has its own network and router, but some clouds refuse overlapping
  // subnets (seen on a restricted OpenStack), so the preview names them without blocking.
  addressWarnings(spec, infra, others) {
    return others.flatMap((o) => {
      const meta = (o.metadata ?? {}) as { name?: string; namespace?: string };
      if (meta.name === spec.name && meta.namespace === spec.namespace) return [];
      const theirs = (o.spec ?? {}) as {
        identityRef?: { name?: string };
        managedSubnets?: { cidr?: string }[];
      };
      if (theirs.identityRef?.name !== infra.credentialRef) return [];
      const clash = (theirs.managedSubnets ?? []).find(
        (s) => s.cidr && cidrsOverlap(s.cidr, infra.network.nodeCidr),
      );
      return clash
        ? [
            `Subnet CIDR ${infra.network.nodeCidr} overlaps ${clash.cidr} of cluster ${meta.namespace}/${meta.name} with the same credentials. Some clouds refuse overlapping subnets in a project (e.g. with a routed VRF per project) and the cluster then never comes up; choose another node network if yours does.`,
          ]
        : [];
    });
  },

  // FP34-F-15: a blueprint may carry a pool of node networks (suggested for new blueprints); every
  // cluster gets a network of the base spec's size that neither a subnet of the project nor
  // another OpenStack cluster uses.
  addressPool: {
    kind: 'networks',
    required: false,
    hosted: true,
    lookup: 'subnets',
    // Separate networks per cluster are good practice: routing between networks of a project (or
    // to a VPN) needs them, and some clouds require them. Suggested: the /16 of the node network.
    suggest(infra) {
      const net = parseIpv4Cidr(infra.network.nodeCidr);
      if (!net) return [];
      if (net.prefix <= 16) return [infra.network.nodeCidr];
      return [`${formatIpv4(net.start - (net.start % 65536))}/16`];
    },
    exhaustedHint:
      'Add networks to the node network pool of the blueprint, or delete clusters created from it. A deleted cluster frees its network once CAPO has removed the subnet.',
    issues(spec, infra, pool) {
      const prefix = parseIpv4Cidr(infra.network.nodeCidr)?.prefix ?? 24;
      const out: string[] = [];
      for (const entry of pool) {
        const net = parseIpv4Cidr(entry);
        if (!net) {
          out.push(`${entry} is no network: give networks like 10.7.0.0/16`);
        } else if (net.prefix > prefix) {
          out.push(`${entry} is smaller than the node network of the base spec (/${prefix})`);
        }
        for (const [label, cidr] of [
          ['pod network', spec.kubernetes.podCidr],
          ['service network', spec.kubernetes.serviceCidr],
        ] as const) {
          if (net && cidrsOverlap(entry, cidr)) {
            out.push(`${entry} overlaps the ${label} (${cidr})`);
          }
        }
      }
      return out;
    },
    // All OpenStack clusters, not only those of the same credentials: at worst a network stays
    // unused that another project could have had, but two clusters never share one (ADR-0038).
    used: (others) =>
      others.flatMap((o) =>
        (((o.spec ?? {}) as { managedSubnets?: { cidr?: string }[] }).managedSubnets ?? []).flatMap(
          (s) => (s.cidr ? [s.cidr] : []),
        ),
      ),
    assign(_spec, infra, pool, used) {
      const prefix = parseIpv4Cidr(infra.network.nodeCidr)?.prefix ?? 24;
      const nodeCidr = freeCidrInPool(pool, prefix, used);
      if (!nodeCidr) {
        return `The node network pool ${pool.join(', ')} has no free /${prefix} network left: every one overlaps a subnet of the project or the node network of another OpenStack cluster.`;
      }
      return { ...infra, network: { ...infra.network, nodeCidr } };
    },
  },

  infraFacts: (infra) => [
    { label: 'Node network', value: infra.network.nodeCidr },
    { label: 'External network', value: infra.externalNetwork },
    {
      label: 'API server',
      value: infra.apiServerLoadBalancer ? 'Octavia load balancer' : 'Floating IP',
    },
    ...(infra.failureDomain ? [{ label: 'Availability zone', value: infra.failureDomain }] : []),
    ...(infra.zoneBoundVolumes === false
      ? [{ label: 'Volumes', value: 'not bound to an availability zone' }]
      : []),
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
      // ADR-0026: read by the Cinder CSI preset per cluster.
      ...(spec.addons.csiDriver &&
      spec.infrastructure.provider === 'openstack' &&
      !spec.infrastructure.zoneBoundVolumes
        ? { [VOLUME_TOPOLOGY_LABEL]: 'off' }
        : {}),
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
