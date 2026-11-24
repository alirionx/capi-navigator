# ADR-0039: Managed namespaces as add-ons, isolated with a Calico tier

- Status: accepted
- Date: 2026-11-24
- Pack: FP-36
- Refines: POS-01, FP30-F-10

## Context

The owner of a workload cluster can divide it into namespaces with guard rails and hand out access
to them. The first draft of FP-36 wrote the objects directly into the workload cluster. CAAPH and
the generic chart of FP-30 already roll out manifests declaratively, with preview, status per
cluster and audit.

Two points were tested before the decision (kind, three nodes, Calico v3.33.0 with VXLAN "Always",
Helm 3.20.2 as in CAAPH v0.6.4):

- **Standard NetworkPolicy.** "Everything except the pod network" also blocks traffic from outside
  that another node forwards: it arrives with the tunnel address of that node, which lies in the
  pod network. Ordinary LoadBalancer Services would fail unless they set
  `externalTrafficPolicy: Local`. Standard policies only add up, so a baseline that allows traffic
  also keeps teams from being stricter, and `edit` may change them.
- **Role `edit`.** It may impersonate service accounts, create tokens for them and read and write
  Secrets in its namespace.

## Decision

- **One `HelmChartProxy` per managed namespace**, generated from a form. The form model is an
  annotation on it; the manifests follow from it by a pure function. The release namespace and the
  namespace of all service accounts is `capi-navigator-access`, where teams have no rights: so
  nobody takes over another account, renews a token or reads the Helm release.
- **Nothing is lost on removal.** CAAPH uninstalls a release when a cluster no longer matches or
  the add-on is deleted. Namespace, quota, LimitRange and isolation carry
  `helm.sh/resource-policy: keep`; accounts and role bindings go, which ends the access. The release
  name follows from the namespace, so a later add-on takes the kept objects over. A namespace is
  deleted only by a separate, confirmed action.
- **Calico policy in a tier of its own** (`crd.projectcalico.org/v1`, `Tier` and `NetworkPolicy`)
  that denies ingress from pods of other namespaces and passes everything else on. It passed all
  test cases, teams cannot change it with `edit`, and their own NetworkPolicies still take effect.
  One tier per namespace, because Helm releases cannot share an object.
- **Only on Calico.** The distribution plugin declares the CNI. Clusters with another CNI (FP-21)
  cannot be selected and are refused by the backend. On a cluster without the Calico resources, Helm
  fails before it creates anything.
- **Roles `view` and `edit` only.** `admin` may create role bindings, and so an account with a
  token that never expires.
- **Drift** is computed by the app for the generated fields only, because CAAPH compares only chart
  version and values. A new revision in the manifests triggers the Helm upgrade that restores them.

## Consequences

- The isolation uses Calico's resources instead of the Kubernetes API. The objects are written to
  `crd.projectcalico.org/v1` without the validation of Calico's own `projectcalico.org/v3` API,
  which none of the distributions installs. kubeadm (our manifest), k0s and RKE2 ship the CRDs.
- `ClusterNetworkPolicy` (`policy.networking.k8s.io`) would be the standard way. It is v1alpha2 and
  missing in k0s; to be checked again later.
- A pod reaches a Service that another team exposes through a NodePort or load balancer, like
  everybody outside.
- Whoever has `addons.manage` can roll out free manifests and stays close to cluster-admin
  (FP30-F-10); `clusters.access` allows only the generated objects.
