import { stringify } from 'yaml';
import { VERSIONS } from '../versions.generated.js';

/**
 * kube-vip in ARP mode for the API endpoint where the infrastructure has no load balancer
 * (FP31-F-07, ADR-0027): the control plane nodes elect a leader that answers ARP for the virtual
 * IP; services are left to others (e.g. MetalLB). One container for every distribution; the
 * environment is what `kube-vip manifest daemonset --arp --controlplane --leaderElection` of the
 * pinned version renders, verified live with RKE2 and k0s on Proxmox VE (FP-31 spike). The
 * interface is detected by kube-vip (no vip_interface).
 */
export const KUBE_VIP_IMAGE = `${VERSIONS.images['kube-vip'].source.registry}/${VERSIONS.images['kube-vip'].source.package}:${VERSIONS.images['kube-vip'].version}`;

/** How kube-vip reaches the API server before the virtual IP exists. */
export type KubeVipAccess =
  /** Service account (RKE2: the `kubernetes` Service points to the node's own address). */
  | { kind: 'in-cluster' }
  /**
   * The node's admin kubeconfig through localhost (k0s advertises the VIP for the `kubernetes`
   * Service, so in-cluster access would need the VIP it is meant to provide).
   */
  | { kind: 'host-kubeconfig'; path: string };

const NAME = 'kube-vip';
const NAMESPACE = 'kube-system';
const LABELS = { 'app.kubernetes.io/name': 'kube-vip-ds' };

function container(vip: string, kubeconfig?: string) {
  const env = [
    { name: 'vip_arp', value: 'true' },
    { name: 'port', value: '6443' },
    { name: 'vip_nodename', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
    { name: 'vip_subnet', value: '32' },
    { name: 'dns_mode', value: 'first' },
    { name: 'dhcp_mode', value: 'ipv4' },
    { name: 'cp_enable', value: 'true' },
    { name: 'cp_namespace', value: NAMESPACE },
    { name: 'svc_enable', value: 'false' },
    { name: 'vip_leaderelection', value: 'true' },
    { name: 'vip_leasename', value: 'plndr-cp-lock' },
    { name: 'vip_leaseduration', value: '15' },
    { name: 'vip_renewdeadline', value: '10' },
    { name: 'vip_retryperiod', value: '2' },
    { name: 'address', value: vip },
    { name: 'prometheus_server', value: ':2112' },
  ];
  return {
    name: NAME,
    image: KUBE_VIP_IMAGE,
    imagePullPolicy: 'IfNotPresent',
    args: ['manager'],
    env,
    securityContext: {
      capabilities: { add: ['NET_ADMIN', 'NET_RAW'], drop: ['ALL'] },
    },
    ...(kubeconfig
      ? { volumeMounts: [{ name: 'kubeconfig', mountPath: '/etc/kubernetes/admin.conf' }] }
      : {}),
  };
}

const hostKubeconfig = (path: string) => ({
  // kube-vip reads /etc/kubernetes/admin.conf; "kubernetes" is the API server's own name.
  hostAliases: [{ ip: '127.0.0.1', hostnames: ['kubernetes'] }],
  volumes: [{ name: 'kubeconfig', hostPath: { path } }],
});

/** RBAC of the in-cluster variant (kube-vip.io/manifests/rbac.yaml). */
function rbac(): Record<string, unknown>[] {
  return [
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: NAME, namespace: NAMESPACE } },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: 'system:kube-vip-role' },
      rules: [
        { apiGroups: [''], resources: ['services/status'], verbs: ['update'] },
        {
          apiGroups: [''],
          resources: ['services', 'endpoints'],
          verbs: ['list', 'get', 'watch', 'update'],
        },
        {
          apiGroups: [''],
          resources: ['nodes'],
          verbs: ['list', 'get', 'watch', 'update', 'patch'],
        },
        {
          apiGroups: ['coordination.k8s.io'],
          resources: ['leases'],
          verbs: ['list', 'get', 'watch', 'update', 'create'],
        },
        {
          apiGroups: ['discovery.k8s.io'],
          resources: ['endpointslices'],
          verbs: ['list', 'get', 'watch', 'update'],
        },
        { apiGroups: [''], resources: ['pods'], verbs: ['list'] },
      ],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'system:kube-vip-binding' },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: 'system:kube-vip-role',
      },
      subjects: [{ kind: 'ServiceAccount', name: NAME, namespace: NAMESPACE }],
    },
  ];
}

/**
 * Pure: kube-vip as DaemonSet on the control plane nodes, for distributions that deploy
 * manifests from a directory once their first API server runs (RKE2, k0s).
 */
export function kubeVipDaemonSet(vip: string, access: KubeVipAccess): string {
  const daemonSet = {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    // Copies: a shared object would become a YAML anchor in the manifest.
    metadata: { name: 'kube-vip-ds', namespace: NAMESPACE, labels: { ...LABELS } },
    spec: {
      selector: { matchLabels: { ...LABELS } },
      template: {
        metadata: { labels: { ...LABELS } },
        spec: {
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [
                  {
                    matchExpressions: [
                      { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists' },
                    ],
                  },
                ],
              },
            },
          },
          containers: [container(vip, access.kind === 'host-kubeconfig' ? access.path : undefined)],
          hostNetwork: true,
          tolerations: [
            { effect: 'NoSchedule', operator: 'Exists' },
            { effect: 'NoExecute', operator: 'Exists' },
          ],
          ...(access.kind === 'in-cluster'
            ? { serviceAccountName: NAME }
            : hostKubeconfig(access.path)),
        },
      },
    },
  };
  const docs = access.kind === 'in-cluster' ? [...rbac(), daemonSet] : [daemonSet];
  return docs.map((d) => stringify(d, { lineWidth: 0 })).join('---\n');
}

/** Pure: kube-vip as static pod (kubeadm), with the node's admin kubeconfig. */
export function kubeVipStaticPod(vip: string, kubeconfig: string): string {
  return stringify(
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: NAME, namespace: NAMESPACE },
      spec: {
        containers: [container(vip, kubeconfig)],
        hostNetwork: true,
        ...hostKubeconfig(kubeconfig),
      },
    },
    { lineWidth: 0 },
  );
}

/** Where kubeadm keeps static pod manifests and the kube-vip manifest in it. */
export const KUBEADM_KUBE_VIP_MANIFEST = '/etc/kubernetes/manifests/kube-vip.yaml';

/**
 * kubeadm 1.29 and later: during `kubeadm init`, admin.conf has no rights until the API server is
 * up, which needs the VIP; the first node uses super-admin.conf instead (kube-vip issue 684, as in
 * CAPMOX's template). Joining nodes keep admin.conf.
 */
export const KUBEADM_KUBE_VIP_INIT_COMMAND = `if [ -f /run/kubeadm/kubeadm.yaml ]; then sed -i 's#path: /etc/kubernetes/admin.conf#path: /etc/kubernetes/super-admin.conf#' ${KUBEADM_KUBE_VIP_MANIFEST}; fi`;
