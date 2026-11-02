# ADR-0012: Kubernetes distributions declare their network needs

- Status: accepted
- Date: 2026-10-18
- Pack: FP-9

## Context

FP9-F-07 asks that k0s is added without changes to the OpenStack plugin. k0s, however, needs the
API load balancer to forward two more ports besides 6443: 8132 (Konnectivity) and 9443 (controller
join API), as stated in the k0s high availability documentation. The AWS plugin already contained
an RKE2-specific rule (supervisor port 9345) and the Calico rules of RKE2, which breaks hard rule 10
as soon as a second distribution exists.

## Decision

- `BootstrapFlavorPlugin` gets a `network` description: the control plane ports the nodes need
  (with a flag whether the port is reached through the API load balancer) and the traffic between
  nodes (CNI).
- `InfraTransformPlugin.infraCluster` receives this description and maps it generically:
  - OpenStack: ports behind the load balancer become `apiServer.managedLoadBalancer.additionalPorts`;
    node traffic needs no rules because of `allowAllInClusterTraffic`.
  - AWS: ports behind the load balancer become NLB listeners plus ingress rules from the nodes;
    direct ports become `additionalControlPlaneIngressRules`; node traffic becomes
    `cniIngressRules`. CAPA puts CNI rules into the node and control plane security groups and
    already allows the kubelet port (tcp/10250) in the node group; AWS rejects a permission given
    twice, so the kubelet port goes to `additionalControlPlaneIngressRules` instead (found live
    on 2026-10-20 with kubeadm on AWS). The NLB is internet-facing, so nodes in private subnets
    reach it through the NAT gateways and rules from security group roles do not match; each
    port behind the load balancer therefore also gets a rule with `natGatewaysIPsSource` (CAPA
    adds the NAT addresses itself only for the API port). Found live on 2026-11-01 with k0s on
    AWS: the Konnectivity agents never connected, so `kubectl logs/exec` failed. Behind the
    NLB, the control plane nodes see the NLB (it does not preserve client IPs), and CAPA v2.13.1
    allows the NLB's security group on the control plane only for the API port (it leaves the
    rules of the `lb` group to the CCM), so each port behind the load balancer also gets an
    `additionalControlPlaneIngressRules` entry from the `apiserver-lb` role. Found live on
    2026-11-02: the 8132 and 9443 targets failed their health checks.
- RKE2 declares 9345 (direct) and its Calico rules; the generated manifests stay byte-identical
  (existing snapshots unchanged). k0s declares 8132 and 9443 (via load balancer), Calico VXLAN
  (UDP 4789) and the kubelet port.
- The version format check moves from a fixed RKE2 pattern to a per-distribution table.

## Consequences

- This was a one-time, generic change to both infrastructure plugins; FP9-F-07 is met in spirit:
  k0s itself added no k0s-specific code to them, and kubeadm (FP-10) can follow the same way.
- New infrastructure plugins must implement the mapping of `FlavorNetwork`.
