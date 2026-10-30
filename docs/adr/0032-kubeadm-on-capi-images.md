# ADR-0032: kubeadm on Cluster API images, online and air-gapped

- Status: accepted
- Date: 2026-10-30
- Pack: FP-29 (part B), FP-10
- Refines: ADR-0030 (kubeadm was left out), ADR-0014 (install script on stock images)

## Context

ADR-0030 left kubeadm out of air-gapped clusters: the install script of ADR-0014 takes kubelet,
kubeadm and kubectl from `pkgs.k8s.io` and containerd and runc from GitHub at first boot, which an
air-gapped node cannot reach. Rebuilding that script around OCI artifacts (as for RKE2 and k0s)
would mean an own artifact per Kubernetes version with containerd, runc, crictl and CNI plugins in
it, plus distribution packages (`conntrack`, `socat`) that are no OCI artifacts at all.

Cluster API's own answer is node images with everything preinstalled ("CAPI images", Image
Builder). Spikes on 2026-10-30 (Proxmox VE 9.2, CAPMOX v0.9.1, kind as management cluster, Harbor
with proxy-cache projects):

- **Image sources.** osism publishes maintained CAPI images for OpenStack; they also boot on
  Proxmox VE (NoCloud works), but lack the QEMU guest agent CAPMOX needs and hold every package of
  the image. A stock Ubuntu or Debian cloud image customized with `virt-customize` (containerd and
  runc release binaries, the Kubernetes packages of one version, QEMU guest agent, conntrack,
  socat; containerd with `config_path = /etc/containerd/certs.d` and the pause image kubeadm
  expects) builds in about 90 s and works on both. A build and boot test of such images runs in
  GitHub Actions (Debian container for libguestfs 1.54; Ubuntu 24.04's 1.52 needs passt, which
  AppArmor blocks on the runners); see the separate repository `alirionx/capi-navigator-images`,
  test images only.
- **Air-gapped.** A kubeadm cluster from such an image (Debian 13, v1.36.5) came up on Proxmox VE
  without a route to the internet: the YAML of the app's online transformation without the install
  script and the online node preparation, plus one `hosts.toml` per upstream registry
  (`containerdHostsFiles` of ADR-0030). Control plane after about 2 minutes, worker after 3;
  Calico (ClusterResourceSet), Proxmox CCM and CSI (CAAPH), kube-vip and a user image from
  `docker.io` came through the mirror; a CSI volume was bound.
- **Online on a CAPI image, same version.** The unchanged install script works (apt steps are
  no-ops), but downloads containerd and runc again and overwrites `/etc/containerd/config.toml`
  with containerd's default, whose `config_path` is empty.
- **Online on a CAPI image, other version** (image v1.35.9, cluster v1.36.5): apt refuses to change
  the held packages, the script fails, **cloud-init goes on and `kubeadm init` runs with the old
  kubeadm**: a v1.36.5 control plane with a v1.35.9 kubelet; cloud-init reports no error and the
  Machine is `Running`. Any failure of the install script is silent in the same way today.

## Decision

- **Online kubeadm keeps stock images** (ADR-0014): working on every infrastructure with its
  existing base images stays the main advantage of the flavor.
- **The install script becomes image-aware.** It reads `/etc/capi-image-release` (written by the
  images of `capi-navigator-images`) or, more generally, compares `kubeadm version` with the
  target version:
  - kubeadm of exactly the target version present: install nothing, leave containerd and its
    configuration alone, only prepare kernel modules, sysctl and swap;
  - Kubernetes packages present in another version: change only kubelet, kubeadm and kubectl to the
    target version (`--allow-change-held-packages`), keep containerd;
  - nothing present (stock image): as today.
- **Install failures stop the bootstrap.** The script is called as `… || exit 1`, like the artifact
  download of air-gapped RKE2 and k0s nodes (FP29-F-13), so `kubeadm init` and `join` never run
  after a failed installation and the machine stays visibly unprovisioned.
- **Air-gapped kubeadm needs a CAPI image.** No install script and no online node preparation;
  instead a check that `kubeadm version` equals the target version (otherwise `exit 1`), the
  registry CA and the `hosts.toml` files for the internal registry. No OCI artifacts and no pins
  for kubeadm; the version and the image are chosen together in the wizard and in upgrades.
- **Where the images come from is the user's choice**, and the app says so: OpenStack: osism's
  images; other infrastructures: Image Builder (Packer); Proxmox VE: two documented recipes (the QEMU
  guest agent into an osism image, or `virt-customize` on a stock cloud image). The project does
  not publish supported images; `capi-navigator-images` is a test repository without warranty.
- **One image for both on Proxmox VE.** A CAPI image with the guest agent serves online clusters
  (the script installs nothing or only the other Kubernetes version) and air-gapped ones; the
  guest agent no longer has to be baked into a stock template for air-gapped kubeadm clusters.

## Consequences

- The kubeadm flavor joins FP29-F-11; FP29-F-12 (artifacts) does not apply to it. The image lists
  of FP29-F-17 gain the kubeadm images (`kubeadm config images list` of each version) besides
  Calico, CCM/CSI and kube-vip.
- Air-gapped kubeadm upgrades need an image of the new version; the wizard and the upgrade dialog
  ask for it and say why (kubelet in the image, version skew).
- Node start online is about as fast as before on stock images and faster on CAPI images.
- `|| exit 1` also changes online clusters on stock images: a failing package download now stops
  the node instead of leaving it half-installed. Existing clusters change only with their next
  template rotation (hard rule 5).
- RKE2 and k0s keep their image requirements for air-gapped Proxmox VE (QEMU guest agent,
  FP29-F-15); OS packages from the registry stay a separate idea.
