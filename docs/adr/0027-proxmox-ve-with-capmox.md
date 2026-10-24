# ADR-0027: Proxmox VE with CAPMOX, kube-vip and per-cluster address ranges

- Status: accepted
- Date: 2026-10-23
- Pack: FP-31
- Refines: [ADR-0004](0004-node-provider-id-and-openstack-cloud-config.md) (credentials into the workload cluster), [ADR-0022](0022-gcp-api-load-balancer.md) (API load balancer per plugin), [ADR-0021](0021-plugin-described-provider-forms.md) (plugin forms)

## Context

Proxmox VE has none of what the app relies on in the clouds: no load balancer for the API server,
no machine flavors, no address management, no managed network. CAPMOX (IONOS, v0.9.1) fills the
gaps partly: it creates VMs from templates, takes node addresses from the in-cluster IPAM provider
and expects the API endpoint to be a virtual IP that something in the cluster holds. A spike on
2026-10-23 (requirements FP-31) created and deleted RKE2 and k0s clusters with CAPI v1.14.3 and
found what the app has to add.

## Decision

- **API endpoint: kube-vip in ARP mode, control plane only** (services off, so MetalLB or another
  load balancer for services can be added by users). One pure function renders the kube-vip
  container for all distributions (version pinned in `versions.yaml`); the infrastructure plugin
  declares that the distribution provides the endpoint, and each flavor plugin delivers it its way:
  RKE2 as DaemonSet through the RKE2 manifests, k0s as DaemonSet through its manifest deployer,
  kubeadm as static pod with the `super-admin.conf` workaround during `kubeadm init`. The interface is
  detected by kube-vip.
- **kube-vip uses the node's admin kubeconfig, as a workaround.** In ARP mode kube-vip is plain
  leader-election failover: another node takes over the VIP only when the leader can no longer
  renew its lease. kube-vip does not check whether the API server on the leader is healthy
  (kube-vip issue [#800](https://github.com/kube-vip/kube-vip/issues/800)); the health check of
  [#1498](https://github.com/kube-vip/kube-vip/pull/1498) covers only BGP and routing table mode,
  the ARP equivalent is an open request
  ([#1787](https://github.com/kube-vip/kube-vip/issues/1787), an RKE2 cluster like ours). With
  in-cluster credentials, as the kube-vip docs show for DaemonSets and as first used for RKE2, the
  old leader kept renewing through the `kubernetes` Service during a rollout and held the VIP for
  a dead API server (live test); on k0s, which advertises the VIP for that Service, they cannot
  reach the API at all. kube-vip therefore reads the node's admin kubeconfig (mounted to
  `/etc/kubernetes/admin.conf`, `kubernetes` resolved to 127.0.0.1, as in kube-vip's static pod
  manifests) and renews the lease only through the local API server: when it stops, the lease
  expires and the VIP moves. This relies on how leader election works, not on a documented
  kube-vip feature; once kube-vip offers a health check in ARP mode, the in-cluster DaemonSet with
  that check is the cleaner choice (see the kube-vip note in `versions.yaml`).
- **Node addresses from the kubelet**: the Proxmox CCM runs in its default network mode and takes
  the address the kubelet reports with `--node-ip`. The infrastructure plugin provides a shell
  command for it (`nodeAddressCommand`: the source address towards the gateway); distributions
  that do not set `--node-ip` themselves (k0s; kubeadm) pass it on. The guest agent mode would
  also report the VIP and CNI addresses, and its exclusions do not take effect in CCM v0.16.1.
- **Addresses: a range per cluster** (node range, prefix, gateway, DNS, VIP) in the wizard,
  written to `ProxmoxCluster.spec.ipv4Config`; CAPMOX creates the `InClusterIPPool`. The backend
  refuses ranges and VIPs that overlap other Proxmox clusters of the management cluster and VIPs
  inside the node range or outside its subnet. No shared pool: the app cannot know which network a
  cluster is in.
- **Machine sizes per credential:** a list of sizes (name, vCPUs, memory) stored with the Proxmox
  credential, four defaults, editable by admins; the size name is the cluster spec's
  `machineSize`, so day-2 size changes work as for flavors.
- **Credentials:** stored once (URL, token ID, secret, optional CA). Every cluster gets its own copy
  of the Secret, because CAPMOX takes ownership of the referenced Secret and deletes it with the
  last cluster. The CCM and CSI get theirs as a Secret delivered by ClusterResourceSet, as the
  OpenStack cloud config (ADR-0004); never in Helm values.
- **TLS:** CAPMOX is installed with TLS verification; its single root CA file is a bundle of the
  CAs of all stored Proxmox credentials, refreshed when a credential changes.
- **CCM and CSI as presets:** Proxmox CCM with `features.provider: capmox` (CAPMOX's provider ID
  `proxmox://<SystemUUID>`), Proxmox CSI plugin with the storage chosen in the wizard.
- **Templates:** stock cloud images without a Proxmox cloud-init drive; qemu-guest-agent is
  installed on first boot (`nodePreparation`). The template lookup warns about cloud-init drives
  and a disabled guest agent.

## Consequences

- No new framework; the app installs one more infrastructure provider and the IPAM provider.
- The plugin interface gets a way for a distribution to provide the API endpoint, used only by
  Proxmox for now; OpenStack, AWS and GCP keep their load balancers.
- Volumes of the CSI plugin on local storage stay on their Proxmox node (zone); with several
  Proxmox nodes, shared storage is needed for pods to move.
- CAPMOX's memory scheduling counts configured memory of all VMs, stopped ones included, and a
  refused machine is not retried. The wizard exposes `memoryAdjustment` with 0 (check off) as
  default: with 100 % the check refused VMs on a host with 20 GiB free memory (live test), and
  homelabs often overcommit. A refused machine must be deleted to be replaced.
- One CA bundle for all Proxmox endpoints is a CAPMOX limitation; it is fine as long as the CAs are
  trusted together.
- Services of type `LoadBalancer` stay pending unless users add MetalLB or similar (add-ons).
- kube-vip holds admin credentials of the node (the mounted admin kubeconfig) instead of a narrow
  ClusterRole. It runs only on control plane nodes, in the host network with `NET_ADMIN`, where
  the file exists anyway; the same applies to kube-vip's own static pod manifests.
- A failover of the VIP takes 13–25 s (lease expiry plus ARP announcement, measured in the live
  test) and the API traffic goes to one node; a load balancer with health checks in front of the
  control plane nodes (e.g. HAProxy with keepalived) remains possible outside the app.
