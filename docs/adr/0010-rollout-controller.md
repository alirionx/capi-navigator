# ADR-0010: Background rollout controller in the backend

- Status: accepted
- Date: 2026-10-18
- Pack: FP-7

## Context

A Kubernetes upgrade (FP7-F-08) must update the control plane first and the worker pools only
afterwards, so that kubelets never run a newer minor version than the API server. The RKE2
control plane provider rolls its machines on its own, but nothing in upstream Cluster API (without
ClusterClass) tells the MachineDeployments to wait. Template rotation (hard rule 5) also leaves
the old machine and bootstrap templates behind after every rollout (FP7-F-15).

Both need an actor that acts after the user's confirmed change, possibly long after the browser
was closed. The backend must stay stateless (hard rule 1).

## Decision

- A `RolloutControllerService` in the backend runs every 20 seconds. Only one replica acts at a
  time, elected through a `coordination.k8s.io` Lease (`capi-navigator-rollout-controller`, 60 s)
  in the app namespace.
- The upgrade state lives in the stored cluster spec: an upgrade sets `kubernetes.version` to the
  new version and keeps the old one in `kubernetes.workerVersion`. The transformation renders the
  MachineDeployments with `workerVersion` while it is set.
- Once the control plane reports the new version with all replicas up to date and ready, the
  controller removes `workerVersion` through the normal change pipeline (dry run, drift check,
  server-side apply with field manager `capi-navigator`). The user confirmed the whole upgrade
  in the preview, which lists both steps. An `AuditEvent` (`cluster.upgrade.workers`) records the
  second step.
- When nothing rolls, the controller deletes machine and bootstrap templates of the cluster that
  carry the app's managed-by label, are older than 10 minutes and are referenced by neither the
  control plane, a MachineDeployment nor a MachineSet.
- Clusters without the spec annotation, with a deletion timestamp, or with an unparsable spec are
  ignored.

## Consequences

- Workers start their rollout up to 20 seconds after the control plane is done.
- If the backend is not running, an upgrade pauses after the control plane step and continues when
  it is back. The cluster stays consistent and usable meanwhile (version skew of one step is
  allowed by Kubernetes).
- Uninstalling the app in the middle of an upgrade leaves the workers on the old version; the user
  can finish it with `kubectl` by setting the MachineDeployment versions.
- Drift on the MachineDeployments blocks the automatic worker step (the change pipeline refuses to
  overwrite it); the user resolves it via "Reapply" in the UI.
