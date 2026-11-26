# ADR-0042: All traffic between the nodes of an AWS cluster

- Status: accepted
- Date: 2026-11-26
- Pack: FP-5 (AWS), refines ADR-0012

## Context

On AWS, CAPA v2.13.1 allows only the kubelet port (TCP 10250) between nodes. Following ADR-0012, the
AWS plugin added the CNI ports of the distribution and the ports of the control plane. Services in
the host network that are not on this list were unreachable from other nodes. A user of RKE2 on AWS
found 2 of 3 node exporter targets (TCP 9100) down; only the node running Prometheus answered.

On OpenStack (`allowAllInClusterTraffic`) and Google Cloud (CAPG's rule for the cluster's internal
traffic), all traffic between the nodes of a cluster is allowed.

Rules added by hand in the AWS console do not help: CAPA compares the security groups with its spec
on every reconcile and revokes rules that are not in it.

## Decision

- The AWS plugin sets one CNI ingress rule with protocol `-1` (all traffic). CAPA puts CNI rules
  into the control plane and node security groups, with both groups as source. The single CNI ports
  of the distribution are no longer listed; they are part of it.
- Nothing changes for traffic from outside: NodePorts, the API load balancer and the bastion keep
  their rules.

## Consequences

- AWS behaves like OpenStack and Google Cloud. Monitoring of the nodes, kube-proxy metrics and other
  services in the host network work without extra rules.
- A compromised node can reach every port of the other nodes of its cluster, as on the other clouds.
- CAPA adds the rule to existing security groups when the `AWSCluster` changes. Existing clusters get
  it with "Reapply from spec"; no machine is replaced for it.
