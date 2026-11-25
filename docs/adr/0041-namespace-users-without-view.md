# ADR-0041: Namespace users, a role without reading

- Status: accepted
- Date: 2026-11-25
- Pack: FP-37
- Refines: ADR-0015, FP19-F-02, FP19-F-04

## Context

Reading is global: every role includes `view`, and limits apply to actions only (ADR-0015). People
who only work in a managed namespace (FP-36) should get their tokens themselves, but must not see
all clusters, connections and add-ons.

Filtering the existing pages per person would need live streams per user instead of shared watches,
and cross references would still reveal names. So namespace users get a page of their own.

## Decision

- **Built-in role `namespace-user` without any permission**, not even `view`. The permission check
  no longer adds `view` to every role; the roles that read list it, custom roles always do. The
  name is reserved; a custom role of that name would lose its permissions.
- **Endpoints of FP-37 need a signed-in person**, no permission. What they return follows from the
  assignments alone, so they work for people of every role. API tokens are refused.
- **The assignment belongs to a service account in the form model** on the `HelmChartProxy`. It
  grants nothing else in the app.
- **An identity is never only a name.** A local user is stored with name and UID of the
  `NavigatorUser`, so a new user with the name of a deleted one gets nothing. An OpenID Connect
  person is stored with issuer and `sub`, a group with issuer and name.
- **Groups must be mapped in the app** (FP-14), because the session keeps only mapped groups.
- **The owner picks from a reduced list** (names, mapped groups and persons; no roles, no technical
  users), available with `clusters.access`.
- **Assigned people are only shown to `clusters.access`**, not to everybody who may read.

## Consequences

- A test runs the real guard for every endpoint and live stream, and checks the node shell.
- Changes of an assignment apply to the next request. Group membership is taken from the sign-in, so
  a person removed from a group at the provider keeps it until the session ends (FP14-F-06).
- Tokens already issued stay valid until they expire or are revoked (ADR-0040).
- The default role of OpenID Connect people is `viewer`. To admit people only as namespace users, an
  admin sets it to `namespace-user` or maps their group.
- Restoring the home cluster from a backup that does not keep UIDs (e.g. applying manifests) creates
  users with new UIDs; they must be assigned again.
