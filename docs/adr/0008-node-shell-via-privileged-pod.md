# ADR-0008: Node shell via a privileged pod

- Status: accepted
- Date: 2026-10-17
- Pack: FP-17

## Context

Troubleshooting needs a root shell on nodes of workload clusters and of the management cluster.
SSH through the bastion (FP5-F-20) needs keys, host key handling and a network path from the
backend; a web SSH terminal is on hold. Kubernetes offers `kubectl debug node`; tools like Lens
run a privileged pod on the node and `nsenter` into the host namespaces.

## Decision

- A session creates a pod in `kube-system` of the target cluster: `nodeName` set, `hostPID`,
  `hostNetwork`, `hostIPC`, privileged container, all taints tolerated (also on control plane and
  not-ready nodes), no service account token, `activeDeadlineSeconds: 3600`. Image `alpine:3.22`,
  configurable (`NODE_SHELL_IMAGE`, Helm value `nodeShell.image`) for mirrors (FP-16).
- The backend execs `nsenter --target 1 --mount --uts --ipc --net --pid -- bash -l` (fallback
  `sh`) with a TTY and relays it over a WebSocket to xterm.js; terminal resizes are forwarded.
- The WebSocket upgrade is checked like the REST API: session cookie, role, and same origin
  (browsers always send `Origin` on WebSockets; missing or foreign origins are refused, CSRF).
- Roles: workload cluster nodes need operator, management cluster nodes need admin, because root
  on the management cluster endangers every workload cluster.
- The pod is deleted when the session ends (window closed, `exit`, 15 minutes without input);
  leftovers from crashed backends are removed when the next session starts, and the deadline
  ends them anyway. Start and end are recorded as `AuditEvent`s (no terminal content).
- Workload clusters use the CAPI kubeconfig; the management cluster uses the connection. The
  minimal access manifest gets a Role in `kube-system` (pods, pods/exec) and node read access.
- New dependencies (approved): `ws` (backend, already a transitive dependency of
  `@kubernetes/client-node`), `@xterm/xterm` and `@xterm/addon-fit` (frontend, lazy loaded).

## Consequences

- Works only on nodes that joined the cluster and run kubelet; for bootstrap failures SSH via the
  bastion remains the way.
- Pod Security Admission must allow privileged pods in `kube-system` (the default, also in RKE2).
- The connection test (FP-2) does not yet check the shell permissions of the minimal role; this
  would need an extension of the ManagementCluster status schema.
- Terminal content is not recorded; only who opened a shell on which node and when.
