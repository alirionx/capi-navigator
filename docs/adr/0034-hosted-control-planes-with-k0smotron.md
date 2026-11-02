# ADR-0034: Hosted control planes with k0smotron on an app-created host cluster

- Status: accepted
- Date: 2026-11-02
- Pack: FP-24
- Refines: the FP-24 outlook (control planes in the management cluster)

## Context

The FP-24 outlook placed hosted control planes in the management cluster. A local kind cluster
cannot serve as host (workers in the cloud cannot reach it), and the management cluster should not
carry tenant workloads. k0smotron v2.3.1 can run a `K0smotronControlPlane` in another cluster
(`spec.remoteHostCluster.kubeconfigRef`); nothing has to be installed there. Spikes on 2026-11-01
on OpenStack (Infomaniak), Proxmox VE 9.2 and AWS (eu-central-1) with hosts created through the
app and tenants as YAML showed that this works on all three, with the conditions below. Kamaji
publishes only edge builds, so it stays out (pinned stable versions, NF requirements).

## Decision

- **Host = workload cluster of the app.** The Cluster API objects of tenant and host stay in one
  management cluster. k0smotron reaches the host with the host's Cluster API admin kubeconfig
  Secret (`<host>-kubeconfig`), rotated by Cluster API. The app itself still writes nothing into
  workload clusters. Risk: the k0smotron controller has full access to the host; a host therefore
  carries only tenant control planes ("pure host", marked by a label).
- **Tenants only on the host's infrastructure and credential**, k0s only, one or three replicas fixed
  at creation: scaling from one to three split etcd in the spike (k0smotron's init script treats a
  single failed member list as "first member").
- **Placement without PodDisruptionBudgets.** k0smotron sets only preferred anti-affinity, and two
  of three etcd pods shared a node even with three workers. The app adds hard topology spread per
  host node: `topologySpreadConstraints` for the controller pods, `patches` for the etcd
  StatefulSet. App rollouts replace one host node at a time, which kept etcd intact in all spikes;
  PDBs would need the app to write into the host and are left out (documented: do not drain several
  host nodes at once).
- **Fixed requests, no limits:** controller 100m / 512 MiB, etcd 50m / 128 MiB per replica (idle use
  measured at about 55m / 420 MiB and 15m / 45 MiB), so hosts can be sized without throttling or
  OOM kills of an API server.
- **Infrastructure clusters without API load balancer**, waiting for the endpoint k0smotron writes:
  OpenStack without managed load balancer and without floating IP (CAPO otherwise fails with
  "unable to determine control plane endpoint" until then), AWS with `loadBalancerType: disabled`,
  Proxmox VE with `externalManagedControlPlane`.
- **Proxmox VE: fixed tenant address.** kube-vip-cloud-provider assigns an address, but kube-vip
  sets `status.loadBalancer` only once the Service has endpoints, while k0smotron creates the pods
  only after it sees that status: a deadlock (20 minutes in the spike). The app proposes a free
  address from the host's LoadBalancer range and sets `externalAddress` plus the
  `kube-vip.io/loadbalancerIPs` annotation through `patches`.
- **AWS: tenant workers with the control plane instance profile**, because CCM and EBS CSI controller
  must run on workers; the wizard warns that pods there can use these rights (IMDS hop limit 2).
- **CCM and CSI presets** branch on `K0smotronControlPlane` and drop the control plane node
  selector per chart: `null` removes a key the chart sets (AWS CCM), an empty map replaces an empty
  default (Proxmox CCM; there `null` was rendered as an empty string and matched no node).
- **Google Cloud is not supported for tenants:** CAPG v1.13.1 (and main as of 2026-11-01) has no
  load balancer type without load balancer and sets `controlPlaneEndpoint` to its own load
  balancer on every reconcile, whose backends are the control plane machines a tenant does not have.

## Consequences

- A new topology mode "hosted" for k0s, a hook in the infrastructure plugins for clusters without
  API load balancer, tenant-aware address checks and a delete lock for hosts with tenants.
- Tenant APIs pause briefly while host nodes are replaced (load balancer failover; about 15 s for
  kube-vip on Proxmox VE). Hosts on AWS have all nodes in one availability zone, since the app sets
  no failure domain per worker pool there.
- Prerequisite fixed on the way: on AWS the NLB ports of k0s were open only to node security
  groups, so Konnectivity never connected and k0smotron could not fetch tenant kubeconfigs
  (ADR-0012, FP9-F-04).
- Re-evaluate when k0smotron fixes etcd scaling (then allow day-2 scaling) and when CAPG accepts an
  external endpoint (then Google Cloud).
