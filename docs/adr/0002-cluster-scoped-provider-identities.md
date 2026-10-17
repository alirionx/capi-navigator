# ADR-0002: Cluster-scoped provider identities for credentials

- Status: accepted
- Date: 2026-10-17
- Pack: FP-4

## Context

FP4-F-03 asks to store OpenStack credentials "as a Kubernetes secret in the target namespace of
the management cluster". With several cluster namespaces, the same `clouds.yaml` would have to be
copied into each of them, and rotating credentials would mean updating every copy.

Both infrastructure providers offer cluster-scoped identities (verified on 2026-10-17):

- CAPO v0.15.0: `OpenStackClusterIdentity` references a Secret with `clouds.yaml` (and optional
  `cacert`) and restricts its use with `namespaceSelector`. Clusters use
  `identityRef: { type: ClusterIdentity, name, cloudName }`.
- CAPA v2.13.1: `AWSClusterStaticIdentity` references a Secret (`AccessKeyID`, `SecretAccessKey`,
  optional `SessionToken`) in the CAPA controller namespace and restricts its use with
  `allowedNamespaces`.

## Decision

Each stored credential is one Secret in the provider's namespace (`capo-system`, `capa-system`)
plus one cluster-scoped identity that lists the namespaces allowed to use it. Display name and the
last test result are annotations on the Secret; no extra CRD is needed. The Secret keys follow the
format the provider expects (`clouds.yaml`/`cacert`, `AccessKeyID`/`SecretAccessKey`).

## Consequences

- Credentials are stored once and can be rotated in one place.
- Workload clusters reference the identity, not a Secret in their own namespace (FP-5).
- The OpenStack CCM and Cinder CSI in workload clusters still need a cloud config; FP-5 derives it
  from the identity's Secret (FP5-F-10).
- Allowed namespaces must be maintained; FP-5 offers to add a cluster's namespace when needed.
