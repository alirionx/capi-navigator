# ADR-0022: Distributions behind the Google Cloud API load balancer

- Status: accepted
- Date: 2026-10-20
- Pack: FP-25
- Refines: [ADR-0012](0012-flavor-network-requirements.md), FP25-F-06

## Context

CAPG v1.13.1 creates the API load balancer itself (cloud/services/compute/loadbalancers): a
global external TCP proxy with **one** forwarding rule. It listens on
`Cluster.spec.clusterNetwork.apiServerPort` (default 443), forwards to 6443 and checks the
backends with HTTPS `GET /readyz` on 6443, without credentials. There is no way to add ports;
the internal variant forwards only the API port plus 22623 (OpenShift).

The distributions need more than that (ADR-0012):

- **k0s:** k0smotron v2.3.0 sets `spec.api.externalAddress` to the endpoint host. Nodes reach the
  API there on 6443, Konnectivity agents on 8132, joining controllers the join API on 9443.
- **RKE2:** registers nodes on 9345, already through the control plane's internal IPs
  (`registrationMethod: internal-first`). Its API server turns anonymous requests off.
- **kubeadm:** reaches the API through the endpoint; anonymous requests are allowed by default.

CAPG's default firewall rules allow all traffic between the cluster's machines
(`allow-<cluster>-cluster`), so node-to-node traffic needs nothing extra.

At first k0s looked impossible on Google Cloud. k0rdent's template `gcp-standalone-cp` (pointed
out by the user) shows how it works, and the k0smotron source confirms it.

## Decision

The infrastructure plugin describes the limits of its load balancer (`apiLoadBalancer`), and the
distributions adapt; no distribution knows about Google Cloud:

- **Port 6443.** Clusters on Google Cloud set `clusterNetwork.apiServerPort: 6443`, so the
  endpoint is where k0s expects the API, and all distributions use the usual port.
- **API port only → k0s without Konnectivity.** The k0s controllers run with
  `--disable-components=konnectivity-server`; the API server reaches the kubelets directly
  (allowed by CAPG's cluster rule). Further controllers join on 9443 through the first
  controller's internal IP: k0smotron v2.3.0 tries the endpoint first and falls back to it
  (controlplane_bootstrap_controller.go). Three and five control plane nodes keep working.
- **Anonymous health check → RKE2 allows anonymous requests** (`anonymous-auth=true`); k0s has
  it already, kubeadm by default. With the default RBAC, anonymous requests can read only health
  and version endpoints (`system:public-info-viewer`).
- **Network.** Each cluster gets its own VPC named after the cluster with one subnet; CAPG adds
  Cloud NAT and deletes both with the cluster, so nodes need no public IP.

## Consequences

- RKE2, k0s and kubeadm run on Google Cloud with one, three or five control plane nodes.
- k0s on Google Cloud has no Konnectivity: `kubectl logs/exec` go straight from the API server to
  the kubelet, which works because all nodes share the VPC.
- Anonymous requests to the RKE2 API server on Google Cloud are possible, limited by RBAC to
  health and version. OpenStack and AWS keep their behaviour; their snapshots are unchanged.
- To verify live (FP-25 acceptance): the health check turns healthy for RKE2 and k0s, and a
  k0s control plane with three nodes joins through the fallback.
