import type { BootstrapFlavorPlugin } from './plugins.js';
import type { ClusterSpec, MachineGroup, NodeCustomization } from './spec.js';
import { compact } from './util.js';

/**
 * k0s via k0smotron v2.2.0 (controlplane/bootstrap.cluster.x-k8s.io/v1beta2), control plane on
 * regular machines. Field names verified against the CRDs of the v2.2.0 release
 * (control-plane-components.yaml, bootstrap-components.yaml) and the k0s configuration reference.
 *
 * - `updateStrategy: InPlace`: version upgrades of the control plane run via k0s autopilot; changes
 *   that would replace control plane machines are refused (ADR-0013).
 * - Control plane nodes run with `--enable-worker` and keep the control plane taint, so they are
 *   nodes like with RKE2 (CCM/CSI controllers schedule there); all-in-one drops the taint.
 * - k0smotron's ProviderID controller sets the node's providerID from the Machine, so no instance
 *   data templating is needed; node names are the system hostnames.
 * - Kubelet root dir /var/lib/kubelet keeps the CSI charts' defaults working.
 * - Calico with VXLAN: kube-router routes pod IPs between nodes, which OpenStack port security and
 *   the AWS source/destination check drop.
 */
export const K0S_CONTROL_PLANE_API = 'controlplane.cluster.x-k8s.io/v1beta2';
export const K0S_BOOTSTRAP_API = 'bootstrap.cluster.x-k8s.io/v1beta2';

const KUBELET_ROOT_DIR = '--kubelet-root-dir=/var/lib/kubelet';
/** Extra SSH keys (spec.sshPublicKeys) for the image's default user (uid 1000). */
const SSH_KEYS_FILE = '/etc/capi-navigator/ssh_authorized_keys';
const SSH_KEYS_COMMAND = `u=$(getent passwd 1000 | cut -d: -f1); if [ -n "$u" ]; then h=$(getent passwd "$u" | cut -d: -f6); install -d -m 0700 -o "$u" -g "$u" "$h/.ssh"; cat ${SSH_KEYS_FILE} >> "$h/.ssh/authorized_keys"; chown "$u:$u" "$h/.ssh/authorized_keys"; chmod 0600 "$h/.ssh/authorized_keys"; fi`;

/** files, pre/post commands and SSH keys of one group (FP9-F-03). */
function customizationFields(spec: ClusterSpec, group: MachineGroup) {
  const c: NodeCustomization = group.customization ?? {
    files: [],
    preCommands: [],
    postCommands: [],
  };
  const ssh = spec.sshPublicKeys;
  return compact({
    files: [
      ...c.files.map((f) =>
        compact({
          path: f.path,
          content: f.content,
          contentFrom: f.contentFromSecret
            ? { secretRef: { name: f.contentFromSecret.name, key: f.contentFromSecret.key } }
            : undefined,
          permissions: f.permissions,
          owner: f.owner,
        }),
      ),
      ...(ssh.length
        ? [{ path: SSH_KEYS_FILE, content: `${ssh.join('\n')}\n`, permissions: '0600' }]
        : []),
    ],
    preK0sCommands: [...(ssh.length ? [SSH_KEYS_COMMAND] : []), ...c.preCommands],
    postK0sCommands: c.postCommands,
  });
}

/** k0s ClusterConfig; k0smotron fills in the API address from the Cluster's endpoint. */
function clusterConfig(spec: ClusterSpec) {
  return {
    apiVersion: 'k0s.k0sproject.io/v1beta1',
    kind: 'ClusterConfig',
    metadata: { name: 'k0s' },
    spec: {
      // Unauthenticated /healthz for the load balancer health checks (k0smotron docs).
      api: { extraArgs: { 'anonymous-auth': 'true' } },
      network: {
        provider: 'calico',
        calico: { mode: 'vxlan' },
        podCIDR: spec.kubernetes.podCidr,
        serviceCIDR: spec.kubernetes.serviceCidr,
      },
      telemetry: { enabled: false },
    },
  };
}

const sortedLabels = (labels: Record<string, string>) =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');

export const k0sPlugin: BootstrapFlavorPlugin = {
  flavor: 'k0s',
  displayName: 'k0s',
  customizationFields: { preCommands: 'preK0sCommands', postCommands: 'postK0sCommands' },
  // The k0s kubelet reports "v1.35.8+k0s" for k0s "v1.35.8+k0s.1" (seen live with CAPI v1.14.3).
  machineVersion: (version) => version.replace(/(\+k0s)\.\d+$/, '$1'),
  // ADR-0013: k0smotron v2.2.0 removes all old control plane machines (and their etcd members)
  // right after the first replacement is ready, so etcd loses quorum. Version upgrades therefore
  // run in place (k0s autopilot); changes that would replace control plane machines are refused.
  controlPlaneUpdates: {
    versionInPlace: true,
    replacementBlocked:
      'k0smotron v2.2.0 cannot replace k0s control plane machines safely: it removes all old machines and their etcd members before the replacements are ready, and etcd loses quorum (ADR-0013). Version upgrades run in place; image, flavor, customization and rebuild changes of the control plane are not possible.',
  },
  // k0s HA docs: the load balancer forwards the API, Konnectivity and the controller join API.
  network: {
    controlPlanePorts: [
      { port: 8132, description: 'k0s Konnectivity', viaLoadBalancer: true },
      { port: 9443, description: 'k0s controller join API', viaLoadBalancer: true },
    ],
    nodeTraffic: [
      { protocol: 'udp', fromPort: 4789, toPort: 4789, description: 'Calico VXLAN' },
      { protocol: 'tcp', fromPort: 10250, toPort: 10250, description: 'Kubelet API' },
    ],
  },

  bootstrapTemplate: {
    apiVersion: K0S_BOOTSTRAP_API,
    apiGroup: 'bootstrap.cluster.x-k8s.io',
    kind: 'K0sWorkerConfigTemplate',
  },

  controlPlaneResource: {
    group: 'controlplane.cluster.x-k8s.io',
    version: 'v1beta2',
    kind: 'K0sControlPlane',
    plural: 'k0scontrolplanes',
  },

  bootstrapResources: {
    group: 'bootstrap.cluster.x-k8s.io',
    version: 'v1beta2',
    templateKind: 'K0sWorkerConfigTemplate',
    templatePlural: 'k0sworkerconfigtemplates',
    configKind: 'K0sWorkerConfig',
    configPlural: 'k0sworkerconfigs',
  },

  controlPlaneRef: (spec) => ({
    apiGroup: 'controlplane.cluster.x-k8s.io',
    kind: 'K0sControlPlane',
    name: `${spec.name}-control-plane`,
  }),

  controlPlane({ spec, infra, machineTemplate, labels }) {
    const cp = spec.topology.controlPlane;
    return {
      apiVersion: K0S_CONTROL_PLANE_API,
      kind: 'K0sControlPlane',
      metadata: { name: `${spec.name}-control-plane`, namespace: spec.namespace, labels },
      spec: {
        version: spec.kubernetes.version,
        replicas: cp.replicas,
        // ADR-0013: in place via k0s autopilot (exception to hard rule 5, versions only).
        updateStrategy: 'InPlace',
        machineTemplate: {
          // v1beta2 K0sControlPlane still references the template with apiVersion.
          infrastructureRef: {
            apiVersion: infra.apiVersion,
            kind: machineTemplate.kind,
            name: machineTemplate.name,
            namespace: spec.namespace,
          },
        },
        k0sConfigSpec: compact({
          k0s: clusterConfig(spec),
          args: [
            '--enable-worker',
            ...(spec.topology.mode === 'all-in-one' ? ['--no-taints'] : []),
            // FP9-F-04: kubelet with an external cloud provider when the CCM is rolled out.
            ...(spec.addons.cloudControllerManager ? ['--enable-cloud-provider'] : []),
            KUBELET_ROOT_DIR,
          ],
          useSystemHostname: true,
          ...customizationFields(spec, cp),
        }),
      },
    };
  },

  workerBootstrapSpec({ spec, pool }) {
    return compact({
      // FP7-F-08: workers follow the control plane only after it was upgraded.
      version: spec.kubernetes.workerVersion ?? spec.kubernetes.version,
      args: [
        ...(spec.addons.cloudControllerManager ? ['--enable-cloud-provider'] : []),
        KUBELET_ROOT_DIR,
        ...(pool.nodeLabels && Object.keys(pool.nodeLabels).length
          ? [`--labels=${sortedLabels(pool.nodeLabels)}`]
          : []),
      ],
      useSystemHostname: true,
      ...customizationFields(spec, pool),
    });
  },
};
