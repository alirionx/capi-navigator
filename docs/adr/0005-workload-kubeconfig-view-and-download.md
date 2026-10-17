# ADR-0005: Showing and downloading workload cluster kubeconfigs

- Status: accepted
- Date: 2026-10-17
- Pack: FP-6

## Context

NF-01 and hard rule 8 say that credentials, including kubeconfigs, never appear in API responses
or the frontend. FP6-F-04 and US-08 require the opposite for one case: operators download the
kubeconfig of a workload cluster (Secret `<cluster>-kubeconfig`, created by CAPI). The user also
asked to show it in the UI, not only to download it.

## Decision

The workload kubeconfig is the one deliberate exception to NF-01, with these safeguards:

- Two endpoints, `GET …/clusters/:namespace/:name/kubeconfig` (shown in a dialog) and
  `…/kubeconfig/download` (attachment `<cluster>.kubeconfig`). Both require the operator role,
  checked in the backend.
- Responses carry `Cache-Control: no-store`; the frontend fetches with `cache: 'no-store'`, keeps
  the content only in the open dialog and drops it when the dialog closes (no Pinia store, no
  browser storage).
- Every view and download writes an `AuditEvent` (`cluster.kubeconfig.view` /
  `cluster.kubeconfig.download`) with actor, cluster and outcome, never the content. Requests
  rejected by the role guard are not audited, like all other endpoints.
- The content never appears in logs, live status streams or other responses; the status only
  says whether the Secret exists.
- The dialog warns that the file grants admin access to the cluster.
- Kubeconfigs of management cluster connections (FP-2) stay write-only; this exception covers
  only workload clusters.

## Consequences

- Operators get cluster-admin credentials of workload clusters through the app; the audit log
  shows who did.
- Displaying the content can expose it on screen (screen sharing, screenshots). The warning in the
  dialog points this out.
- Short-lived or OIDC-based workload access would be the safer long-term option (FP-14).
