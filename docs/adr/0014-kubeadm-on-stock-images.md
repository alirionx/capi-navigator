# ADR-0014: kubeadm on stock images with release binaries for the container runtime

- Status: accepted
- Date: 2026-10-18
- Pack: FP-10

## Context

FP-10 installs upstream Kubernetes with kubeadm on unmodified cloud images. FP10-F-02 asks for
kubelet and kubeadm from `pkgs.k8s.io`; the container runtime is not specified. Taking containerd
from the distribution's packages would tie the flavor to one distribution family (package names,
versions and configuration differ) and leave the runtime version to the image. kubeadm also ships no
CNI, and its control plane nodes carry the label `node-role.kubernetes.io/control-plane: ""`,
while RKE2 and k0s set `"true"`.

## Decision

- A generated install script (file plus first `preKubeadmCommands` entry) prepares the node
  (kernel modules, sysctl, swap off) and installs:
  - containerd and runc as official release binaries of pinned versions (containerd 2.3.7,
    runc 1.5.2), verified with the published SHA-256 checksums, with a systemd unit and
    `SystemdCgroup = true`; independent of the distribution.
  - kubelet, kubeadm and kubectl of exactly the chosen version from `pkgs.k8s.io`, via apt
    (Debian, Ubuntu) or dnf (Rocky, Alma, RHEL), held against updates (`apt-mark hold`, `exclude`).
- Both sources can be replaced by mirrors (`kubernetes.packageRepository`,
  `kubernetes.binaryDownloads`, FP10-F-09).
- The script is part of the bootstrap configuration, so a version change creates new templates and
  machines (hard rule 5); `KubeadmControlPlane` replaces control plane machines one at a time.
- CNI: Calico with VXLAN, the same CNI and overlay RKE2 and k0s use, from the official manifest
  `calico-vxlan.yaml` (v3.33.0, no operator; pod CIDR detected from the kubeadm configuration).
  It is shipped with the backend (`assets/calico`, checked against its SHA-256) and delivered by an
  upstream `ClusterResourceSet` per namespace (`ApplyOnce`, versioned name) to clusters with the
  label `capi-navigator.io/cni=calico`. The transformation sets the label for distributions that
  declare `needsCni`, unless the spec says `addons.cni: none`. Not via CAAPH: since Calico v3.32 the
  CRDs live in a separate chart whose Helm release exceeds the 1 MiB limit of the release Secret
  (seen live), and Calico recommends `helm template | kubectl apply` for them, which CAAPH cannot do.
  Previews shorten the 729 KB ConfigMap.
- The CCM and EBS CSI presets render the control plane node selector per cluster from its control
  plane kind (CAAPH template on `.ControlPlane.kind`): `""` for kubeadm, `"true"` otherwise.

## Consequences

- Nodes need outbound access to `pkgs.k8s.io` and GitHub releases (or the mirrors); node start takes
  a few minutes longer than with RKE2 or k0s. The wizard marks the flavor experimental (FP10-F-08).
- Runtime updates follow the app's pinned versions (FP-20 version maintenance), not the image.
- Existing CCM/CSI presets show as outdated after this change; rolling them out changes nothing for
  RKE2 and k0s clusters.
