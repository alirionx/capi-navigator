# ADR-0026: OpenStack volumes not bound to an availability zone (optional)

- Status: accepted
- Date: 2026-10-22
- Refines: FP5-F-09 (CCM/CSI presets), [ADR-0011](0011-helm-addons.md)

## Context

The Cinder CSI driver reports topology by default: every new PersistentVolume gets a node affinity
for the availability zone of its volume, and the scheduler keeps pods with that volume in that
zone. When the only node of an all-in-one cluster was replaced on 2026-10-22, the new VM came up in
another zone and a StatefulSet pod could not be scheduled. Many OpenStack clouds attach volumes
across zones (Nova `cross_az_attach`, the default; verified on Infomaniak by hotplugging a volume
of `az-1` into a VM in `az-2`).

Checked against cloud-provider-openstack (chart and driver 2.37.1, `controllerserver.go`):

- `[BlockStorage] ignore-volume-az = true` does not help: the PV then gets the preferred zone of
  the provisioning request, which is the zone of the first node, so it stays zone-bound.
- `--with-topology=false` returns no topology at all, so PVs have no node affinity. The chart sets
  it in both plugins from `csi.provisioner.topology`.

## Decision

- OpenStack clusters get the switch `infrastructure.zoneBoundVolumes` (default `true`, the
  driver's default), offered by the OpenStack plugin in the wizard.
- Off, the transformation labels the `Cluster` with `capi-navigator.io/volume-topology=off`. The
  Cinder CSI preset reads the label per cluster through a CAAPH template and sets
  `csi.provisioner.topology` to `false`, so one preset per namespace serves clusters with either
  setting.
- The switch is set at creation only. Existing clusters keep their setting; an admin override of the
  preset values (FP8-F-14) can still switch a whole namespace.

## Consequences

- Only volumes created after the switch are free of a zone; existing PVs keep their node affinity
  (immutable).
- On clouds without cross-zone attach, pods are scheduled to nodes that cannot attach the volume
  and hang at attach instead of at scheduling; the help text says so, and the default stays on.
- Existing presets differ from the new preset version and are updated like any preset change.
- A preset override replaces the preset values completely, including the template: with an
  override in place, the override decides for all clusters.
- Changing the switch for an existing cluster (a day-2 change that only changes the label) can be
  added later without changing this design.
