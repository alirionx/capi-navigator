# ADR-0028: LoadBalancer Services on Proxmox VE through kube-vip presets

- Status: accepted
- Date: 2026-10-24
- Pack: FP-32
- Refines: [ADR-0027](0027-proxmox-ve-with-capmox.md) (kube-vip for the API endpoint), [ADR-0024](0024-manifest-addons-through-caaph.md) (CAAPH instead of ClusterResourceSet)

## Context

Proxmox VE has no load balancer, so Services of type `LoadBalancer` stay pending. The FP-32 spike
showed that a second kube-vip for Services, next to the instance that holds the API endpoint, and
kube-vip-cloud-provider, which hands out addresses from a range, work on the app's clusters. The
spike proposed delivering both per distribution, like the API endpoint instance (FP31-F-07).

Options considered:

1. **Per distribution, as files in the bootstrap configuration** (RKE2 and k0s manifest
   directories, a static pod for kubeadm). The range would be part of the control plane template:
   adding a range would rotate the templates and replace the control plane nodes (hard rule 5),
   and kubeadm has no manifest directory for a DaemonSet.
2. **ClusterResourceSet per cluster with `strategy: Reconcile`.** One generic path and no rollout
   for a new range, but objects are never removed from a workload cluster and there is no status:
   a range could only ever be extended and the feature never switched off (the reasons of
   ADR-0024).
3. **CAAPH presets with the upstream charts** of the kube-vip Helm repository (`kube-vip` and
   `kube-vip-cloud-provider`). Helm owns the objects: a changed range is a Helm upgrade, a cluster
   no longer selected gets the release uninstalled, status and version show like every preset.

## Decision

- **Option 3.** Two presets, `proxmox-kube-vip` and `proxmox-kube-vip-cloud-provider`, both
  selected by the cluster label `capi-navigator.io/loadbalancer=proxmox`, which the Proxmox plugin
  sets when the cluster has LoadBalancer addresses.
- **kube-vip for Services only**, configured through the chart's `env`: `cp_enable=false`,
  `svc_enable=true`, `svc_election=true`, ARP, metrics on `:2113` (the API endpoint instance uses
  `:2112`), on every node. The image is the one of the API endpoint instance (`images.kube-vip` in
  `versions.yaml`), so both move together; the chart's own default tag is overridden. Its
  in-cluster credentials are fine here: the API server health check problem of ADR-0027 concerns
  the leader of the API endpoint, not Services.
- **The range is read per cluster** from the annotation `capi-navigator.io/loadbalancer-addresses`
  on the `ProxmoxCluster` in the preset's `valuesTemplate` (`.InfraCluster`), so one preset per
  namespace serves every cluster. The annotation also lets the overlap check (FP31-F-08) see the
  ranges of other clusters. Every change of the spec also changes the `Cluster` (stored spec
  annotation), which makes CAAPH render the values again.
- **Day-2: add ranges or remove all.** Dropping part of the ranges is refused: Services keep
  addresses they already have, and another cluster could then be given the same address.
  Removing all switches the feature off and uninstalls both presets.

## Consequences

- Clusters with LoadBalancer addresses need access to the kube-vip Helm repository on GitHub
  Pages and to ghcr.io (or mirrors), as for the CCM and CSI presets.
- No change to the bootstrap templates: adding the feature to a running cluster replaces no node.
- Admins can override both presets like every other one (FP8-F-14); a changed `valuesTemplate`
  that drops the range annotation breaks the address assignment.
- Two more chart entries in `versions.yaml`, checked by the update report.
