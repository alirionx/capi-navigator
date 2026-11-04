import { PROXMOX_CREDENTIAL_ANNOTATION } from '../credentials.js';
import { PROXMOX_LB_ADDRESSES_ANNOTATION, PROXMOX_STORAGE_LABEL } from './addons.js';
import type { ManifestObject } from '../operator-manifests.js';
import type { InfraTransformPlugin } from './plugins.js';
import { HOSTED_ON_LABEL, type MachineGroup, type ProxmoxInfra } from './spec.js';
import {
  formatIpv4,
  ipv4RangesCover,
  ipv4RangesOverlap,
  ipv4StartEndRanges,
  parseIpv4Cidr,
  parseIpv4Range,
} from './cidr.js';
import { airGapDnsWarnings, publicResolvers } from './air-gap.js';
import { compact } from './util.js';

/**
 * Proxmox VE (CAPMOX v0.9.1, infrastructure.cluster.x-k8s.io/v1alpha2, CAPI v1beta2 contract;
 * ADR-0027). Field names verified against the CRDs of the release and live in the FP-31 spike.
 * No load balancer: the distributions hold the API endpoint with kube-vip (`apiVip`). No flavors:
 * sizes come from the credential (FP31-F-04). Node addresses come from the in-cluster IPAM pool
 * CAPMOX creates from `ipv4Config`.
 */
export const PROXMOX_API_VERSION = 'infrastructure.cluster.x-k8s.io/v1alpha2';

/** Root disk when the group sets none; templates of cloud images are only a few GB. */
export const PROXMOX_DEFAULT_ROOT_GB = 40;

/** The cluster's copy of the credentials Secret, owned and deleted by CAPMOX (FP31-F-09). */
export const proxmoxCredentialsCopyName = (cluster: string) => `${cluster}-proxmox-credentials`;

/**
 * Secret on the management cluster with the manifest of kube-system/proxmox-cloud-config, which
 * a ClusterResourceSet applies into the workload cluster for CCM and CSI (FP31-F-11).
 */
export const proxmoxCloudConfigName = (cluster: string) => `${cluster}-proxmox-cloud-config`;

/** Template disks the wizard offers; cloud images are attached as one of these. */
export const PROXMOX_BOOT_DISKS = ['scsi0', 'virtio0', 'sata0'] as const;

/** Spike: qemu-guest-agent on first boot is enough, no custom template needed (FP31-F-10). */
const GUEST_AGENT = `if command -v apt-get >/dev/null; then apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q qemu-guest-agent; elif command -v dnf >/dev/null; then dnf install -y qemu-guest-agent; fi; systemctl enable --now qemu-guest-agent || true`;

/** Size of a group from the credential's sizes. */
function sizeOf(group: MachineGroup, sizes: { name: string; vcpus: number; memoryMiB: number }[]) {
  return sizes.find((s) => s.name === group.machineSize);
}

export const proxmoxPlugin: InfraTransformPlugin<ProxmoxInfra> = {
  provider: 'proxmox',
  infraClusterKind: 'ProxmoxCluster',
  machineTemplateKind: 'ProxmoxMachineTemplate',
  apiVersion: PROXMOX_API_VERSION,

  form: {
    displayName: 'Proxmox VE',
    lookups: [
      { kind: 'machineSizes' },
      { kind: 'nodes' },
      { kind: 'templates' },
      { kind: 'storages' },
      { kind: 'bridges' },
    ],
    // Bridges and storages are listed per node.
    regionField: 'sourceNode',
    fields: [
      {
        path: 'sourceNode',
        kind: 'select',
        lookup: 'nodes',
        label: 'wizard.pveSourceNode',
        hint: 'wizard.pveSourceNodeHint',
        resets: ['storage', 'bridge'],
        cols: 4,
        testId: 'pve-source-node',
      },
      {
        path: 'image',
        kind: 'autocomplete',
        lookup: 'templates',
        label: 'wizard.pveTemplate',
        hint: 'wizard.pveTemplateHint',
        // A template without warnings (no cloud-init drive, guest agent on).
        preselect: (options) => options.find((o) => !o.details?.warning)?.value,
        // CAPMOX grows only this disk to the root disk size (FP31-F-05).
        fills: { bootDisk: 'bootDisk' },
        cols: 5,
        testId: 'image',
      },
      {
        path: 'bootDisk',
        kind: 'select',
        options: PROXMOX_BOOT_DISKS,
        label: 'wizard.pveBootDisk',
        hint: 'wizard.pveBootDiskHint',
        default: 'scsi0',
        cols: 3,
        testId: 'pve-boot-disk',
      },
      {
        path: 'storage',
        kind: 'select',
        lookup: 'storages',
        label: 'wizard.pveStorage',
        hint: 'wizard.pveStorageHint',
        cols: 4,
        testId: 'pve-storage',
      },
      {
        path: 'bridge',
        kind: 'select',
        lookup: 'bridges',
        label: 'wizard.pveBridge',
        hint: 'wizard.pveBridgeHint',
        default: 'vmbr0',
        cols: 4,
        testId: 'pve-bridge',
      },
      {
        path: 'memoryAdjustment',
        kind: 'number',
        label: 'wizard.pveMemoryAdjustment',
        hint: 'wizard.pveMemoryAdjustmentHint',
        default: 0,
        cols: 4,
        // FP-33: CAPMOX reads schedulerHints when it places a new VM.
        day2: { note: 'day2.infraNoteNewVms' },
      },
      {
        path: 'network.nodeCidr',
        kind: 'text',
        label: 'wizard.pveNodeCidr',
        hint: 'wizard.pveNodeCidrHint',
        cols: 4,
        testId: 'pve-node-cidr',
      },
      {
        path: 'network.gateway',
        kind: 'text',
        label: 'wizard.pveGateway',
        hint: 'wizard.pveGatewayHint',
        cols: 4,
        testId: 'pve-gateway',
      },
      {
        path: 'network.dnsNameservers',
        kind: 'list',
        airGapWarning: (v) =>
          publicResolvers(v as string[] | string).length ? 'wizard.dnsPublicAirGapped' : undefined,
        label: 'wizard.dns',
        hint: 'wizard.pveDnsHint',
        default: '1.1.1.1, 8.8.8.8',
        cols: 4,
        // Written into the network configuration of new VMs only.
        day2: { note: 'day2.infraNoteRebuild' },
      },
      {
        path: 'network.addresses',
        kind: 'list',
        label: 'wizard.pveAddresses',
        hint: 'wizard.pveAddressesHint',
        cols: 8,
        testId: 'pve-addresses',
        // CAPMOX updates its InClusterIPPool; the IPAM webhook refuses to drop addresses in use,
        // which CAPMOX would retry forever, so addresses can only be added.
        day2: {
          note: 'day2.infraNoteAddresses',
          check: (before, after) => {
            const kept = (after ?? []) as string[];
            const lost = ((before ?? []) as string[]).filter((r) => !ipv4RangesCover(kept, r));
            return lost.length
              ? `Node addresses can only be added: ${lost.join(', ')} must stay in the list (machines may use them).`
              : undefined;
          },
        },
      },
      {
        path: 'network.loadBalancerAddresses',
        kind: 'list',
        label: 'wizard.pveLoadBalancerAddresses',
        hint: 'wizard.pveLoadBalancerAddressesHint',
        clearable: true,
        cols: 8,
        testId: 'pve-lb-addresses',
        // FP32-F-05: the presets follow the range (Helm upgrade); Services keep addresses they
        // already have, so ranges can be added, or all removed to switch the feature off.
        day2: {
          note: 'day2.infraNoteLoadBalancer',
          check: (before, after) => {
            const kept = (after ?? []) as string[];
            if (!kept.length) return undefined;
            const lost = ((before ?? []) as string[]).filter((r) => !ipv4RangesCover(kept, r));
            return lost.length
              ? `LoadBalancer addresses can only be added, or all removed: ${lost.join(', ')} must stay in the list (Services may use them).`
              : undefined;
          },
        },
      },
      {
        path: 'apiEndpoint',
        kind: 'text',
        label: 'wizard.pveApiEndpoint',
        hint: 'wizard.pveApiEndpointHint',
        cols: 4,
        testId: 'pve-api-endpoint',
      },
      {
        path: 'allowedNodes',
        kind: 'list',
        label: 'wizard.pveAllowedNodes',
        hint: 'wizard.pveAllowedNodesHint',
        clearable: true,
        cols: 12,
        day2: { note: 'day2.infraNoteNewVms' },
      },
    ],
    notes: ['wizard.pveVipInfo'],
    machine: {
      sizeLookup: 'machineSizes',
      sizeLabel: 'wizard.machineSize.proxmox',
      target: 'ProxmoxMachineTemplate',
      sizeField: 'numCores, memoryMiB',
      rootVolume: {
        defaultGB: PROXMOX_DEFAULT_ROOT_GB,
        sizeHint: 'wizard.rootVolumeHintProxmox',
        types: { options: [] },
        typeHint: 'wizard.rootVolumeTypeProxmox',
      },
    },
  },

  apiVip: (infra) => infra.apiEndpoint,

  // FP29-F-15: air-gapped clusters need the agent in the template.
  onlineNodePreparation: [GUEST_AGENT],

  // The source address towards the gateway, which is always on the node's network. The Proxmox
  // CCM then sets it as InternalIP (network mode "default"); its guest agent mode also reports
  // the VIP and CNI addresses, and its exclusions do not take effect in v0.16.1.
  nodeAddressCommand: (infra) =>
    `ip -4 -o route get ${infra.network.gateway} | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p'`,

  infraCluster(spec, infra, _ctx, labels) {
    const hosted = spec.topology.mode === 'hosted';
    return {
      apiVersion: PROXMOX_API_VERSION,
      kind: 'ProxmoxCluster',
      metadata: {
        name: spec.name,
        namespace: spec.namespace,
        labels,
        annotations: {
          // Clusters reference a copy of the Secret; this names the stored credential (FP31-F-09).
          [PROXMOX_CREDENTIAL_ANNOTATION]: infra.credentialRef,
          // FP24-F-08: the tenant's endpoint is an address of its host's LoadBalancer range.
          ...(hosted ? { [HOSTED_ON_LABEL]: spec.topology.hosted!.host } : {}),
          // FP32-F-04: read by the kube-vip-cloud-provider preset and other clusters' checks.
          ...(infra.network.loadBalancerAddresses?.length
            ? {
                [PROXMOX_LB_ADDRESSES_ANNOTATION]: ipv4StartEndRanges(
                  infra.network.loadBalancerAddresses,
                ),
              }
            : {}),
        },
      },
      spec: {
        // FP24-F-05: CAPMOX v0.9.1 waits for the endpoint k0smotron writes and skips its checks.
        ...(hosted
          ? { externalManagedControlPlane: true }
          : { controlPlaneEndpoint: { host: infra.apiEndpoint, port: 6443 } }),
        // CAPMOX creates the InClusterIPPool from this (FP31-F-06).
        ipv4Config: {
          addresses: infra.network.addresses,
          prefix: Number(infra.network.nodeCidr.split('/')[1]),
          gateway: infra.network.gateway,
        },
        dnsServers: infra.network.dnsNameservers,
        allowedNodes: infra.allowedNodes?.length ? infra.allowedNodes : [infra.sourceNode],
        schedulerHints: { memoryAdjustment: infra.memoryAdjustment },
        credentialsRef: { name: proxmoxCredentialsCopyName(spec.name), namespace: spec.namespace },
      },
    };
  },

  machineTemplateSpec(_spec, infra, group, _role, ctx) {
    const size = sizeOf(group, ctx?.credential.machineSizes ?? []);
    return compact({
      sourceNode: infra.sourceNode,
      templateID: Number(group.image ?? infra.image),
      full: true,
      storage: infra.storage,
      numSockets: 1,
      numCores: size?.vcpus,
      memoryMiB: size?.memoryMiB,
      disks: {
        bootVolume: {
          disk: infra.bootDisk,
          sizeGb: group.rootVolumeSizeGB ?? PROXMOX_DEFAULT_ROOT_GB,
        },
      },
      network: {
        networkDevices: [
          { name: 'net0', bridge: infra.bridge, model: 'virtio', defaultIPv4: true },
        ],
      },
      vmIDRange: infra.vmIdRange,
      tags: ['capi-navigator'],
    });
  },

  // FP-29: the nodes resolve the internal registry with these servers.
  warnings: (spec, infra) => airGapDnsWarnings(spec, infra.network.dnsNameservers),

  // FP24-F-06: kube-vip announces a Service only once it has endpoints, k0smotron creates the pods
  // only once the Service has an address; a fixed one (the tenant's apiEndpoint) breaks the cycle.
  hosted: {
    endpoint: (infra) => ({
      externalAddress: infra.apiEndpoint,
      serviceAnnotations: { 'kube-vip.io/loadbalancerIPs': infra.apiEndpoint },
    }),
  },

  validate(spec, _infra, ctx) {
    const sizes = ctx.credential.machineSizes ?? [];
    const groups =
      spec.topology.mode === 'hosted'
        ? spec.topology.workerPools
        : [spec.topology.controlPlane, ...spec.topology.workerPools];
    const unknown = [...new Set(groups.map((g) => g.machineSize))].filter(
      (name) => !sizes.some((s) => s.name === name),
    );
    return unknown.length
      ? [
          `Machine size ${unknown.join(', ')} is not defined in the Proxmox VE credential; add it there (Credentials page) or choose another size.`,
        ]
      : [];
  },

  addressConflicts(spec, infra, others) {
    const out: string[] = [];
    for (const o of others) {
      const meta = (o.metadata ?? {}) as { name?: string; namespace?: string };
      if (meta.name === spec.name && meta.namespace === spec.namespace) continue;
      const annotations = ((o.metadata ?? {}) as { annotations?: Record<string, string> })
        .annotations;
      const { theirs, theirLb, theirEndpoint } = addressesOf(o);
      const myLb = infra.network.loadBalancerAddresses ?? [];
      const mine = [...infra.network.addresses, infra.apiEndpoint, ...myLb];
      // FP24-F-08: a hosted tenant's endpoint lies in its host's LoadBalancer range, by design.
      const sameNs = meta.namespace === spec.namespace;
      const myHost = sameNs && spec.topology.hosted?.host === meta.name;
      const myTenant = sameNs && annotations?.[HOSTED_ON_LABEL] === spec.name;
      const intended = (m: string, t: string) =>
        (myHost && m === infra.apiEndpoint && theirLb.includes(t)) ||
        (myTenant && t === theirEndpoint && myLb.includes(m));
      const clash = mine.filter((m) =>
        theirs.some((t) => ipv4RangesOverlap(m, t) && !intended(m, t)),
      );
      if (clash.length) {
        out.push(
          `${clash.join(', ')} overlap${clash.length === 1 ? 's' : ''} with the addresses of cluster ${meta.namespace}/${meta.name}; choose addresses no other cluster uses.`,
        );
      }
    }
    return out;
  },

  // FP34-F-14: blueprint clusters take their API, node and LoadBalancer addresses from a pool.
  addressPool: {
    used: (others) => others.flatMap((o) => addressesOf(o).theirs),
    assign(spec, infra, pool, used) {
      const hosted = spec.topology.mode === 'hosted';
      const groups = [
        ...(hosted ? [] : [spec.topology.controlPlane]),
        ...spec.topology.workerPools,
      ];
      // One rollout at a time (FP-7): at most the largest surge of a group in addition.
      const surge = Math.max(
        hosted ? 0 : 1,
        spec.rollout.maxSurge,
        ...spec.topology.workerPools.map((p) => p.rollout?.maxSurge ?? 0),
      );
      const nodes = groups.reduce((n, g) => n + g.replicas, 0) + surge;
      const lb = (infra.network.loadBalancerAddresses ?? []).reduce((n, r) => {
        const range = parseIpv4Range(r);
        return n + (range ? range.end - range.start + 1 : 0);
      }, 0);
      const free = freeAddresses(pool, used, infra.network.nodeCidr, infra.network.gateway);
      const needed = 1 + nodes + lb;
      if (free.length < needed) {
        return `The address pool has ${free.length} free address(es); the cluster needs ${needed}: the API address, ${nodes} node addresses (including ${surge} for rollouts)${lb ? ` and ${lb} LoadBalancer addresses` : ''}.`;
      }
      return {
        ...infra,
        apiEndpoint: formatIpv4(free[0]!),
        network: {
          ...infra.network,
          addresses: toRanges(free.slice(1, 1 + nodes)),
          ...(lb ? { loadBalancerAddresses: toRanges(free.slice(1 + nodes, needed)) } : {}),
        },
      };
    },
  },

  // CAPMOX sets the machine's providerID to the VM's SMBIOS UUID, which cloud-init reports as
  // instance ID (verified live); the Proxmox CCM understands it with features.provider=capmox.
  nodeIdentity: () => ({
    providerId: 'proxmox://{{ v1.instance_id }}',
    nodeName: '{{ v1.local_hostname }}',
  }),

  resources: {
    infraClusterPlural: 'proxmoxclusters',
    machineKind: 'ProxmoxMachine',
    machinePlural: 'proxmoxmachines',
    machineTemplatePlural: 'proxmoxmachinetemplates',
  },

  machineDetails(s) {
    const cores = s.numCores as number | undefined;
    const memory = s.memoryMiB as number | undefined;
    const boot = (s.disks as { bootVolume?: { sizeGb?: number } } | undefined)?.bootVolume;
    return compact({
      size: cores && memory ? `${cores} vCPU / ${+(memory / 1024).toFixed(1)} GiB` : undefined,
      image: s.templateID !== undefined ? String(s.templateID) : undefined,
      rootVolumeGB: boot?.sizeGb,
    });
  },

  bastionStatus: () => ({}),

  infraFacts: (infra) => [
    { label: 'Proxmox VE node', value: infra.sourceNode },
    ...(infra.allowedNodes?.length
      ? [{ label: 'Allowed nodes', value: infra.allowedNodes.join(', ') }]
      : []),
    { label: 'Storage', value: infra.storage },
    { label: 'Bridge', value: infra.bridge },
    { label: 'Node network', value: infra.network.nodeCidr },
    { label: 'Node addresses', value: infra.network.addresses.join(', ') },
    { label: 'API server', value: `${infra.apiEndpoint} (kube-vip)` },
    ...(infra.network.loadBalancerAddresses?.length
      ? [
          {
            label: 'LoadBalancer addresses',
            value: infra.network.loadBalancerAddresses.join(', '),
          },
        ]
      : []),
  ],

  addonLabels(spec) {
    return {
      ...(spec.addons.cloudControllerManager ? { 'capi-navigator.io/ccm': 'proxmox' } : {}),
      ...(spec.addons.csiDriver ? { 'capi-navigator.io/csi': 'proxmox' } : {}),
      // FP31-F-11: read by the CSI preset for the StorageClass of this cluster.
      ...(spec.addons.csiDriver && spec.infrastructure.provider === 'proxmox'
        ? { [PROXMOX_STORAGE_LABEL]: spec.infrastructure.storage }
        : {}),
      // FP32-F-03: selects the kube-vip presets for LoadBalancer Services.
      ...(spec.infrastructure.provider === 'proxmox' &&
      spec.infrastructure.network.loadBalancerAddresses?.length
        ? { 'capi-navigator.io/loadbalancer': 'proxmox' }
        : {}),
    };
  },

  extraObjects(spec, _infra, labels): ManifestObject[] {
    if (!spec.addons.cloudControllerManager && !spec.addons.csiDriver) return [];
    // Delivers kube-system/proxmox-cloud-config; the backend builds the Secret with its content
    // from the stored credential (as ADR-0004, hard rule 8).
    return [
      {
        apiVersion: 'addons.cluster.x-k8s.io/v1beta2',
        kind: 'ClusterResourceSet',
        metadata: { name: proxmoxCloudConfigName(spec.name), namespace: spec.namespace, labels },
        spec: {
          clusterSelector: { matchLabels: { 'cluster.x-k8s.io/cluster-name': spec.name } },
          resources: [{ kind: 'Secret', name: proxmoxCloudConfigName(spec.name) }],
          strategy: 'Reconcile',
        },
      },
    ];
  },
};

/** Addresses an infrastructure cluster uses: nodes, API endpoint and LoadBalancer ranges. */
function addressesOf(o: Record<string, unknown>) {
  const s = (o.spec ?? {}) as {
    ipv4Config?: { addresses?: string[] };
    controlPlaneEndpoint?: { host?: string };
  };
  const annotations = ((o.metadata ?? {}) as { annotations?: Record<string, string> }).annotations;
  // FP32-F-02: their LoadBalancer addresses.
  const theirLb = annotations?.[PROXMOX_LB_ADDRESSES_ANNOTATION]?.split(',') ?? [];
  const theirEndpoint = s.controlPlaneEndpoint?.host ?? '';
  const theirs = [...(s.ipv4Config?.addresses ?? []), theirEndpoint, ...theirLb].filter(Boolean);
  return { theirs, theirLb, theirEndpoint };
}

/** Addresses of the pool in the node network, without the gateway and used ones, ascending. */
function freeAddresses(pool: string[], used: string[], cidr: string, gateway: string): number[] {
  const net = parseIpv4Cidr(cidr);
  const taken = [...used, gateway].map(parseIpv4Range).filter((r) => !!r);
  const out = new Set<number>();
  for (const r of pool.map(parseIpv4Range)) {
    if (!r || !net) continue;
    // Not the network and broadcast address; at most a /16 per range.
    const start = Math.max(r.start, net.start + 1);
    const end = Math.min(r.end, net.end - 1, start + 65_535);
    for (let ip = start; ip <= end; ip++) {
      if (!taken.some((t) => t.start <= ip && ip <= t.end)) out.add(ip);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Consecutive addresses as ranges ("a-b", or "a" alone). */
function toRanges(ips: number[]): string[] {
  const out: string[] = [];
  let start = ips[0];
  for (let i = 0; i < ips.length; i++) {
    const ip = ips[i]!;
    if (ips[i + 1] === ip + 1) continue;
    out.push(start === ip ? formatIpv4(ip) : `${formatIpv4(start!)}-${formatIpv4(ip)}`);
    start = ips[i + 1];
  }
  return out;
}
