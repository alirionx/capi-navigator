# ADR-0013: k0s control plane replacement

- Status: accepted; updated 2026-10-20 for k0smotron v2.3.0 and 2026-10-28 (replacement for all
  sizes, no in-place upgrades; see below)
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

## Update 2026-10-28: replacement for all sizes, no in-place upgrades

Two things changed the trade-off:

- **Air-gapped nodes (FP29-F-16):** with `InPlace`, k0smotron creates an autopilot `Plan` whose
  `k0supdate` downloads the new k0s binary on every control plane node with a plain HTTP GET
  (no registry token, and k0smotron sets no checksum). Registries such as Harbor answer that with
  401, even for public projects, so in-place upgrades cannot work air-gapped. Replaced machines
  download the binary like at creation (token, sha256 check).
- **Upstream fix:** k0smotron #1705 (scale down waits until deleted machines are gone) was merged
  on 2026-10-23 after our report (#1703); it is not released yet. A second user confirmed the
  same behaviour on bare metal.

Decision:

- k0s control planes use `updateStrategy: Recreate` for every change, version upgrades included,
  like RKE2 and kubeadm (hard rule 5 without exception). The webhook allows the switch on existing
  clusters (only `--single` forbids it); existing clusters change with their next control plane
  change.
- With k0smotron v2.3.0 or later, replacement is allowed for one, three and five nodes. The
  measured risk with three or five nodes (old machines deleted within a minute, etcd on one member
  for about two minutes, the API unreachable for about five seconds) is accepted for now, without
  a warning in the UI. Before v2.3.0 replacement stays blocked.
- Once a k0smotron release contains #1705, re-test a three-node rollout live and record the
  result here.
