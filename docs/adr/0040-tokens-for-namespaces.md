# ADR-0040: Time-limited tokens for managed namespaces

- Status: accepted
- Date: 2026-11-24
- Pack: FP-36
- Refines: NF-01, hard rule 8 (extends ADR-0005)

## Context

People who work in a managed namespace need a credential. NF-01 and hard rule 8 keep credentials
out of API responses. ADR-0005 makes one exception, for the kubeconfig of a workload cluster.

A Secret of type `kubernetes.io/service-account-token` could be part of the add-on (its token is
filled in by the workload cluster, so nothing secret is in the `HelmChartProxy`). But that token
never expires, Kubernetes calls the type legacy, and reading it needs the API of the workload
cluster all the same.

## Decision

- **TokenRequest API**, called with the kubeconfig that CAPI writes, like dashboard and node shell.
  Lifetime 10 minutes to 7 days, default 7 days, checked by the app. The expiry the API server
  grants is shown.
- **Bound to a Secret per token** in `capi-navigator-accounts`. The Secret is empty; its annotations
  name account, creator and expiry. Deleting it revokes this one token. The list of tokens is read
  from these Secrets.
- **Returned once**, as token or kubeconfig, with `Cache-Control: no-store`; kept only in the open
  dialog. Never stored, logged, streamed or audited. Every issued and revoked token writes an
  `AuditEvent` without it.
- Permission `clusters.access`, scoped like the other `clusters.*` permissions.

## Consequences

- Measured on 2026-11-24: a revoked token still worked after 6 seconds and was refused after 16,
  because the API server caches authentication. The dialog says "within seconds".
- Removing an account invalidates all its tokens, also when an account of the same name follows.
- Nobody can read a token again; a lost one is revoked and replaced.
