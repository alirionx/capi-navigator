# ADR-0036: Workload logs in the dashboard

- Status: accepted
- Date: 2026-11-04
- Pack: FP-18 (FP18-F-07)
- Refines: FP18-F-05 (dashboard readable by viewers), hard rule 8 (secrets stay secret), ADR-0009

## Context

The dashboard (FP-18) shows which workloads are not ready, but finding out why still needs
`kubectl logs` with the cluster's kubeconfig. Users asked for the logs of a workload in a dialog.

The dashboard is readable by everybody with `view` and never reads Secret or ConfigMap content.
Logs are different: applications print tokens, connection strings and customer data, often in
error messages. Handing them to every viewer would widen what a viewer can read far beyond the
cluster's state.

## Decision

- **A permission of its own**, `clusters.logs`: in the built-in roles operator and admin, scopable
  to connections and namespaces like `clusters.kubeconfig`. Viewers keep the dashboard without logs.
  A custom role can grant logs without the kubeconfig or the node shell.
- **Audited like the kubeconfig**: every read is a sensitive read (`cluster.logs.view` in the
  audit log, with user and token name).
- **Pass-through only**: the backend reads with the cluster's kubeconfig, returns the text and
  neither logs nor caches it (`Cache-Control: no-store`). The browser keeps it in the dialog and
  drops it on close; the download is built in the browser from what is shown.
- **Bounded reads, no streaming**: one container, the newest 100 to 5,000 lines, at most 2 MiB,
  with `previous` for crashed containers. "Read again" fetches anew; there is no follow mode, so
  the audit log gets one entry per read instead of a stream.
- **Pods through the workload's selector**: Deployment, StatefulSet, DaemonSet and Job are resolved
  through `spec.selector`; an empty selector reads nothing. Without a choice the backend picks the
  most interesting pod (not ready, then most restarts) and the container `kubectl logs` would
  pick (`kubectl.kubernetes.io/default-container`, else the first).

## Consequences

- One more permission in the roles page and in the `NavigatorRole` CRD (enum of permissions).
- Custom roles created before do not get `clusters.logs`; admins add it where wanted.
- A follow mode (streaming through SSE or WebSocket) remains possible later; it would need one
  audit entry per stream and a limit on open streams.
