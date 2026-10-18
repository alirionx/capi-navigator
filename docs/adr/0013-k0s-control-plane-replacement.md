# ADR-0013: No control plane replacement for k0s with fewer than 3 control plane nodes

- Status: accepted
- Date: 2026-10-18
- Pack: FP-9

## Context

k0s control planes are managed by k0smotron v2.2.0 with `updateStrategy: Recreate` (hard rule 5:
machines are replaced, not updated in place). The live test on Infomaniak upgraded a k0s cluster
with one control plane node from v1.34.11 to v1.35.8. Twice, with the same result:

1. The new control plane machine joined etcd (2 members); the API was unavailable for about
   10 seconds, as expected while a second member starts.
2. k0smotron marked the old etcd member to leave (`EtcdMember.spec.leave: true`).
3. About 30 seconds later etcd lost quorum for good (`readyz`: etcd failed). The old machine then
   hung in node draining, the new worker could not get a join token, and the cluster was lost.

With three or more control plane nodes, etcd keeps quorum while one member joins and another
leaves. k0smotron's documentation does not mention the single node case; no upstream issue was
found.

## Decision

- `BootstrapFlavorPlugin.safeControlPlaneReplacement` declares the smallest control plane size with
  which replacing control plane machines is safe. k0s sets 3; RKE2 sets nothing.
- The change preview blocks every change that replaces control plane machines (version upgrade,
  image or flavor change, customization, rebuild of the control plane) when the cluster has fewer
  control plane nodes. The message explains why and suggests scaling to 3 first. Worker changes
  stay possible.
- The wizard warns when k0s is chosen with one control plane node or all-in-one.
- k0smotron's `InPlace` strategy (autopilot) is not used as a fallback: it would update machines in
  place (hard rule 5) and still recreate them for image and configuration changes.

## Consequences

- k0s all-in-one clusters cannot be upgraded through the app; they are meant for short-lived tests.
- The rule can be lifted once k0smotron handles the 2 → 1 member transition; the incident logs are
  kept for an upstream report.
- Deleting such a broken cluster needs node draining skipped (see ADR-0006, update 2026-10-18).
