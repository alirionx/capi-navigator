import { z } from 'zod';
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, type ManifestObject } from '../operator-manifests.js';
import { VERSIONS } from '../versions.generated.js';
import { GCP_MANIFEST_ADDONS } from './gcp-addons.js';
import type { ManifestAddon } from './manifest-addons.js';

/**
 * Cluster label that switches off the zone binding of Cinder volumes (ADR-0026); the preset reads
 * it per cluster, so one preset per namespace serves clusters with either setting.
 */
export const VOLUME_TOPOLOGY_LABEL = 'capi-navigator.io/volume-topology';

/**
 * CCM and CSI presets as HelmChartProxy (CAAPH, addons.cluster.x-k8s.io/v1alpha1), one set per
 * namespace, selecting clusters by add-on label (FP5-F-09, FP5-F-17). Charts and versions live in
 * versions.yaml (addonPresets); value keys were verified against the charts' values.yaml.
 *
 * RKE2 and k0s label control plane nodes with node-role.kubernetes.io/control-plane="true",
 * kubeadm with "" – the selector value is rendered per cluster from its control plane kind.
 */
export interface AddonPreset {
  id: string;
  /** Cloud of the preset; `any` for cloud-independent presets (kured). */
  provider: 'openstack' | 'aws' | 'proxmox' | 'any';
  kind: 'ccm' | 'csi' | 'reboot' | 'cni' | 'loadbalancer';
  displayName: string;
  repoURL: string;
  chartName: string;
  version: string;
  releaseNamespace: string;
  /** Cluster label that selects the preset; default capi-navigator.io/<kind>=<provider or id>. */
  selector?: [string, string];
  /** CAAPH Go template; `{{ .Cluster.metadata.name }}` is the workload cluster name, `.InfraCluster` its infra cluster. */
  valuesTemplate: string;
}

/** Value of the control plane node label per distribution (CAAPH template, FP10-F-06). */
const CP_LABEL_VALUE = `'{{ if eq .ControlPlane.kind "KubeadmControlPlane" }}{{ else }}true{{ end }}'`;
const CP_SELECTOR = `nodeSelector:\n  node-role.kubernetes.io/control-plane: ${CP_LABEL_VALUE}\n`;

/** Cluster label with the storage the Proxmox CSI preset uses for its StorageClass (FP31-F-11). */
export const PROXMOX_STORAGE_LABEL = 'capi-navigator.io/proxmox-storage';
/** Secret in kube-system of the workload cluster with config.yaml and ca.crt for CCM and CSI. */
export const PROXMOX_CLOUD_CONFIG_SECRET = 'proxmox-cloud-config';

/**
 * Annotation on the ProxmoxCluster with its LoadBalancer addresses as "start-end" ranges; read by
 * the kube-vip-cloud-provider preset and by the overlap check of other clusters (FP32-F-04).
 */
export const PROXMOX_LB_ADDRESSES_ANNOTATION = 'capi-navigator.io/loadbalancer-addresses';

/** A container image pinned in versions.yaml as Helm values. */
function imageValues(entry: { version: string; source: { package: string; registry?: string } }) {
  return `image:\n  repository: ${entry.source.registry}/${entry.source.package}\n  tag: ${entry.version}\n`;
}

/** An OCI chart pinned as image (datasource docker): repository URL and chart name. */
function ociChart(entry: { source: { package: string; registry?: string } }) {
  const parts = entry.source.package.split('/');
  return {
    repoURL: `oci://${entry.source.registry}/${parts.slice(0, -1).join('/')}`,
    chartName: parts[parts.length - 1]!,
  };
}

/**
 * Proxmox CA bundle for CCM and CSI: the Secret's ca.crt (the cluster's CA plus public roots)
 * replaces the container's trust store, as the charts document.
 */
const PROXMOX_CA_VOLUME = [
  'extraVolumes:\n',
  `  - name: proxmox-ca\n    secret:\n      secretName: ${PROXMOX_CLOUD_CONFIG_SECRET}\n      items:\n        - key: ca.crt\n          path: ca.crt\n`,
  'extraVolumeMounts:\n',
  '  - name: proxmox-ca\n    mountPath: /etc/ssl/certs/ca-certificates.crt\n    subPath: ca.crt\n    readOnly: true\n',
].join('');

export const ADDON_PRESETS: AddonPreset[] = [
  {
    id: 'openstack-ccm',
    provider: 'openstack',
    kind: 'ccm',
    displayName: 'OpenStack Cloud Controller Manager',
    repoURL: VERSIONS.addonPresets['openstack-ccm'].source.registry!,
    chartName: VERSIONS.addonPresets['openstack-ccm'].source.package,
    version: VERSIONS.addonPresets['openstack-ccm'].version,
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      CP_SELECTOR,
      // The cloud config comes from kube-system/cloud-config, delivered by a ClusterResourceSet (ADR-0004).
      'secret:\n  enabled: true\n  create: false\n  name: cloud-config\n',
      'cluster:\n  name: {{ .Cluster.metadata.name }}\n',
      // RKE2 has no /etc/kubernetes/pki; the config is read from the Secret.
      'extraVolumes: []\nextraVolumeMounts: []\n',
      // The CCM runs before cluster DNS works (nodes are still uninitialized): use the node's DNS.
      'dnsPolicy: Default\n',
    ].join(''),
  },
  {
    id: 'openstack-csi',
    provider: 'openstack',
    kind: 'csi',
    displayName: 'OpenStack Cinder CSI',
    repoURL: VERSIONS.addonPresets['openstack-csi'].source.registry!,
    chartName: VERSIONS.addonPresets['openstack-csi'].source.package,
    version: VERSIONS.addonPresets['openstack-csi'].version,
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      'secret:\n  enabled: true\n  create: false\n  name: cloud-config\n  filename: cloud.conf\n',
      // Default class binds when the pod is scheduled: Cinder volumes cannot be attached across
      // availability zones (seen on Infomaniak), and the chart's own classes bind immediately.
      'storageClass:\n  enabled: true\n  delete:\n    isDefault: false\n    allowVolumeExpansion: true\n',
      '  custom: |-\n',
      '    apiVersion: storage.k8s.io/v1\n    kind: StorageClass\n    metadata:\n      name: csi-cinder-sc-wait\n',
      '      annotations:\n        storageclass.kubernetes.io/is-default-class: "true"\n',
      '    provisioner: cinder.csi.openstack.org\n    reclaimPolicy: Delete\n',
      '    volumeBindingMode: WaitForFirstConsumer\n    allowVolumeExpansion: true\n',
      'clusterID: {{ .Cluster.metadata.name }}\n',
      // ADR-0026: `--with-topology` of both plugins; off when the cluster asks for it.
      `csi:\n  provisioner:\n    topology: '{{ if eq (index .Cluster.metadata.labels "${VOLUME_TOPOLOGY_LABEL}") "off" }}false{{ else }}true{{ end }}'\n`,
    ].join(''),
  },
  {
    id: 'aws-ccm',
    provider: 'aws',
    kind: 'ccm',
    displayName: 'AWS Cloud Controller Manager',
    repoURL: VERSIONS.addonPresets['aws-ccm'].source.registry!,
    chartName: VERSIONS.addonPresets['aws-ccm'].source.package,
    version: VERSIONS.addonPresets['aws-ccm'].version,
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      CP_SELECTOR,
      // The CCM must run before the pod network: it removes the "uninitialized" taint that Calico
      // Typha does not tolerate. Host networking also reaches IMDS directly.
      'hostNetworking: true\n',
      'args:\n  - --v=2\n  - --cloud-provider=aws\n  - --configure-cloud-routes=false\n',
    ].join(''),
  },
  {
    id: 'aws-csi',
    provider: 'aws',
    kind: 'csi',
    displayName: 'AWS EBS CSI driver',
    repoURL: VERSIONS.addonPresets['aws-csi'].source.registry!,
    chartName: VERSIONS.addonPresets['aws-csi'].source.package,
    version: VERSIONS.addonPresets['aws-csi'].version,
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      // The controller runs on control plane nodes, whose instance profile may manage volumes.
      // The region comes from the AWSCluster instead of an IMDS lookup.
      `controller:\n  region: {{ .InfraCluster.spec.region }}\n  nodeSelector:\n    node-role.kubernetes.io/control-plane: ${CP_LABEL_VALUE}\n`,
      '  tolerations:\n    - key: node-role.kubernetes.io/control-plane\n      operator: Exists\n      effect: NoSchedule\n',
      'storageClasses:\n  - name: ebs-gp3\n    annotations:\n      storageclass.kubernetes.io/is-default-class: "true"\n',
      '    volumeBindingMode: WaitForFirstConsumer\n    allowVolumeExpansion: true\n    parameters:\n      type: gp3\n',
    ].join(''),
  },
  {
    id: 'proxmox-ccm',
    provider: 'proxmox',
    kind: 'ccm',
    displayName: 'Proxmox VE Cloud Controller Manager',
    ...ociChart(VERSIONS.addonPresets['proxmox-ccm']),
    version: VERSIONS.addonPresets['proxmox-ccm'].version,
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      `existingConfigSecret: ${PROXMOX_CLOUD_CONFIG_SECRET}\nexistingConfigSecretKey: config.yaml\n`,
      // As DaemonSet on the control plane nodes with host networking: the CCM removes the
      // "uninitialized" taint before the pod network runs (as for AWS).
      'useDaemonSet: true\n',
      CP_SELECTOR,
      'tolerations:\n  - key: node-role.kubernetes.io/control-plane\n    operator: Exists\n    effect: NoSchedule\n',
      '  - key: node.cloudprovider.kubernetes.io/uninitialized\n    operator: Exists\n    effect: NoSchedule\n',
      PROXMOX_CA_VOLUME,
    ].join(''),
  },
  {
    id: 'proxmox-csi',
    provider: 'proxmox',
    kind: 'csi',
    displayName: 'Proxmox VE CSI plugin',
    ...ociChart(VERSIONS.addonPresets['proxmox-csi']),
    version: VERSIONS.addonPresets['proxmox-csi'].version,
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      `existingConfigSecret: ${PROXMOX_CLOUD_CONFIG_SECRET}\nexistingConfigSecretKey: config.yaml\n`,
      // One StorageClass on the storage chosen for the cluster (label on the Cluster).
      'storageClass:\n  - name: proxmox\n',
      `    storage: '{{ index .Cluster.metadata.labels "${PROXMOX_STORAGE_LABEL}" }}'\n`,
      '    fstype: ext4\n    annotations:\n      storageclass.kubernetes.io/is-default-class: "true"\n',
      // Controller also on control plane nodes (all-in-one), the node plugin on every node.
      'tolerations:\n  - key: node-role.kubernetes.io/control-plane\n    operator: Exists\n    effect: NoSchedule\n',
      'node:\n  tolerations:\n    - operator: Exists\n',
      PROXMOX_CA_VOLUME,
    ].join(''),
  },
  {
    // FP32-F-03 (ADR-0028): kube-vip for Services only, next to the instance that holds the API
    // endpoint (FP31-F-07): same image, metrics on another port, on every node so workers hold
    // addresses too. Values verified against chart 0.11.1; the chart defaults for the control
    // plane load balancer and the interface are dropped (null), as in the FP-32 spike.
    id: 'proxmox-kube-vip',
    provider: 'proxmox',
    kind: 'loadbalancer',
    displayName: 'kube-vip for LoadBalancer Services',
    repoURL: VERSIONS.addonPresets['proxmox-kube-vip'].source.registry!,
    chartName: VERSIONS.addonPresets['proxmox-kube-vip'].source.package,
    version: VERSIONS.addonPresets['proxmox-kube-vip'].version,
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      'nameOverride: kube-vip-svc\n',
      imageValues(VERSIONS.images['kube-vip']),
      'env:\n  vip_interface: null\n  lb_enable: "false"\n  lb_port: null\n  vip_subnet: null\n',
      '  cp_enable: "false"\n  svc_enable: "true"\n  svc_election: "true"\n  vip_arp: "true"\n',
      '  vip_leaseduration: "15"\n  vip_renewdeadline: "10"\n  vip_retryperiod: "2"\n',
      '  prometheus_server: ":2113"\n',
      'envValueFrom:\n  vip_nodename:\n    fieldRef:\n      fieldPath: spec.nodeName\n',
      'tolerations:\n  - operator: Exists\n    effect: NoSchedule\n  - operator: Exists\n    effect: NoExecute\n',
    ].join(''),
  },
  {
    // FP32-F-03/F-04: hands out the cluster's LoadBalancer addresses, read from the annotation on
    // its ProxmoxCluster, so one preset serves every cluster of the namespace. It reads the
    // ConfigMap on every Service sync: a changed range needs no restart. Chart 0.2.10.
    id: 'proxmox-kube-vip-cloud-provider',
    provider: 'proxmox',
    kind: 'loadbalancer',
    displayName: 'kube-vip cloud provider (LoadBalancer addresses)',
    repoURL: VERSIONS.addonPresets['proxmox-kube-vip-cloud-provider'].source.registry!,
    chartName: VERSIONS.addonPresets['proxmox-kube-vip-cloud-provider'].source.package,
    version: VERSIONS.addonPresets['proxmox-kube-vip-cloud-provider'].version,
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      imageValues(VERSIONS.images['kube-vip-cloud-provider']),
      `cm:\n  data:\n    range-global: '{{ index .InfraCluster.metadata.annotations "${PROXMOX_LB_ADDRESSES_ANNOTATION}" }}'\n`,
    ].join(''),
  },
  {
    // Reboots nodes after OS updates (unattended-upgrades writes /var/run/reboot-required), one
    // node at a time with drain, also control plane nodes. The OS update path for distributions
    // whose control plane machines cannot be replaced (ADR-0013). Chart 6.1.0 (kured 1.23.0),
    // values verified against its values.yaml on 2026-10-18.
    id: 'kured',
    provider: 'any',
    kind: 'reboot',
    displayName: 'kured reboot daemon',
    repoURL: VERSIONS.addonPresets['kured'].source.registry!,
    chartName: VERSIONS.addonPresets['kured'].source.package,
    version: VERSIONS.addonPresets['kured'].version,
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      'configuration:\n  concurrency: 1\n  rebootSentinel: /var/run/reboot-required\n',
      'tolerations:\n  - key: node-role.kubernetes.io/control-plane\n    operator: Exists\n    effect: NoSchedule\n',
    ].join(''),
  },
];

/** Cluster label that selects a preset, e.g. capi-navigator.io/ccm=openstack. */
export function presetSelector(preset: AddonPreset): [string, string] {
  if (preset.selector) return preset.selector;
  return [
    `capi-navigator.io/${preset.kind}`,
    preset.provider === 'any' ? preset.id : preset.provider,
  ];
}

/** Label for the CNI preset of distributions without a built-in CNI (FP10-F-04). */
export const CNI_LABEL: [string, string] = ['capi-navigator.io/cni', 'calico'];

/** Label for the reboot daemon preset, set by the transformation when enabled (FP9, ADR-0013). */
export const REBOOT_DAEMON_LABEL: [string, string] = ['capi-navigator.io/reboot', 'kured'];

export function addonPresetName(preset: AddonPreset): string {
  return `capi-navigator-${preset.id}`;
}

/** The HelmChartProxy of a preset in one namespace; selects clusters by add-on label. */
export function buildAddonPreset(preset: AddonPreset, namespace: string): ManifestObject {
  return {
    apiVersion: 'addons.cluster.x-k8s.io/v1alpha1',
    kind: 'HelmChartProxy',
    metadata: {
      name: addonPresetName(preset),
      namespace,
      labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, 'capi-navigator.io/preset': preset.id },
    },
    spec: {
      clusterSelector: { matchLabels: Object.fromEntries([presetSelector(preset)]) },
      repoURL: preset.repoURL,
      chartName: preset.chartName,
      version: preset.version,
      releaseName: preset.chartName,
      namespace: preset.releaseNamespace,
      valuesTemplate: preset.valuesTemplate,
      reconcileStrategy: 'Continuous',
      options: { wait: true, timeout: '10m0s', install: { createNamespace: true } },
    },
  };
}

/**
 * Admin changes to a preset (FP8-F-14), stored in the ConfigMap {@link ADDON_PRESETS_CONFIGMAP} of
 * the home cluster. The defaults above stay in the code; an override replaces version and values.
 */
export const AddonPresetOverrideSchema = z.object({
  version: z.string().trim().min(1).max(128).optional(),
  valuesTemplate: z
    .string()
    .max(256 * 1024)
    .optional(),
});
export type AddonPresetOverride = z.infer<typeof AddonPresetOverrideSchema>;
export const AddonPresetOverridesSchema = z.record(z.string(), AddonPresetOverrideSchema);
export type AddonPresetOverrides = z.infer<typeof AddonPresetOverridesSchema>;
export const ADDON_PRESETS_CONFIGMAP = 'capi-navigator-addon-presets';
export const ADDON_PRESETS_CONFIGMAP_KEY = 'overrides.json';

/** A preset with the admin's override applied. */
export function effectivePreset(
  preset: AddonPreset,
  overrides: AddonPresetOverrides = {},
): AddonPreset {
  const o = overrides[preset.id];
  return {
    ...preset,
    ...(o?.version ? { version: o.version } : {}),
    ...(o?.valuesTemplate !== undefined ? { valuesTemplate: o.valuesTemplate } : {}),
  };
}

/** Presets a cluster needs, from its add-on labels (with overrides applied). */
/** Add-ons without a Helm chart, delivered by ClusterResourceSet (FP25-F-08, ADR-0023). */
export const MANIFEST_ADDONS: ManifestAddon[] = [...GCP_MANIFEST_ADDONS];

/** The manifest add-ons a cluster selects with its labels. */
export function manifestAddonsFor(clusterLabels: Record<string, string>): ManifestAddon[] {
  return MANIFEST_ADDONS.filter(({ label: [key, value] }) => clusterLabels[key] === value);
}

export function presetsFor(
  clusterLabels: Record<string, string>,
  overrides: AddonPresetOverrides = {},
): AddonPreset[] {
  return ADDON_PRESETS.filter((p) => {
    const [key, value] = presetSelector(p);
    return clusterLabels[key] === value;
  }).map((p) => effectivePreset(p, overrides));
}

/** A preset in one namespace of a management cluster (FP8-F-14). */
export const AddonPresetNamespaceSchema = z.object({
  namespace: z.string(),
  /** Matches the effective preset. */
  upToDate: z.boolean(),
  /** Only the app changed it; otherwise it is left alone. */
  managedByApp: z.boolean(),
  clusters: z.number(),
});

export const AddonPresetViewSchema = z.object({
  id: z.string(),
  provider: z.string(),
  kind: z.string(),
  displayName: z.string(),
  repoURL: z.string(),
  chartName: z.string(),
  releaseNamespace: z.string(),
  defaults: z.object({ version: z.string(), valuesTemplate: z.string() }),
  override: AddonPresetOverrideSchema.optional(),
  effective: z.object({ version: z.string(), valuesTemplate: z.string() }),
  namespaces: z.array(AddonPresetNamespaceSchema),
});
export type AddonPresetView = z.infer<typeof AddonPresetViewSchema>;
