# ADR-0033: kubeadm is no longer experimental

- Status: accepted
- Date: 2026-11-02
- Pack: FP-10
- Refines: FP10-F-08, [ADR-0014](0014-kubeadm-on-stock-images.md)

## Context

FP-10 brought kubeadm as an experimental distribution (FP10-F-08), because its only path then was
an install script on stock cloud images: nodes start a few minutes later, need `pkgs.k8s.io` and
GitHub releases (or mirrors), and Cluster API itself supports only images with everything
preinstalled. Since then:

- kubeadm runs on all four infrastructures, verified live: OpenStack (stock Ubuntu 2026-10-18,
  Cluster API image 2026-10-30), AWS (2026-10-20), Google Cloud (FP-25) and Proxmox VE (all-in-one,
  one plus one, air-gapped).
- [ADR-0032](0032-kubeadm-on-capi-images.md) added Cluster API images, the path Cluster API supports:
  the install script installs nothing on an image of the selected version, and stops the bootstrap
  on an air-gapped image of another version.
- Day 2 works as for RKE2 and k0s: minor upgrades by template rotation (OpenStack, air-gapped on
  Proxmox VE), image changes, manifest add-ons.
- Live on 2026-11-02 on Proxmox VE 9.2: three control plane nodes and one worker from the stock
  Debian 13 template, Kubernetes v1.35.9, all nodes Ready 271 s after creation. The upgrade to
  v1.36.6 through the app replaced the control plane one node at a time and the worker afterwards
  (476 s); three etcd members and all pods healthy afterwards. Of 157 API probes every 3 s, 5
  failed in two windows of about 12 and 6 s, each right after the control plane node holding the
  kube-vip address was deleted, as with RKE2 and k0s on Proxmox VE.

## Decision

- kubeadm is a supported distribution like RKE2 and k0s; the wizard no longer labels it
  experimental, and the flavor plugin flag `experimental` is removed.
- The trade-offs stay visible: whenever a distribution installs at first boot (`installsPackages`),
  the wizard shows them as information before creation, and recommends a Cluster API image of the
  selected version for production and air-gapped clusters (FP10-F-08, reworded).

## Consequences

- The install script on stock images remains a convenience path outside Cluster API's own support;
  the app says so in the wizard instead of labelling the whole distribution.
- RKE2 stays the default distribution.
- A further distribution can be marked as experimental again with a wizard notice of its own when
  it is introduced.
