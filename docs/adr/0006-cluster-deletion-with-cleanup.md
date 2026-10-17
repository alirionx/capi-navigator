# ADR-0006: Cluster deletion with cleanup inside the workload cluster

- Status: accepted
- Date: 2026-10-17
- Pack: FP-6

## Context

FP-6 requires that deleting a cluster removes all of its OpenStack resources. The FP-5 live tests
showed that CAPO does not remove load balancers, floating IPs and volumes that the OpenStack CCM
and Cinder CSI create for `LoadBalancer` services and PVCs; the leftover floating IP blocked the
deletion of the cluster router, and the volume stayed. CAPA removes the CCM's load balancers, but
not volumes. PVCs that pods still use cannot be deleted (`pvc-protection`). The backend must stay
stateless (STATE-04), but waiting for the cloud to release resources takes minutes.

## Decision

- Deleting is confirmed by typing the cluster name; external clusters (no stored spec) are
  read-only.
- With cleanup (default, can be switched off), the backend uses the workload kubeconfig to delete
  all non-system namespaces, the workloads in `default`, all `LoadBalancer` services and all PVCs,
  while CCM and CSI still run. System namespaces (`kube-*`, `default`, `calico-*`, `tigera-*`,
  `cattle-*`, `cilium*`) stay.
- It then waits (poll 10 s, timeout 10 min) until no `LoadBalancer` service and no volume with
  reclaim policy other than `Retain` remains, and only then deletes the CAPI `Cluster` (CAPI
  cascades) and the app's helper objects (cloud config Secret, ClusterResourceSet).
- Progress is stored as annotation `capi-navigator.io/deletion` on the Cluster (merge patch, so it
  can never re-create a deleted Cluster) and shown live. On timeout the phase is `cleanup-timeout`
  with the remaining resources; the user can delete again, with or without cleanup.
- Volumes with reclaim policy `Retain` are listed in the preview and stay in the cloud.

## Consequences

- Verified on Infomaniak and AWS: a cluster with a LoadBalancer service and a bound PVC was
  deleted through the app and nothing remained on OpenStack.
- If the backend restarts during the cleanup, the annotation stays in `cleanup`; deleting again
  continues. A controller loop would remove this gap but is not needed for the MVP.
- Data in PVCs is lost; the dialog says so.
- A read-only check for leftovers in the cloud after deletion (proposed as SHOULD in the FP-6
  plan) is deferred.
