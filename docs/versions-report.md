# Version report

Generated on 2026-10-31 by `pnpm versions:report` (Renovate 44.133.0, lookups only). How to update a version: [maintenance.md](maintenance.md).

**47 app versions** in [versions.yaml](../versions.yaml): 4 with a newer version (1 major, 1 minor, 2 patch).

npm packages are not part of this report: run `pnpm outdated -r`.

## App versions (versions.yaml)

### Cluster API providers

| Entry                     | Current | Newest | Update                                                            | Change in                                 |
| ------------------------- | ------- | ------ | ----------------------------------------------------------------- | ----------------------------------------- |
| providers.cluster-api     | v1.14.3 | –      | up to date                                                        | versions.yaml → providers.cluster-api     |
| providers.rke2            | v0.27.1 | –      | up to date                                                        | versions.yaml → providers.rke2            |
| providers.k0smotron       | v2.3.0  | v2.3.1 | **patch** (released 2 days ago; wait for the minimum release age) | versions.yaml → providers.k0smotron       |
| providers.openstack       | v0.15.1 | –      | up to date                                                        | versions.yaml → providers.openstack       |
| providers.aws             | v2.13.1 | –      | up to date                                                        | versions.yaml → providers.aws             |
| providers.gcp             | v1.13.1 | –      | up to date                                                        | versions.yaml → providers.gcp             |
| providers.proxmox         | v0.9.1  | –      | up to date                                                        | versions.yaml → providers.proxmox         |
| providers.ipam-in-cluster | v1.1.1  | –      | up to date                                                        | versions.yaml → providers.ipam-in-cluster |
| providers.helm            | v0.6.4  | –      | up to date                                                        | versions.yaml → providers.helm            |

### Prerequisites

| Entry                          | Current | Newest | Update     | Change in                                     |
| ------------------------------ | ------- | ------ | ---------- | --------------------------------------------- |
| prerequisites.cert-manager     | v1.21.3 | –      | up to date | versions.yaml → prerequisites.cert-manager    |
| prerequisites.capi-operator    | v0.30.0 | –      | up to date | versions.yaml → prerequisites.capi-operator   |
| prerequisites.orc (CAPO v0.15) | v2.6.0  | –      | up to date | versions.yaml → prerequisites.orc.byCapoMinor |

### Kubernetes versions

| Entry                   | Current         | Newest | Update     | Change in                                   |
| ----------------------- | --------------- | ------ | ---------- | ------------------------------------------- |
| kubernetes.rke2 1.37    | v1.37.1+rke2r1  | –      | up to date | versions.yaml → kubernetes.rke2.versions    |
| kubernetes.rke2 1.36    | v1.36.5+rke2r1  | –      | up to date | versions.yaml → kubernetes.rke2.versions    |
| kubernetes.rke2 1.35    | v1.35.9+rke2r1  | –      | up to date | versions.yaml → kubernetes.rke2.versions    |
| kubernetes.rke2 1.34    | v1.34.12+rke2r1 | –      | up to date | versions.yaml → kubernetes.rke2.versions    |
| kubernetes.rke2 1.33    | v1.33.13+rke2r3 | –      | up to date | versions.yaml → kubernetes.rke2.versions    |
| kubernetes.k0s 1.37     | v1.37.1+k0s.0   | –      | up to date | versions.yaml → kubernetes.k0s.versions     |
| kubernetes.k0s 1.36     | v1.36.5+k0s.0   | –      | up to date | versions.yaml → kubernetes.k0s.versions     |
| kubernetes.k0s 1.35     | v1.35.9+k0s.0   | –      | up to date | versions.yaml → kubernetes.k0s.versions     |
| kubernetes.k0s 1.34     | v1.34.12+k0s.0  | –      | up to date | versions.yaml → kubernetes.k0s.versions     |
| kubernetes.k0s 1.33     | v1.33.13+k0s.1  | –      | up to date | versions.yaml → kubernetes.k0s.versions     |
| kubernetes.kubeadm 1.37 | v1.37.2         | –      | up to date | versions.yaml → kubernetes.kubeadm.versions |
| kubernetes.kubeadm 1.36 | v1.36.6         | –      | up to date | versions.yaml → kubernetes.kubeadm.versions |
| kubernetes.kubeadm 1.35 | v1.35.10        | –      | up to date | versions.yaml → kubernetes.kubeadm.versions |
| kubernetes.kubeadm 1.34 | v1.34.13        | –      | up to date | versions.yaml → kubernetes.kubeadm.versions |
| kubernetes.kubeadm 1.33 | v1.33.13        | –      | up to date | versions.yaml → kubernetes.kubeadm.versions |

### Add-on preset charts

| Entry                                        | Current | Newest | Update     | Change in                                                    |
| -------------------------------------------- | ------- | ------ | ---------- | ------------------------------------------------------------ |
| addonPresets.openstack-ccm                   | 2.37.1  | –      | up to date | versions.yaml → addonPresets.openstack-ccm                   |
| addonPresets.openstack-csi                   | 2.37.1  | –      | up to date | versions.yaml → addonPresets.openstack-csi                   |
| addonPresets.aws-ccm                         | 0.0.12  | –      | up to date | versions.yaml → addonPresets.aws-ccm                         |
| addonPresets.aws-csi                         | 2.67.2  | –      | up to date | versions.yaml → addonPresets.aws-csi                         |
| addonPresets.proxmox-ccm                     | 0.2.32  | –      | up to date | versions.yaml → addonPresets.proxmox-ccm                     |
| addonPresets.proxmox-csi                     | 0.5.12  | –      | up to date | versions.yaml → addonPresets.proxmox-csi                     |
| addonPresets.proxmox-kube-vip                | 0.11.2  | –      | up to date | versions.yaml → addonPresets.proxmox-kube-vip                |
| addonPresets.proxmox-kube-vip-cloud-provider | 0.2.10  | –      | up to date | versions.yaml → addonPresets.proxmox-kube-vip-cloud-provider |
| addonPresets.kured                           | 6.1.0   | –      | up to date | versions.yaml → addonPresets.kured                           |

### kubeadm node runtime

| Entry                     | Current | Newest | Update     | Change in                                 |
| ------------------------- | ------- | ------ | ---------- | ----------------------------------------- |
| kubeadmRuntime.containerd | 2.4.2   | –      | up to date | versions.yaml → kubeadmRuntime.containerd |
| kubeadmRuntime.runc       | 1.5.2   | –      | up to date | versions.yaml → kubeadmRuntime.runc       |

### CNI

| Entry      | Current | Newest | Update     | Change in                  |
| ---------- | ------- | ------ | ---------- | -------------------------- |
| cni.calico | v3.33.0 | –      | up to date | versions.yaml → cni.calico |

### Add-on manifests

| Entry                  | Current | Newest  | Update                                                                    | Change in                              |
| ---------------------- | ------- | ------- | ------------------------------------------------------------------------- | -------------------------------------- |
| addonManifests.gcp-ccm | v36.4.9 | v37.0.1 | **major** (released undefined days ago; wait for the minimum release age) | versions.yaml → addonManifests.gcp-ccm |
| addonManifests.gcp-csi | v1.27.5 | v1.28.1 | **minor**                                                                 | versions.yaml → addonManifests.gcp-csi |

### Images

| Entry                          | Current | Newest | Update     | Change in                                      |
| ------------------------------ | ------- | ------ | ---------- | ---------------------------------------------- |
| images.node-shell              | 3.24    | –      | up to date | versions.yaml → images.node-shell              |
| images.kube-vip                | v1.3.1  | –      | up to date | versions.yaml → images.kube-vip                |
| images.kube-vip-cloud-provider | v0.0.13 | –      | up to date | versions.yaml → images.kube-vip-cloud-provider |

### Local test tools

| Entry              | Current | Newest  | Update                                                       | Change in                          |
| ------------------ | ------- | ------- | ------------------------------------------------------------ | ---------------------------------- |
| testTools.dex      | 0.26.0  | –       | up to date                                                   | versions.yaml → testTools.dex      |
| testTools.socat    | 1.8.1.1 | 1.8.1.3 | **patch** (released today; wait for the minimum release age) | versions.yaml → testTools.socat    |
| testTools.gitleaks | v8.30.1 | –       | up to date                                                   | versions.yaml → testTools.gitleaks |

## Appendix: GitHub Actions and Docker images

28 references in workflows, Dockerfile and .nvmrc; 3 of them have a newer version.

| Dependency | Current          | Newest           | Update                                                                    | Change in  |
| ---------- | ---------------- | ---------------- | ------------------------------------------------------------------------- | ---------- |
| node (×2)  | 24-bookworm-slim | 26-bookworm-slim | **major** (released undefined days ago; wait for the minimum release age) | Dockerfile |
| node       | 24               | 26               | **major**                                                                 | .nvmrc     |
