import { kubeVipDaemonSet } from './kube-vip.js';
import type { BootstrapFlavorPlugin, InfraTransformPlugin } from './plugins.js';
import type { ClusterSpec, MachineGroup, NodeCustomization } from './spec.js';
import { compact } from './util.js';

/**
 * k0s via k0smotron v2.3.0 (controlplane/bootstrap.cluster.x-k8s.io/v1beta2), control plane on
 * regular machines. Field names verified against the CRDs of the v2.3.0 release
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
/** k0s applies the manifests below this directory through its manifest deployer (FP31-F-07). */
export const K0S_KUBE_VIP_PATH = '/var/lib/k0s/manifests/kube-vip/kube-vip.yaml';
/** The controller's admin kubeconfig, pointing to localhost. */
const K0S_ADMIN_KUBECONFIG = '/var/lib/k0s/pki/admin.conf';

/**
 * FP9-F-04: kubelet with an external cloud provider when the CCM is rolled out; FP31-F-11: with
 * the node's address where the CCM takes it from the kubelet (k0s does not set --node-ip). The
 * bootstrap provider runs the install command through the shell, which expands $(…).
 */
function cloudProviderArgs(spec: ClusterSpec, infra: InfraTransformPlugin): string[] {
  if (!spec.addons.cloudControllerManager) return [];
  const address = infra.nodeAddressCommand?.(spec.infrastructure as never);
  return [
    '--enable-cloud-provider',
    ...(address ? [`--kubelet-extra-args=--node-ip=$(${address})`] : []),
  ];
}
/** Extra SSH keys (spec.sshPublicKeys) for the image's default user (uid 1000). */
const SSH_KEYS_FILE = '/etc/capi-navigator/ssh_authorized_keys';
const SSH_KEYS_COMMAND = `u=$(getent passwd 1000 | cut -d: -f1); if [ -n "$u" ]; then h=$(getent passwd "$u" | cut -d: -f6); install -d -m 0700 -o "$u" -g "$u" "$h/.ssh"; cat ${SSH_KEYS_FILE} >> "$h/.ssh/authorized_keys"; chown "$u:$u" "$h/.ssh/authorized_keys"; chmod 0600 "$h/.ssh/authorized_keys"; fi`;

/** files, pre/post commands and SSH keys of one group (FP9-F-03). */
function customizationFields(spec: ClusterSpec, infra: InfraTransformPlugin, group: MachineGroup) {
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
          // Without a mode k0smotron writes `permissions: ''`; cloud-init then ends "degraded",
          // which CAPMOX reports as failed provisioning (FP-29 node spike).
          permissions: f.permissions ?? '0644',
          owner: f.owner,
        }),
      ),
      ...(ssh.length
        ? [{ path: SSH_KEYS_FILE, content: `${ssh.join('\n')}\n`, permissions: '0600' }]
        : []),
    ],
    preK0sCommands: [
      ...(infra.nodePreparation ?? []),
      ...(ssh.length ? [SSH_KEYS_COMMAND] : []),
      ...c.preCommands,
    ],
    postK0sCommands: c.postCommands,
  });
}

/** k0s ClusterConfig; k0smotron fills in the API address from the Cluster's endpoint. */
function clusterConfig(spec: ClusterSpec, vip?: string) {
  return {
    apiVersion: 'k0s.k0sproject.io/v1beta1',
    kind: 'ClusterConfig',
    metadata: { name: 'k0s' },
    spec: {
      // Unauthenticated /healthz for the load balancer health checks (k0smotron docs).
      api: compact({ extraArgs: { 'anonymous-auth': 'true' }, sans: vip ? [vip] : undefined }),
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
  // run in place (k0s autopilot); changes that would replace control plane machines are refused
  // unless k0smotron v2.3.0 or later is installed and the control plane has one node: v2.3.0
  // replaced a single node cleanly, but removed all three old nodes of a three-node control plane
  // within a minute, leaving etcd on one member for two minutes (measured live, ADR-0013).
  controlPlaneUpdates: {
    versionInPlace: true,
    // FP26-F-03, measured live (3 → 1 on Google Cloud): k0smotron removes the etcd members one
    // after another, so quorum holds, but starts deleting the next node before the previous one is
    // gone; the API was unreachable through the load balancer several times for 5 to 25 seconds.
    scaleDownWarning:
      'k0smotron removes the control plane nodes in quick succession: etcd keeps its quorum, but the API can be unreachable for up to half a minute at a time while the nodes leave.',
    replacementBlocked:
      'k0smotron before v2.3.0 cannot replace k0s control plane machines safely: it removes all old machines and their etcd members before the replacements are ready, and etcd loses quorum (ADR-0013). Upgrade the k0smotron providers to v2.3.0 or later on the Providers page; version upgrades run in place meanwhile.',
    replacementFixedIn: {
      provider: 'k0smotron-control-plane',
      version: 'v2.3.0',
      maxReplicas: 1,
      multiNodeReason:
        'k0smotron v2.3.0 replaces a control plane with more than one node too fast: it removes all old machines within a minute, and etcd runs on a single member until the replacements are ready, without redundancy (ADR-0013, measured live). Version upgrades run in place; image, flavor, customization and rebuild changes of the control plane are possible with one control plane node only.',
    },
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
    const vip = infra.apiVip?.(spec.infrastructure);
    const custom = customizationFields(spec, infra, cp) as { files?: unknown[] };
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
          // k0smotron v2.2.0 reads this deprecated reference with apiVersion.
          infrastructureRef: {
            apiVersion: infra.apiVersion,
            kind: machineTemplate.kind,
            name: machineTemplate.name,
            namespace: spec.namespace,
          },
          // k0smotron v2.3.0 prefers the contract reference; its webhook fills it from the
          // deprecated one only while empty and nobody owns it, so a template rotation would not
          // reach it (ADR-0013, seen live). Written by the app, both change together; v2.2.0
          // drops the unknown field with a warning.
          spec: {
            infrastructureRef: {
              apiGroup: machineTemplate.apiGroup,
              kind: machineTemplate.kind,
              name: machineTemplate.name,
            },
          },
        },
        k0sConfigSpec: compact({
          k0s: clusterConfig(spec, vip),
          args: [
            '--enable-worker',
            ...(spec.topology.mode === 'all-in-one' ? ['--no-taints'] : []),
            // ADR-0022: Konnectivity agents connect through the load balancer on 8132; where it
            // forwards only the API port (Google Cloud), the API server reaches the kubelets
            // directly instead. Further controllers join on 9443 via the first controller's
            // internal IP (k0smotron falls back to it when the endpoint does not answer).
            ...(infra.apiLoadBalancer?.apiPortOnly
              ? ['--disable-components=konnectivity-server']
              : []),
            ...cloudProviderArgs(spec, infra),
            KUBELET_ROOT_DIR,
          ],
          useSystemHostname: true,
          ...custom,
          // FP31-F-07: kube-vip with the controller's admin kubeconfig (localhost).
          ...(vip
            ? {
                files: [
                  ...(custom.files ?? []),
                  {
                    path: K0S_KUBE_VIP_PATH,
                    content: kubeVipDaemonSet(vip, K0S_ADMIN_KUBECONFIG),
                    permissions: '0644',
                  },
                ],
              }
            : {}),
        }),
      },
    };
  },

  workerBootstrapSpec({ spec, infra, pool }) {
    return compact({
      // FP7-F-08: workers follow the control plane only after it was upgraded.
      version: spec.kubernetes.workerVersion ?? spec.kubernetes.version,
      args: [
        ...cloudProviderArgs(spec, infra),
        KUBELET_ROOT_DIR,
        ...(pool.nodeLabels && Object.keys(pool.nodeLabels).length
          ? [`--labels=${sortedLabels(pool.nodeLabels)}`]
          : []),
      ],
      useSystemHostname: true,
      ...customizationFields(spec, infra, pool),
    });
  },
};
