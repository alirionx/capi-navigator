# ADR-0007: Bastion host via the providers' built-in bastion

- Status: accepted
- Date: 2026-10-17
- Pack: FP-5 / FP-6 extension (FP5-F-20)

## Context

Troubleshooting needs SSH access to nodes, but public IPs on every node widen the attack surface
and cost money. Both providers have a built-in bastion host: CAPO `OpenStackCluster.spec.bastion`
and CAPA `AWSCluster.spec.bastion`. Verified against CAPO v0.15.0 and CAPA v2.13.1:

- CAPA restricts SSH to the bastion with `allowedCIDRBlocks` and lets the nodes accept SSH from it.
- CAPO creates a bastion security group whose SSH rule has no source restriction
  (`pkg/cloud/services/networking/securitygroups.go`); there is no field to change it. The nodes
  accept SSH only from the bastion security group. Restricting it would need an own ORC
  `SecurityGroup` on the bastion port plus a `clouds.yaml` Secret in the cluster namespace.
- Both bastions take only a cloud key pair (`sshKeyName`), no cloud-init keys.
- A running bastion cannot be changed; CAPO requires `enabled: false` (with spec) before the
  bastion block may be removed.

## Decision

- The bastion is optional (default off), configured in the wizard and switchable as a day-2 change
  without rebuilding nodes (it lives on the infrastructure cluster, not on machine templates).
- AWS requires at least one allowed source network. OpenStack takes no networks; the app shows a
  clear warning that SSH to the bastion is open to the internet (decision of the product owner:
  no ORC workaround for now).
- An enabled bastion requires a cloud key pair. Size or image of a running bastion cannot change;
  the app asks to switch it off first. Disabling keeps the spec with `enabled: false`.
- The detail view shows the bastion address and a ready-to-copy `ssh -J` command per machine.

## Consequences

- No per-node public IPs; one entry point that can be switched off when not needed.
- On OpenStack the bastion is reachable from anywhere on port 22 (key login only). Revisit when
  CAPO supports source restrictions, or implement the ORC variant.
- A web terminal (SSH through the bastion) and a node shell via privileged pod are separate packs.
