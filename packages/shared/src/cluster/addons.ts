import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, type ManifestObject } from '../operator-manifests.js';

/**
 * CCM and CSI presets as HelmChartProxy (CAAPH v0.6.4, addons.cluster.x-k8s.io/v1alpha1), one set per
 * namespace, selecting clusters by add-on label (FP5-F-09, FP5-F-17). Chart versions verified on
 * 2026-10-17 against the chart repositories; value keys against the charts' values.yaml.
 *
 * RKE2 labels control plane nodes with node-role.kubernetes.io/control-plane="true", while the
 * charts default to "" – hence the nodeSelector overrides.
 */
export interface AddonPreset {
  id: string;
  provider: 'openstack' | 'aws';
  kind: 'ccm' | 'csi';
  displayName: string;
  repoURL: string;
  chartName: string;
  version: string;
  releaseNamespace: string;
  /** CAAPH Go template; `{{ .Cluster.metadata.name }}` is the workload cluster name, `.InfraCluster` its infra cluster. */
  valuesTemplate: string;
}

const CP_SELECTOR = `nodeSelector:\n  node-role.kubernetes.io/control-plane: "true"\n`;

export const ADDON_PRESETS: AddonPreset[] = [
  {
    id: 'openstack-ccm',
    provider: 'openstack',
    kind: 'ccm',
    displayName: 'OpenStack Cloud Controller Manager',
    repoURL: 'https://kubernetes.github.io/cloud-provider-openstack',
    chartName: 'openstack-cloud-controller-manager',
    version: '2.37.1',
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
    repoURL: 'https://kubernetes.github.io/cloud-provider-openstack',
    chartName: 'openstack-cinder-csi',
    version: '2.37.1',
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      'secret:\n  enabled: true\n  create: false\n  name: cloud-config\n  filename: cloud.conf\n',
      'storageClass:\n  enabled: true\n  delete:\n    isDefault: true\n    allowVolumeExpansion: true\n',
      'clusterID: {{ .Cluster.metadata.name }}\n',
    ].join(''),
  },
  {
    id: 'aws-ccm',
    provider: 'aws',
    kind: 'ccm',
    displayName: 'AWS Cloud Controller Manager',
    repoURL: 'https://kubernetes.github.io/cloud-provider-aws',
    chartName: 'aws-cloud-controller-manager',
    version: '0.0.12',
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      CP_SELECTOR,
      'args:\n  - --v=2\n  - --cloud-provider=aws\n  - --configure-cloud-routes=false\n',
    ].join(''),
  },
  {
    id: 'aws-csi',
    provider: 'aws',
    kind: 'csi',
    displayName: 'AWS EBS CSI driver',
    repoURL: 'https://kubernetes-sigs.github.io/aws-ebs-csi-driver',
    chartName: 'aws-ebs-csi-driver',
    version: '2.67.0',
    releaseNamespace: 'kube-system',
    valuesTemplate: [
      // The controller runs on control plane nodes, whose instance profile may manage volumes.
      // The region comes from the AWSCluster instead of an IMDS lookup.
      'controller:\n  region: {{ .InfraCluster.spec.region }}\n  nodeSelector:\n    node-role.kubernetes.io/control-plane: "true"\n',
      '  tolerations:\n    - key: node-role.kubernetes.io/control-plane\n      operator: Exists\n      effect: NoSchedule\n',
      'storageClasses:\n  - name: ebs-gp3\n    annotations:\n      storageclass.kubernetes.io/is-default-class: "true"\n',
      '    volumeBindingMode: WaitForFirstConsumer\n    allowVolumeExpansion: true\n    parameters:\n      type: gp3\n',
    ].join(''),
  },
];

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
      clusterSelector: { matchLabels: { [`capi-navigator.io/${preset.kind}`]: preset.provider } },
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

/** Presets a cluster needs, from its add-on labels. */
export function presetsFor(clusterLabels: Record<string, string>): AddonPreset[] {
  return ADDON_PRESETS.filter((p) => clusterLabels[`capi-navigator.io/${p.kind}`] === p.provider);
}
