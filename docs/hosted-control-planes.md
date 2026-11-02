# Hosted control planes (experimental)

A hosted control plane runs the Kubernetes API server, controllers and etcd of a k0s cluster (the
**tenant**) as pods in another cluster of the app (the **host**); only the tenant's workers are
machines. Tenants come up faster and need no control plane machines, and a control plane upgrade
is a pod rollout. The app uses k0smotron's `K0smotronControlPlane` with a remote host cluster
(FP-24, [ADR-0034](adr/0034-hosted-control-planes-with-k0smotron.md)). The feature is
**experimental**.

```
Management cluster                     Host cluster (a cluster of the app)      Tenant workers
┌──────────────────────────┐           ┌──────────────────────────────┐         ┌──────────────┐
│ Cluster (tenant)         │           │ namespace of the tenant:     │         │ k0s workers  │
│ K0smotronControlPlane ───┼kubeconfig▶│  kmc-<tenant>-0..2 (k0s)     │◀─join───│ from a       │
│ Infra cluster without    │  of host  │  kmc-<tenant>-etcd-0..2      │  API,   │ MachineDe-   │
│  API load balancer       │           │  Service kmc-<tenant>-lb     │  Konnec-│ ployment     │
│ MachineDeployment        │           │  (type LoadBalancer)         │  tivity │              │
└──────────────────────────┘           └──────────────────────────────┘         └──────────────┘
```

## Where it works

| Infrastructure | Tenant API address                                        | Notes                                                                                                    |
| -------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| OpenStack      | Octavia load balancer of the host's CCM (floating IP)     | The tenant's `OpenStackCluster` has no load balancer and no floating IP                                  |
| AWS            | Classic ELB of the host's CCM                             | Tenant workers get the control plane instance profile (see limits)                                       |
| Proxmox VE     | A LoadBalancer address of the host, announced by kube-vip | The app proposes the first free address; it is fixed as `externalAddress` and Service annotation         |
| Google Cloud   | not supported                                             | CAPG always creates its own API load balancer and overwrites the control plane endpoint with its address |

Tenants run on the infrastructure and credential of their host, in the host's namespace, with k0s.

## Setting up a host

1. Create a cluster (any distribution) with the **CCM** and the **CSI driver**; on Proxmox VE give
   it **LoadBalancer addresses** (FP-32), from which the tenants get their API addresses. Three or
   more nodes that run workloads (workers, or an all-in-one cluster with three nodes): a tenant
   with three replicas puts one controller and one etcd pod on each. A single node carries
   tenants with one replica.
2. Mark it as host: in the wizard (Topology → "Host for hosted control planes") or later in its
   Configuration tab. This sets the label `capi-navigator.io/hcp-host` on the `Cluster`; nothing
   inside the cluster changes.
3. Its overview then lists the tenants and the CPU and memory they request.

k0smotron reaches the host with the host's Cluster API kubeconfig Secret (`<host>-kubeconfig`) and
creates the tenant's pods, Service and volumes there; the app itself only reads the host.

## Creating a tenant

In the wizard choose k0s, then Topology → "Hosted control plane (experimental)": the host, one or
three replicas and the etcd volume size (default 1 GiB per replica, from the host's default
StorageClass). The preview checks that the host is available, marked, on the same infrastructure
and credential, has a worker per replica and, on Proxmox VE, that the API address is a free
LoadBalancer address of the host.

Per replica the control plane requests 100m CPU and 512 MiB (k0s controller) plus 50m and 128 MiB
(etcd), without limits; idle it uses about 55m and 420 MiB plus 15m and 45 MiB. One controller and
one etcd pod per host node (hard topology spread).

## Limits

- **Replicas are fixed** at creation: scaling makes k0smotron split etcd (its init script treats
  a single failed member list as "first member").
- **Host maintenance:** the tenant API pauses briefly while host nodes are replaced (load balancer
  failover; about 15 s for kube-vip on Proxmox VE), etcd keeps its quorum because the app replaces
  one host node at a time. There are no PodDisruptionBudgets: **do not drain several host nodes at
  once** by hand.
- **Deletion order:** a host with tenants cannot be deleted or unmarked; delete the tenants first.
  Deleting a tenant removes its pods, Service and volumes in the host.
- **AWS:** without control plane nodes, the CCM and the EBS CSI controller run on the tenant's
  workers, which therefore get the control plane instance profile: every pod on them can use its
  rights to load balancers, volumes and instances. Hosts on AWS have all nodes in one availability
  zone, since the app sets no failure domain per worker pool there.
- **Not available** air-gapped and on Google Cloud.
