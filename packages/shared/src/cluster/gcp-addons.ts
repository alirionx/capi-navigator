import { VERSIONS } from '../versions.generated.js';
import { findObject, parseManifest, renderObjects, type ManifestAddon } from './manifest-addons.js';

/**
 * Cloud controller manager and persistent disk CSI driver for Google Cloud (FP25-F-08,
 * ADR-0023). Both authenticate with the node's service account through the metadata server: the
 * control plane machines run as the service account of the credential (gcp.ts), and the CCM and
 * the CSI controller run on control plane nodes. No key reaches the workload cluster.
 */

const CONTROL_PLANE_AFFINITY = {
  nodeAffinity: {
    requiredDuringSchedulingIgnoredDuringExecution: {
      nodeSelectorTerms: [
        {
          matchExpressions: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'Exists' }],
        },
        { matchExpressions: [{ key: 'node-role.kubernetes.io/master', operator: 'Exists' }] },
      ],
    },
  },
};
const CONTROL_PLANE_TOLERATIONS = [
  { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' },
  { key: 'node-role.kubernetes.io/master', operator: 'Exists', effect: 'NoSchedule' },
];

const ccm = VERSIONS.addonManifests['gcp-ccm'];

/**
 * deploy/packages/default/manifest.yaml of cloud-provider-gcp is meant for tooling (kops): empty
 * arguments, the cloud config from the host, an unpinned image. The app pins the image, sets the
 * arguments and delivers the cloud config as ConfigMap. Project, zone, network and node tags come
 * from the metadata server; `multizone` covers control planes spread over zones.
 */
export function gcpCcmManifestForCluster(manifest: string): string {
  const objects = parseManifest(manifest);
  const ds = findObject(objects, 'DaemonSet', 'cloud-controller-manager');
  const pod = ds.spec.template.spec;
  const container = pod.containers.find(
    (c: { name: string }) => c.name === 'cloud-controller-manager',
  );
  if (!container) throw new Error('Manifest: container cloud-controller-manager not found');
  container.image = `registry.k8s.io/cloud-provider-gcp/cloud-controller-manager:${ccm.version}`;
  container.args = [
    '--cloud-provider=gce',
    '--cloud-config=/etc/kubernetes/gce/cloud.config',
    '--leader-elect=true',
    // The manifest grants its RBAC to the CCM's own service account only.
    '--use-service-account-credentials=false',
    // The CNI (Calico, Canal) assigns pod networks and routes itself.
    '--allocate-node-cidrs=false',
    '--configure-cloud-routes=false',
    '--v=2',
  ];
  // Host network: the API server on the same node, on 6443 for all distributions (ADR-0022).
  container.env = [
    ...(container.env ?? []).filter((e: { name: string }) => e.name !== 'KUBERNETES_SERVICE_PORT'),
    { name: 'KUBERNETES_SERVICE_PORT', value: '6443' },
  ];
  container.volumeMounts = [
    { name: 'cloudconfig', mountPath: '/etc/kubernetes/gce', readOnly: true },
  ];
  pod.volumes = [{ name: 'cloudconfig', configMap: { name: 'gce-cloud-config' } }];
  return renderObjects([
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'gce-cloud-config', namespace: 'kube-system' },
      data: { 'cloud.config': '[Global]\nmultizone = true\n' },
    },
    ...objects,
  ]);
}

/**
 * The noauth overlay of the PD CSI driver (no key; the controller uses the node's account). The
 * app adds the namespace the overlay expects, keeps the controller on control plane nodes and adds
 * a default StorageClass on balanced persistent disks.
 */
export function gcpCsiManifestForCluster(manifest: string): string {
  const objects = parseManifest(manifest);
  const controller = findObject(objects, 'Deployment', 'csi-gce-pd-controller');
  const pod = controller.spec.template.spec;
  pod.affinity = CONTROL_PLANE_AFFINITY;
  pod.tolerations = [...(pod.tolerations ?? []), ...CONTROL_PLANE_TOLERATIONS];
  return renderObjects([
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'gce-pd-csi-driver' } },
    ...objects,
    {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: {
        name: 'pd-balanced',
        annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
      },
      provisioner: 'pd.csi.storage.gke.io',
      parameters: { type: 'pd-balanced' },
      volumeBindingMode: 'WaitForFirstConsumer',
      allowVolumeExpansion: true,
    },
  ]);
}

export const GCP_MANIFEST_ADDONS: ManifestAddon[] = [
  {
    id: 'gcp-ccm',
    provider: 'gcp',
    kind: 'ccm',
    displayName: 'GCP Cloud Controller Manager',
    label: ['capi-navigator.io/ccm', 'gcp'],
    version: ccm.version,
    dir: 'gcp',
    file: ccm.manifest,
    sha256: ccm.sha256,
    forCluster: gcpCcmManifestForCluster,
  },
  {
    id: 'gcp-csi',
    provider: 'gcp',
    kind: 'csi',
    displayName: 'GCP Compute Engine PD CSI driver',
    label: ['capi-navigator.io/csi', 'gcp'],
    version: VERSIONS.addonManifests['gcp-csi'].version,
    dir: 'gcp',
    file: VERSIONS.addonManifests['gcp-csi'].manifest,
    sha256: VERSIONS.addonManifests['gcp-csi'].sha256,
    forCluster: gcpCsiManifestForCluster,
  },
];
