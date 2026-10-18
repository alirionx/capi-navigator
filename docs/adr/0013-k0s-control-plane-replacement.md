# ADR-0013: k0s control planes are upgraded in place and never replaced

- Status: accepted
- Date: 2026-10-18
- Pack: FP-9

## Context

Hard rule 5 makes every machine-affecting change replace machines with new templates. For k0s,
control plane machines are replaced by k0smotron (`updateStrategy: Recreate`). The live tests on
Infomaniak with k0smotron v2.2.0 failed three times:

- One control plane node, upgrade v1.34.11 → v1.35.8 (twice): the new controller joined etcd, then
  k0smotron marked the old member to leave and etcd lost quorum about 30 seconds later.
- Three control plane nodes, same upgrade: after the first replacement was ready, k0smotron deleted
  all three old machines within 41 seconds and marked their etcd members to leave; etcd lost
  quorum.

The cause is in k0smotron (`internal/controller/controlplane/scale.go`, identical in v2.1.1):
`isNeededScaleDown` scales down as long as any machine is not up to date and does not wait for
machines that are already being deleted; with node draining in progress, it removes one old machine
(and etcd member) per reconcile before replacements exist. `RecreateDeleteFirst` uses the same code
path. Worker machines are not affected: Cluster API replaces them through MachineDeployments.

## Decision

- k0s control planes use k0smotron's `InPlace` strategy: version upgrades run via k0s autopilot,
  one node at a time, without replacing machines. This is a deliberate exception to hard rule 5,
  limited to the k0s version of the control plane. Worker pools still follow by machine replacement.
- `BootstrapFlavorPlugin.controlPlaneUpdates` declares this (`versionInPlace`) and a reason why
  control plane machines must not be replaced (`replacementBlocked`). The rollout plan shows
  version-only control plane changes as "updated in place".
- The change preview blocks every change that would replace k0s control plane machines: image,
  flavor, root disk, customization and rebuild of the control plane. Worker changes stay possible.
- The wizard shows the limitation when k0s is chosen.

## Consequences

- k0s control plane nodes keep their image; a new image reaches them only by recreating the
  cluster, until k0smotron replaces machines safely. FP-9's acceptance criterion "rebuilt from a new
  image" is met for worker pools only.
- The incident logs are kept for an upstream report; the block is lifted once a fixed k0smotron
  version is verified.
- Deleting a cluster whose API is gone needs node draining skipped (ADR-0006, update 2026-10-18).
