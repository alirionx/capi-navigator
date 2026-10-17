import type { BootstrapFlavorPlugin, InfraTransformPlugin } from './plugins.js';
import type { ClusterSpec, MachineGroup, NodeCustomization } from './spec.js';
import { compact } from './util.js';

/**
 * RKE2 (cluster-api-provider-rke2 v0.26.0, v1beta2 APIs). Field names verified against
 * controlplane/api/v1beta2/rke2controlplane_types.go and bootstrap/api/v1beta2/rke2config_types.go.
 * User data is rendered as cloud-init Jinja (`## template: jinja`), so instance data like
 * `{{ v1.instance_id }}` can be used (ADR-0004).
 */
export const RKE2_CONTROL_PLANE_API = 'controlplane.cluster.x-k8s.io/v1beta2';
export const RKE2_BOOTSTRAP_API = 'bootstrap.cluster.x-k8s.io/v1beta2';

/**
 * Node preparation for stock images: RKE2 on RHEL 10 and derivatives (Rocky) needs
 * kernel-modules-extra for nf_conntrack (RKE2 docs, install/requirements). No-op elsewhere.
 */
export const RKE2_OS_PREPARATION = [
  `if grep -qE '^ID_LIKE=.*(rhel|fedora)' /etc/os-release && grep -qE '^VERSION_ID="?10' /etc/os-release; then dnf install -y kernel-modules-extra; fi`,
];

function agentConfig(
  spec: ClusterSpec,
  infra: InfraTransformPlugin,
  extra: { nodeLabels?: Record<string, string>; worker: boolean },
) {
  const kubeletArgs = [`provider-id=${infra.nodeIdentity.providerId}`];
  // Servers get cloud-provider=external via serverConfig.cloudProviderName; agents need it here.
  if (extra.worker && spec.addons.cloudControllerManager)
    kubeletArgs.push('cloud-provider=external');
  const taints =
    !extra.worker && spec.topology.mode === 'standard'
      ? ['node-role.kubernetes.io/control-plane:NoSchedule']
      : undefined;
  const ssh = spec.sshPublicKeys;
  return compact({
    nodeName: infra.nodeIdentity.nodeName,
    nodeLabels: extra.nodeLabels
      ? Object.entries(extra.nodeLabels)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
      : undefined,
    nodeTaints: taints,
    kubelet: { extraArgs: kubeletArgs },
    // SSH keys as extra cloud-init (RKE2AgentConfig.additionalUserData).
    additionalUserData:
      ssh.length > 0
        ? {
            config: `ssh_authorized_keys:\n${ssh.map((k) => `  - ${JSON.stringify(k)}`).join('\n')}\n`,
          }
        : undefined,
  });
}

/** files, pre/post commands and SSH keys of one group (FP5-F-13). */
function customizationFields(spec: ClusterSpec, group: MachineGroup) {
  const c: NodeCustomization = group.customization ?? {
    files: [],
    preCommands: [],
    postCommands: [],
  };
  return compact({
    files: c.files.map((f) =>
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
    preRKE2Commands: [...RKE2_OS_PREPARATION, ...c.preCommands],
    postRKE2Commands: c.postCommands,
    gzipUserData: false,
  });
}

export const rke2Plugin: BootstrapFlavorPlugin = {
  flavor: 'rke2',
  bootstrapTemplate: {
    apiVersion: RKE2_BOOTSTRAP_API,
    apiGroup: 'bootstrap.cluster.x-k8s.io',
    kind: 'RKE2ConfigTemplate',
  },

  controlPlaneRef: (spec) => ({
    apiGroup: 'controlplane.cluster.x-k8s.io',
    kind: 'RKE2ControlPlane',
    name: `${spec.name}-control-plane`,
  }),

  controlPlane({ spec, infra, machineTemplate, labels }) {
    const cp = spec.topology.controlPlane;
    const external = spec.addons.cloudControllerManager;
    return {
      apiVersion: RKE2_CONTROL_PLANE_API,
      kind: 'RKE2ControlPlane',
      metadata: { name: `${spec.name}-control-plane`, namespace: spec.namespace, labels },
      spec: compact({
        version: spec.kubernetes.version,
        replicas: cp.replicas,
        registrationMethod: 'internal-first',
        machineTemplate: { spec: { infrastructureRef: machineTemplate } },
        // Surge one new node before removing an old one (etcd quorum stays intact).
        rolloutStrategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1 } },
        serverConfig: compact({
          cni: 'calico',
          // FP5-F-10: external cloud provider when the CCM is rolled out.
          cloudProviderName: external ? 'external' : undefined,
          disableComponents: external ? { kubernetesComponents: ['cloudController'] } : undefined,
        }),
        agentConfig: agentConfig(spec, infra, { worker: false }),
        ...customizationFields(spec, cp),
      }),
    };
  },

  workerBootstrapSpec({ spec, infra, pool }) {
    return compact({
      agentConfig: agentConfig(spec, infra, { worker: true, nodeLabels: pool.nodeLabels }),
      ...customizationFields(spec, pool),
    });
  },
};
