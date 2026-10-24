import {
  KUBEADM_KUBE_VIP_INIT_COMMAND,
  KUBEADM_KUBE_VIP_RESTORE_COMMAND,
  KUBEADM_KUBE_VIP_MANIFEST,
  kubeVipStaticPod,
} from './kube-vip.js';
import type { BootstrapFlavorPlugin, InfraTransformPlugin } from './plugins.js';
import type { ClusterSpec, MachineGroup, NodeCustomization } from './spec.js';
import { compact } from './util.js';
import { VERSIONS } from '../versions.generated.js';
import { fillTemplate } from './templates/generate.js';
import { KUBEADM_INSTALL_TEMPLATE } from './templates/kubeadm-install.generated.js';

/**
 * Upstream Kubernetes with kubeadm (Cluster API v1.14.3 kubeadm bootstrap and control plane,
 * v1beta2) on stock cloud images, experimental (FP-10). Field names verified against the CRDs of
 * v1.14.3. Containerd and runc come as official release binaries (independent of the distribution,
 * ADR-0014); kubelet, kubeadm and kubectl of exactly the chosen version from pkgs.k8s.io (apt or
 * dnf), held against automatic updates. Kubeadm's cloud-init is a Jinja template, so the node
 * identity of the infrastructure plugin works as with RKE2 (ADR-0004).
 */
export const KUBEADM_CONTROL_PLANE_API = 'controlplane.cluster.x-k8s.io/v1beta2';
export const KUBEADM_BOOTSTRAP_API = 'bootstrap.cluster.x-k8s.io/v1beta2';

/** Verified on 2026-10-18: containerd 2.3 is recommended for Kubernetes 1.35 to 1.37. */
export const KUBEADM_RUNTIME = {
  containerd: VERSIONS.kubeadmRuntime.containerd.version,
  runc: VERSIONS.kubeadmRuntime.runc.version,
};

const INSTALL_SCRIPT_PATH = '/usr/local/bin/capi-navigator-install-kubernetes.sh';
const SSH_KEYS_FILE = '/etc/capi-navigator/ssh_authorized_keys';
const SSH_KEYS_COMMAND = `u=$(getent passwd 1000 | cut -d: -f1); if [ -n "$u" ]; then h=$(getent passwd "$u" | cut -d: -f6); install -d -m 0700 -o "$u" -g "$u" "$h/.ssh"; cat ${SSH_KEYS_FILE} >> "$h/.ssh/authorized_keys"; chown "$u:$u" "$h/.ssh/authorized_keys"; chmod 0600 "$h/.ssh/authorized_keys"; fi`;

/**
 * FP10-F-02: prepares a stock image and installs containerd, runc, kubelet, kubeadm and kubectl.
 * Pure function of the version and the mirrors, so a version change creates new templates.
 */
export function kubeadmInstallScript(spec: ClusterSpec, version: string): string {
  const v = version.replace(/^v/, '');
  const minor = v.split('.').slice(0, 2).join('.');
  const pkgs = `${(spec.kubernetes.packageRepository ?? 'https://pkgs.k8s.io').replace(/\/+$/, '')}/core:/stable:/v${minor}`;
  const downloads = (spec.kubernetes.binaryDownloads ?? 'https://github.com').replace(/\/+$/, '');
  const { containerd, runc } = KUBEADM_RUNTIME;
  // The script itself is templates/kubeadm-install.sh.tmpl (checked by shellcheck, FP20-F-07).
  return fillTemplate(KUBEADM_INSTALL_TEMPLATE, {
    K8S_VERSION: v,
    PKGS: pkgs,
    DOWNLOADS: downloads,
    CONTAINERD_VERSION: containerd,
    RUNC_VERSION: runc,
  });
}

/**
 * FP31-F-11: the node's address for CCMs that take it from the kubelet (`--node-ip`). kubeadm's
 * kubeletExtraArgs cannot run a command, so it goes into KUBELET_EXTRA_ARGS, which the systemd
 * drop-in of the kubelet packages reads (deb: /etc/default/kubelet, rpm: /etc/sysconfig/kubelet).
 */
function nodeAddressCommands(spec: ClusterSpec, infra: InfraTransformPlugin): string[] {
  const address = spec.addons.cloudControllerManager
    ? infra.nodeAddressCommand?.(spec.infrastructure as never)
    : undefined;
  if (!address) return [];
  return [
    `f=/etc/default/kubelet; [ -d /etc/sysconfig ] && f=/etc/sysconfig/kubelet; echo "KUBELET_EXTRA_ARGS=--node-ip=$(${address})" > "$f"`,
  ];
}

/** Kubelet arguments (v1beta2: list of name/value). */
function kubeletArgs(
  spec: ClusterSpec,
  infra: InfraTransformPlugin,
  nodeLabels?: Record<string, string>,
): { name: string; value: string }[] {
  return [
    // FP10-F-06: nodes are initialized by the cloud controller manager when it is rolled out.
    ...(spec.addons.cloudControllerManager ? [{ name: 'cloud-provider', value: 'external' }] : []),
    { name: 'provider-id', value: infra.nodeIdentity(spec.infrastructure).providerId },
    ...(nodeLabels && Object.keys(nodeLabels).length
      ? [
          {
            name: 'node-labels',
            value: Object.entries(nodeLabels)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => `${k}=${v}`)
              .join(','),
          },
        ]
      : []),
  ];
}

/** files, pre/post commands and SSH keys of one group; the install script runs first (FP10-F-05). */
function bootstrapFields(
  spec: ClusterSpec,
  infra: InfraTransformPlugin,
  group: MachineGroup,
  version: string,
) {
  const c: NodeCustomization = group.customization ?? {
    files: [],
    preCommands: [],
    postCommands: [],
  };
  const ssh = spec.sshPublicKeys;
  return compact({
    format: 'cloud-config',
    files: [
      {
        path: INSTALL_SCRIPT_PATH,
        content: kubeadmInstallScript(spec, version),
        permissions: '0755',
        owner: 'root:root',
      },
      ...c.files.map((f) =>
        compact({
          path: f.path,
          content: f.content,
          contentFrom: f.contentFromSecret
            ? { secret: { name: f.contentFromSecret.name, key: f.contentFromSecret.key } }
            : undefined,
          permissions: f.permissions,
          owner: f.owner,
        }),
      ),
      ...(ssh.length
        ? [{ path: SSH_KEYS_FILE, content: `${ssh.join('\n')}\n`, permissions: '0600' }]
        : []),
    ],
    preKubeadmCommands: [
      ...(infra.nodePreparation ?? []),
      INSTALL_SCRIPT_PATH,
      ...nodeAddressCommands(spec, infra),
      ...(ssh.length ? [SSH_KEYS_COMMAND] : []),
      ...c.preCommands,
    ],
    postKubeadmCommands: [
      // All-in-one: kubeadm marks control plane nodes as excluded from external load balancers,
      // so a LoadBalancer Service found no backends (seen on OpenStack). The workloads run here.
      ...(spec.topology.mode === 'all-in-one'
        ? [
            `kubectl --kubeconfig /etc/kubernetes/admin.conf label node "${infra.nodeIdentity(spec.infrastructure).nodeName}" node.kubernetes.io/exclude-from-external-load-balancers- || true`,
          ]
        : []),
      ...c.postCommands,
    ],
  });
}

export const kubeadmPlugin: BootstrapFlavorPlugin = {
  flavor: 'kubeadm',
  displayName: 'kubeadm',
  experimental: true,
  needsCni: true,
  installsPackages: true,
  customizationFields: { preCommands: 'preKubeadmCommands', postCommands: 'postKubeadmCommands' },
  // API server only behind the load balancer; Calico VXLAN with Typha between nodes (FP10-F-04).
  network: {
    controlPlanePorts: [],
    nodeTraffic: [
      { protocol: 'udp', fromPort: 4789, toPort: 4789, description: 'Calico VXLAN' },
      { protocol: 'tcp', fromPort: 5473, toPort: 5473, description: 'Calico Typha' },
      { protocol: 'tcp', fromPort: 10250, toPort: 10250, description: 'Kubelet API' },
    ],
  },

  bootstrapTemplate: {
    apiVersion: KUBEADM_BOOTSTRAP_API,
    apiGroup: 'bootstrap.cluster.x-k8s.io',
    kind: 'KubeadmConfigTemplate',
  },

  controlPlaneResource: {
    group: 'controlplane.cluster.x-k8s.io',
    version: 'v1beta2',
    kind: 'KubeadmControlPlane',
    plural: 'kubeadmcontrolplanes',
  },

  bootstrapResources: {
    group: 'bootstrap.cluster.x-k8s.io',
    version: 'v1beta2',
    templateKind: 'KubeadmConfigTemplate',
    templatePlural: 'kubeadmconfigtemplates',
    configKind: 'KubeadmConfig',
    configPlural: 'kubeadmconfigs',
  },

  controlPlaneRef: (spec) => ({
    apiGroup: 'controlplane.cluster.x-k8s.io',
    kind: 'KubeadmControlPlane',
    name: `${spec.name}-control-plane`,
  }),

  controlPlane({ spec, infra, machineTemplate, labels }) {
    const cp = spec.topology.controlPlane;
    const vip = infra.apiVip?.(spec.infrastructure);
    const fields = bootstrapFields(spec, infra, cp, spec.kubernetes.version) as {
      files?: unknown[];
      preKubeadmCommands?: string[];
      postKubeadmCommands?: string[];
    };
    const nodeRegistration = {
      name: infra.nodeIdentity(spec.infrastructure).nodeName,
      kubeletExtraArgs: kubeletArgs(spec, infra),
      // All-in-one: no control plane taint, workloads run on the only node. An empty list is
      // "no taints" for kubeadm (unset means the default taint), so it is set after compact().
      ...(spec.topology.mode === 'all-in-one' ? { taints: [] } : {}),
    };
    return {
      apiVersion: KUBEADM_CONTROL_PLANE_API,
      kind: 'KubeadmControlPlane',
      metadata: { name: `${spec.name}-control-plane`, namespace: spec.namespace, labels },
      spec: {
        version: spec.kubernetes.version,
        replicas: cp.replicas,
        machineTemplate: { spec: { infrastructureRef: machineTemplate } },
        // Surge one new node before removing an old one (etcd quorum stays intact).
        rollout: { strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1 } } },
        kubeadmConfigSpec: {
          ...fields,
          // FP31-F-07: kube-vip as static pod, so the VIP exists during kubeadm init; the first
          // node uses super-admin.conf during init and switches back to admin.conf afterwards.
          ...(vip
            ? {
                files: [
                  ...(fields.files ?? []),
                  {
                    path: KUBEADM_KUBE_VIP_MANIFEST,
                    content: kubeVipStaticPod(vip, '/etc/kubernetes/admin.conf'),
                    permissions: '0644',
                    owner: 'root:root',
                  },
                ],
                preKubeadmCommands: [
                  ...(fields.preKubeadmCommands ?? []),
                  KUBEADM_KUBE_VIP_INIT_COMMAND,
                ],
                postKubeadmCommands: [
                  KUBEADM_KUBE_VIP_RESTORE_COMMAND,
                  ...(fields.postKubeadmCommands ?? []),
                ],
              }
            : {}),
          // Separate copies: a shared object would become a YAML anchor in the preview.
          initConfiguration: { nodeRegistration: structuredClone(nodeRegistration) },
          joinConfiguration: { nodeRegistration: structuredClone(nodeRegistration) },
        },
      },
    };
  },

  workerBootstrapSpec({ spec, infra, pool }) {
    const version = spec.kubernetes.workerVersion ?? spec.kubernetes.version;
    return {
      ...bootstrapFields(spec, infra, pool, version),
      joinConfiguration: {
        nodeRegistration: {
          name: infra.nodeIdentity(spec.infrastructure).nodeName,
          kubeletExtraArgs: kubeletArgs(spec, infra, pool.nodeLabels),
        },
      },
    };
  },
};
