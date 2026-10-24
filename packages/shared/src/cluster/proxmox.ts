import { PROXMOX_CREDENTIAL_ANNOTATION } from '../credentials.js';
import { PROXMOX_STORAGE_LABEL } from './addons.js';
import type { ManifestObject } from '../operator-manifests.js';
import type { InfraTransformPlugin } from './plugins.js';
import type { MachineGroup, ProxmoxInfra } from './spec.js';
import { ipv4RangesOverlap } from './cidr.js';
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
        label: 'wizard.dns',
        hint: 'wizard.pveDnsHint',
        default: '1.1.1.1, 8.8.8.8',
        cols: 4,
      },
      {
        path: 'network.addresses',
        kind: 'list',
        label: 'wizard.pveAddresses',
        hint: 'wizard.pveAddressesHint',
        cols: 8,
        testId: 'pve-addresses',
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

  nodePreparation: [GUEST_AGENT],

  // The source address towards the gateway, which is always on the node's network. The Proxmox
  // CCM then sets it as InternalIP (network mode "default"); its guest agent mode also reports
  // the VIP and CNI addresses, and its exclusions do not take effect in v0.16.1.
  nodeAddressCommand: (infra) =>
    `ip -4 -o route get ${infra.network.gateway} | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p'`,

  infraCluster(spec, infra, _ctx, labels) {
    return {
      apiVersion: PROXMOX_API_VERSION,
      kind: 'ProxmoxCluster',
      metadata: {
        name: spec.name,
        namespace: spec.namespace,
        labels,
        // Clusters reference a copy of the Secret; this names the stored credential (FP31-F-09).
        annotations: { [PROXMOX_CREDENTIAL_ANNOTATION]: infra.credentialRef },
      },
      spec: {
        controlPlaneEndpoint: { host: infra.apiEndpoint, port: 6443 },
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

  validate(spec, _infra, ctx) {
    const sizes = ctx.credential.machineSizes ?? [];
    const groups = [spec.topology.controlPlane, ...spec.topology.workerPools];
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
      const s = (o.spec ?? {}) as {
        ipv4Config?: { addresses?: string[] };
        controlPlaneEndpoint?: { host?: string };
      };
      const theirs = [
        ...(s.ipv4Config?.addresses ?? []),
        s.controlPlaneEndpoint?.host ?? '',
      ].filter(Boolean);
      const mine = [...infra.network.addresses, infra.apiEndpoint];
      const clash = mine.filter((m) => theirs.some((t) => ipv4RangesOverlap(m, t)));
      if (clash.length) {
        out.push(
          `${clash.join(', ')} overlap${clash.length === 1 ? 's' : ''} with the addresses of cluster ${meta.namespace}/${meta.name}; choose addresses no other cluster uses.`,
        );
      }
    }
    return out;
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
  ],

  addonLabels(spec) {
    return {
      ...(spec.addons.cloudControllerManager ? { 'capi-navigator.io/ccm': 'proxmox' } : {}),
      ...(spec.addons.csiDriver ? { 'capi-navigator.io/csi': 'proxmox' } : {}),
      // FP31-F-11: read by the CSI preset for the StorageClass of this cluster.
      ...(spec.addons.csiDriver && spec.infrastructure.provider === 'proxmox'
        ? { [PROXMOX_STORAGE_LABEL]: spec.infrastructure.storage }
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
