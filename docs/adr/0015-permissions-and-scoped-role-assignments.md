# ADR-0015: Permissions and scoped role assignments

- Status: accepted
- Date: 2026-10-18
- Pack: FP-19

## Context

FP-1 has three fixed roles; every endpoint names a minimum role and the guard compares a rank.
Teams sharing one management cluster want, for example, "operator only in namespace `team-a`",
and admins want roles between the built-in ones (e.g. day-2 changes without deleting clusters or
reading kubeconfigs). Requirement FP-19 left three questions open: the granularity of
permissions, whether assignments are scoped, and whether lists are filtered by scope.

## Decision

- **Permissions instead of ranks.** 14 permissions (requirements FP-19) are defined once in
  `packages/shared`. Every endpoint and the node shell WebSocket declare one permission
  (`@Requires`) instead of a minimum role. Assigning add-ons by label stays part of
  `clusters.change`, because it is a label change on the `Cluster`.
- **Built-in roles in code.** viewer, operator and admin are constants with exactly the access of
  FP-1; they cannot be changed or deleted, only copied. A test pins the endpoint matrix of the
  built-in roles. Custom roles are `NavigatorRole` resources in the app namespace.
- **Several assignments per user**, like Kubernetes RoleBindings: `bindings: [{ role,
connections?, namespaces? }]` on `NavigatorUser`. Without limits an assignment applies
  everywhere. Limits use connection and namespace, the units in which CAPI clusters, credential
  permissions and add-ons live. Limited assignments may only carry scopable permissions;
  platform permissions (providers, credentials, connections, repositories, presets, users,
  management node shell) need an unlimited assignment.
- **Limits apply to actions, not to reading.** Every user sees all clusters, add-ons and events.
  Filtering would need live channels per user instead of shared watches, and cross references
  (add-on selectors, provider usage, events) would still reveal names from other namespaces.
- **Resolved per request.** The session cookie carries only user and session generation; the
  guard reads the user's assignments and the roles from the informer cache on each request, so
  changes apply immediately. Removing a permission does not require a session reset.
- **Endpoints without a namespace** (cloud lookups, chart browsing, credential list for the
  wizard) require the permission for at least one namespace of the connection; the namespace
  check happens on the actual create or change.
- **Migration**: a stored `spec.role` is read as one unlimited assignment of that role; it is
  rewritten as `bindings` on the next change of the user. No manual step.
- **Lock-out protection** extends FP-1: at least one enabled user must keep an unlimited
  assignment with `users.manage`.

## Consequences

- Users with a limited assignment still see the names of clusters and add-ons in other
  namespaces. Filtering what users can read is possible later (requirements, outlook).
- `users.manage` is effectively admin: whoever can edit roles can grant themselves everything.
- FP-14 (OIDC) maps group claims to the same assignments.
