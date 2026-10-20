import type { PermissionCheck } from './connections.js';

/**
 * Permissions CAPI Navigator needs on a management cluster, checked with
 * SelfSubjectAccessReview when a connection is tested (FP2-F-04). Resource names verified against
 * cluster-api v1.14.3, cluster-api-operator v0.30.0 (unchanged API) and CAAPH CRDs.
 */
export const REQUIRED_PERMISSIONS: Omit<PermissionCheck, 'allowed'>[] = [
  {
    group: '',
    resource: 'namespaces',
    verb: 'list',
    level: 'required',
    purpose: 'Show namespaces in forms',
  },
  {
    group: '',
    resource: 'namespaces',
    verb: 'create',
    level: 'required',
    purpose: 'Create namespaces for providers and clusters',
  },
  {
    group: '',
    resource: 'secrets',
    verb: 'create',
    level: 'required',
    purpose: 'Store provider credentials and configuration (FP-3, FP-4)',
  },
  {
    group: '',
    resource: 'events',
    verb: 'list',
    level: 'required',
    purpose: 'Show events of clusters and machines (FP-6)',
  },
  {
    group: 'apiextensions.k8s.io',
    resource: 'customresourcedefinitions',
    verb: 'list',
    level: 'required',
    purpose: 'Detect the CAPI Operator, ORC and providers (FP-3)',
  },
  {
    group: 'apps',
    resource: 'deployments',
    verb: 'list',
    level: 'required',
    purpose: 'Detect cert-manager and the CAPI Operator (FP-3)',
  },
  {
    group: 'operator.cluster.x-k8s.io',
    resource: 'coreproviders',
    verb: 'create',
    level: 'required',
    purpose: 'Install providers through the CAPI Operator (FP-3)',
  },
  {
    group: 'operator.cluster.x-k8s.io',
    resource: 'infrastructureproviders',
    verb: 'patch',
    level: 'required',
    purpose: 'Configure and upgrade providers (FP-3)',
  },
  {
    group: 'cluster.x-k8s.io',
    resource: 'clusters',
    verb: 'create',
    level: 'required',
    purpose: 'Create workload clusters (FP-5)',
  },
  {
    group: 'cluster.x-k8s.io',
    resource: 'machinedeployments',
    verb: 'patch',
    level: 'required',
    purpose: 'Scale worker pools (FP-6)',
  },
  {
    group: 'cluster.x-k8s.io',
    resource: 'machines',
    verb: 'watch',
    level: 'required',
    purpose: 'Show live machine status (FP-6)',
  },
  {
    group: 'addons.cluster.x-k8s.io',
    resource: 'helmchartproxies',
    verb: 'create',
    level: 'required',
    purpose: 'Roll out CCM, CSI and Helm add-ons (FP-5, FP-8)',
  },
  {
    group: 'apiextensions.k8s.io',
    resource: 'customresourcedefinitions',
    verb: 'create',
    level: 'install',
    purpose: 'Install ORC from its release manifest (FP-3)',
  },
  {
    group: 'rbac.authorization.k8s.io',
    resource: 'clusterroles',
    verb: 'create',
    level: 'install',
    purpose: 'Install ORC from its release manifest (FP-3)',
  },
  {
    group: 'apps',
    resource: 'deployments',
    verb: 'create',
    level: 'install',
    purpose: 'Install ORC from its release manifest (FP-3)',
  },
];

const HEADER =
  '# Generated from packages/shared/src/management-access.ts by `pnpm crds:generate`. Do not edit.\n';

const COMMON = `apiVersion: v1
kind: Namespace
metadata:
  name: capi-navigator-access
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: capi-navigator
  namespace: capi-navigator-access
---
# Long-lived token for the connection (FP2-F-01, auth type "token"). Read it with:
#   kubectl -n capi-navigator-access get secret capi-navigator-token -o jsonpath='{.data.token}' | base64 -d
#   kubectl -n capi-navigator-access get secret capi-navigator-token -o jsonpath='{.data.ca\\.crt}' | base64 -d
apiVersion: v1
kind: Secret
metadata:
  name: capi-navigator-token
  namespace: capi-navigator-access
  annotations:
    kubernetes.io/service-account.name: capi-navigator
type: kubernetes.io/service-account-token
`;

/**
 * FP2-F-07: prepares a management cluster for CAPI Navigator. Binds cluster-admin, because
 * installing ORC and providers (FP-3) creates CRDs, ClusterRoles and Deployments.
 */
export const MANAGEMENT_ACCESS_MANIFEST = `${HEADER}${COMMON}---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: capi-navigator-cluster-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: capi-navigator
    namespace: capi-navigator-access
`;

/**
 * NF-03: minimal permissions for operating clusters when cert-manager, the CAPI Operator and ORC
 * are installed by other means. Installing ORC from the app is not possible with this role.
 */
export const MANAGEMENT_ACCESS_MINIMAL_MANIFEST = `${HEADER}${COMMON}---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: capi-navigator-operate
rules:
  - apiGroups: ['']
    resources: [namespaces]
    verbs: [get, list, watch, create]
  - apiGroups: ['']
    resources: [secrets, configmaps]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: ['']
    resources: [events]
    verbs: [get, list, watch]
  # Node list for the node shell (FP-17)
  - apiGroups: ['']
    resources: [nodes]
    verbs: [get, list]
  - apiGroups: [apiextensions.k8s.io]
    resources: [customresourcedefinitions]
    verbs: [get, list, watch]
  - apiGroups: [apps]
    resources: [deployments]
    verbs: [get, list, watch]
  - apiGroups: [operator.cluster.x-k8s.io]
    resources: ['*']
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups:
      - cluster.x-k8s.io
      - infrastructure.cluster.x-k8s.io
      - bootstrap.cluster.x-k8s.io
      - controlplane.cluster.x-k8s.io
      - addons.cluster.x-k8s.io
    resources: ['*']
    verbs: [get, list, watch, create, update, patch, delete]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: capi-navigator-operate
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: capi-navigator-operate
subjects:
  - kind: ServiceAccount
    name: capi-navigator
    namespace: capi-navigator-access
---
# Node shell (FP-17, ADR-0008): short-lived privileged pods in kube-system. Remove this Role and
# RoleBinding if admins must not open shells on management cluster nodes.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: capi-navigator-node-shell
  namespace: kube-system
rules:
  - apiGroups: ['']
    resources: [pods]
    verbs: [get, list, create, delete]
  - apiGroups: ['']
    resources: [pods/exec]
    verbs: [create, get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: capi-navigator-node-shell
  namespace: kube-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: capi-navigator-node-shell
subjects:
  - kind: ServiceAccount
    name: capi-navigator
    namespace: capi-navigator-access
`;
