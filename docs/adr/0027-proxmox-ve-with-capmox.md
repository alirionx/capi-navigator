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
  kubeadm as static pod with the `super-admin.conf` workaround during `kubeadm init`. kube-vip always
  uses the node's admin kubeconfig through localhost, never in-cluster credentials: a leader must
  lose its lease when its own API server stops. With in-cluster credentials (first used for RKE2)
  the old leader kept renewing through the `kubernetes` Service during a rollout and held the VIP
  for a dead API server; on k0s, which advertises the VIP for that Service, they cannot reach the
  API at all. The interface is detected by kube-vip.
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
- CAPMOX's memory scheduling counts configured memory of all VMs; the wizard exposes
  `memoryAdjustment` (default 100 %), since homelabs often overcommit.
- One CA bundle for all Proxmox endpoints is a CAPMOX limitation; it is fine as long as the CAs are
  trusted together.
- Services of type `LoadBalancer` stay pending unless users add MetalLB or similar (add-ons).
