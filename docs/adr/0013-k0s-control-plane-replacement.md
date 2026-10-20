# ADR-0013: k0s control planes are upgraded in place and never replaced

- Status: accepted; updated 2026-10-20 for k0smotron v2.3.0 (see below)
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

- OS updates of k0s control plane nodes run on the nodes: the Ubuntu cloud images apply security
  updates with `unattended-upgrades`, and the optional kured preset (`addons.rebootDaemon`, chart
  kured 6.1.0) reboots nodes one at a time with drain when `/var/run/reboot-required` exists. A new
  OS release (e.g. 22.04 → 24.04) for the control plane needs a new cluster for now.
- k0s control plane nodes keep their image; a new image reaches them only by recreating the
  cluster, until k0smotron replaces machines safely. FP-9's acceptance criterion "rebuilt from a new
  image" is met for worker pools only.
- The incident logs are kept for an upstream report; the block is lifted once a fixed k0smotron
  version is verified.
- Deleting a cluster whose API is gone needs node draining skipped (ADR-0006, update 2026-10-18).

## Update 2026-10-20: k0smotron v2.3.0

k0smotron v2.3.0 changed the scale down (`reconcileMachineDeletions`): while a deleted control
plane machine is still draining, it waits instead of removing the next one, and it marks the etcd
member to leave only after the drain (#1690). `isNeededScaleDown` is unchanged. Live tests on
Infomaniak (k0s v1.35.8, CAPO v0.15.0, a control plane rebuild through the app):

- **One control plane node:** clean. The replacement joined etcd (two healthy members), then the
  old machine drained for 26 seconds, its member left, and it was removed. The API never became
  unreachable.
- **Three control plane nodes:** quorum kept, but not one node at a time. After the first
  replacement was ready (four members), k0smotron deleted all three old machines within 53
  seconds, because it continues as soon as a deleted machine waits for its pre-terminate hook.
  The members left one by one, so etcd shrank 4 → 3 → 2 → 1 without losing quorum, and the API
  was unreachable once for about five seconds. For two minutes the control plane ran on a single
  etcd member, until two more replacements had joined.

The tests also showed an app bug: k0smotron v2.3.0 prefers
`machineTemplate.spec.infrastructureRef` and its webhook fills it from the deprecated reference
only while it is empty; nobody owns the filled field, so server-side apply kept it on the old
template and a rebuild changed nothing. The app now writes both references.

Decision:

- With k0smotron v2.3.0 or later installed, changes that replace control plane machines are
  allowed for control planes with **one** node. The change preview checks the installed version.
- Control planes with three or five nodes stay blocked with the measured reason: losing
  redundancy for minutes is not acceptable for a highly available control plane. Version upgrades
  keep running in place.
- The logs of both runs are kept for an upstream report (scale down should wait until a deleted
  machine is gone, as Cluster API's KubeadmControlPlane does). Re-test with every k0smotron
  release.
