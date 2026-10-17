# ADR-0009: Polling for the read-only cluster dashboard

- Status: accepted
- Date: 2026-10-18
- Pack: FP-18

## Context

NF-11 asks for watches instead of polling for lists and status. The cluster dashboard (FP-18)
shows resource usage from `metrics.k8s.io`, which cannot be watched, plus pods, workloads,
services, ingresses and events of a workload cluster. Watching all pods and events of every
workload cluster from the backend would cost far more than a periodic read, and the dashboard is
only useful while somebody looks at it.

## Decision

- The dashboard is read every 15 seconds and pushed via server-sent events, only while at least
  one browser shows it (the tab subscribes when opened); viewers of the same cluster share one
  read.
- Reads use the cluster's CAPI kubeconfig: nodes, pods, namespaces, deployments, statefulsets,
  daemonsets, jobs, services, ingresses, HTTPRoutes (if the Gateway API exists), events (newest
  500, shown 100) and node metrics. Secrets and ConfigMaps are never read.
- Missing parts (no metrics-server, missing permissions, no Gateway API) become hints; only
  nodes and pods are required.
- Viewers may read the dashboard; it has no actions.

## Consequences

- Up to 15 seconds delay for the dashboard; the CAPI status views keep using watches (NF-11).
- Load on a workload cluster: about 12 list calls every 15 seconds while the dashboard is open.
- Without metrics-server (e.g. kubeadm, FP-10) the bars show requests and limits only.
