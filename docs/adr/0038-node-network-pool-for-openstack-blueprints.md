# ADR-0038: Node network pool for OpenStack blueprints

- Status: accepted
- Date: 2026-11-09
- Pack: FP-34
- Refines: FP34-F-14 (address pool), FP5-F-21 (free node network on OpenStack)

## Context

All clusters of an OpenStack blueprint get the node network of its base spec. Each cluster has its
own network and router, and most clouds accept the overlap (two clusters with `10.6.0.0/24` ran side
by side on Infomaniak). Some clouds refuse it: on an OpenStack with a routed VRF per project, all
routed subnets of a project share one VRF. CAPO creates the second cluster's network and subnet,
then attaching the subnet to the cluster's router fails with the Neutron error
`SubnetOverlapInRoutedVRF`. The order is accepted, but the cluster never becomes ready, and a
client such as a service broker sees "in progress" until it gives up.

So such a blueprint serves one cluster at a time. One blueprint per cluster is no option for a
service offering. The broker cannot choose a network itself: it uses only the app's API, keeps no
state and cannot see the subnets of the project. The app cannot tell from the API whether a cloud
refuses overlaps.

## Decision

- **A pool in the blueprint, not a parameter.** An OpenStack blueprint can carry networks in its
  existing `addressPool` field, e.g. `10.7.0.0/16`. For every order the app takes the first network
  of the size of the base spec's node network (e.g. `/24`) that overlaps nothing in use. The client
  needs no knowledge of networks, and the parameter schema of the blueprint stays the same.
- **Optional, but suggested.** A blueprint without a pool keeps its fixed network, as before. The
  blueprints page suggests the /16 of the node network for a new OpenStack blueprint: separate
  networks per cluster are good practice beyond strict clouds, because networks of a project (or a
  VPN) can only be routed to each other without overlaps. On Proxmox VE the address pool stays
  required.
- **What counts as used:**
  - the node networks (`managedSubnets`) of all `OpenStackCluster` objects in the management
    cluster. These exist right after an order, before CAPO has created the subnet, so two orders
    in a row never get the same network. Orders of a connection already run one after another
    (FP34-F-14);
  - the subnets the credential sees in its project, read through the selection list `subnets`,
    so networks made outside the app are skipped too.
- **All OpenStack clusters, not only those of the same credentials.** Projects cannot be told
  apart reliably from the cluster objects. At worst a network stays unused that another project
  could have had; two clusters of one project never share one.
- **Refuse rather than guess.** If the subnets or the infrastructure clusters cannot be read, the
  order is refused (`502`) instead of handing out a network that might be taken. A used-up pool
  is refused with `409` and a message that names the pool.
- **One pool interface.** The infrastructure plugin's `addressPool` describes what a pool holds
  (addresses or networks), whether it is required, whether hosted control planes may use it, an
  optional selection list of used values and the check of its entries (hard rule 10). Proxmox VE
  and OpenStack implement it; other providers are unchanged.
- **Hosted control planes included.** A tenant on OpenStack has a node network of its own, so the
  pool applies to blueprints of hosted control planes as well; on Proxmox VE they stay excluded.

## Consequences

- A blueprint on a cloud with a VRF per project serves as many clusters as its pool has networks.
- A deleted cluster frees its network only when CAPO has removed the subnet; shortly after a
  deletion a nearly used-up pool may answer `409`.
- Creating from a pool needs a reachable cloud API at order time, which the cluster itself needs
  anyway.
- The wizard keeps suggesting a free network and warning about overlaps without blocking
  (FP5-F-21); the warning now names clouds with a routed VRF per project as an example.
- A broker needs no change: the pool is not a parameter, and the `409` reaches it like every other
  refusal of the app.
