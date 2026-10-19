# Version report

Generated on 2026-10-19 by `pnpm versions:report` (Renovate 44.133.0, lookups only). How to update a version: [maintenance.md](maintenance.md).

**32 app versions** in [versions.yaml](../versions.yaml): 3 with a newer version (0 major, 3 minor, 0 patch).

npm packages are not part of this report: run `pnpm outdated -r`.

## App versions (versions.yaml)

### Cluster API providers

| Entry                 | Current | Newest  | Update                                                       | Change in                             |
| --------------------- | ------- | ------- | ------------------------------------------------------------ | ------------------------------------- |
| providers.cluster-api | v1.14.3 | –       | up to date                                                   | versions.yaml → providers.cluster-api |
| providers.rke2        | v0.26.0 | v0.27.0 | **minor** (released today; wait for the minimum release age) | versions.yaml → providers.rke2        |
| providers.k0smotron   | v2.2.0  | –       | up to date                                                   | versions.yaml → providers.k0smotron   |
| providers.openstack   | v0.15.0 | –       | up to date                                                   | versions.yaml → providers.openstack   |
| providers.aws         | v2.13.1 | –       | up to date                                                   | versions.yaml → providers.aws         |
| providers.helm        | v0.6.4  | –       | up to date                                                   | versions.yaml → providers.helm        |

### Prerequisites

| Entry                          | Current | Newest | Update     | Change in                                     |
| ------------------------------ | ------- | ------ | ---------- | --------------------------------------------- |
| prerequisites.cert-manager     | v1.21.2 | –      | up to date | versions.yaml → prerequisites.cert-manager    |
| prerequisites.capi-operator    | v0.29.0 | –      | up to date | versions.yaml → prerequisites.capi-operator   |
| prerequisites.orc (CAPO v0.15) | v2.6.0  | –      | up to date | versions.yaml → prerequisites.orc.byCapoMinor |

### Kubernetes versions

| Entry                   | Current         | Newest | Update     | Change in                                   |
| ----------------------- | --------------- | ------ | ---------- | ------------------------------------------- |
| kubernetes.rke2 1.37    | v1.37.1+rke2r1  | –      | up to date | versions.yaml → kubernetes.rke2.versions    |
| kubernetes.rke2 1.36    | v1.36.5+rke2r1  | –      | up to date | versions.yaml → kubernetes.rke2.versions    |
| kubernetes.rke2 1.35    | v1.35.9+rke2r1  | –      | up to date | versions.yaml → kubernetes.rke2.versions    |
| kubernetes.rke2 1.34    | v1.34.12+rke2r1 | –      | up to date | versions.yaml → kubernetes.rke2.versions    |
| kubernetes.rke2 1.33    | v1.33.13+rke2r3 | –      | up to date | versions.yaml → kubernetes.rke2.versions    |
| kubernetes.k0s 1.36     | v1.36.4+k0s.1   | –      | up to date | versions.yaml → kubernetes.k0s.versions     |
| kubernetes.k0s 1.35     | v1.35.8+k0s.1   | –      | up to date | versions.yaml → kubernetes.k0s.versions     |
| kubernetes.k0s 1.34     | v1.34.11+k0s.1  | –      | up to date | versions.yaml → kubernetes.k0s.versions     |
| kubernetes.k0s 1.33     | v1.33.13+k0s.1  | –      | up to date | versions.yaml → kubernetes.k0s.versions     |
| kubernetes.kubeadm 1.37 | v1.37.1         | –      | up to date | versions.yaml → kubernetes.kubeadm.versions |
| kubernetes.kubeadm 1.36 | v1.36.5         | –      | up to date | versions.yaml → kubernetes.kubeadm.versions |
| kubernetes.kubeadm 1.35 | v1.35.9         | –      | up to date | versions.yaml → kubernetes.kubeadm.versions |
| kubernetes.kubeadm 1.34 | v1.34.12        | –      | up to date | versions.yaml → kubernetes.kubeadm.versions |
| kubernetes.kubeadm 1.33 | v1.33.13        | –      | up to date | versions.yaml → kubernetes.kubeadm.versions |

### Add-on preset charts

| Entry                      | Current | Newest | Update     | Change in                                  |
| -------------------------- | ------- | ------ | ---------- | ------------------------------------------ |
| addonPresets.openstack-ccm | 2.37.1  | –      | up to date | versions.yaml → addonPresets.openstack-ccm |
| addonPresets.openstack-csi | 2.37.1  | –      | up to date | versions.yaml → addonPresets.openstack-csi |
| addonPresets.aws-ccm       | 0.0.12  | –      | up to date | versions.yaml → addonPresets.aws-ccm       |
| addonPresets.aws-csi       | 2.67.0  | –      | up to date | versions.yaml → addonPresets.aws-csi       |
| addonPresets.kured         | 6.1.0   | –      | up to date | versions.yaml → addonPresets.kured         |

### kubeadm node runtime

| Entry                     | Current | Newest | Update     | Change in                                 |
| ------------------------- | ------- | ------ | ---------- | ----------------------------------------- |
| kubeadmRuntime.containerd | 2.3.7   | 2.4.2  | **minor**  | versions.yaml → kubeadmRuntime.containerd |
| kubeadmRuntime.runc       | 1.5.2   | –      | up to date | versions.yaml → kubeadmRuntime.runc       |

### CNI

| Entry      | Current | Newest | Update     | Change in                  |
| ---------- | ------- | ------ | ---------- | -------------------------- |
| cni.calico | v3.33.0 | –      | up to date | versions.yaml → cni.calico |

### Images

| Entry             | Current | Newest | Update    | Change in                         |
| ----------------- | ------- | ------ | --------- | --------------------------------- |
| images.node-shell | 3.22    | 3.24   | **minor** | versions.yaml → images.node-shell |

## Appendix: GitHub Actions and Docker images

27 references in workflows, Dockerfile and .nvmrc; 15 of them have a newer version.

| Dependency                 | Current | Newest | Update    | Change in                      |
| -------------------------- | ------- | ------ | --------- | ------------------------------ |
| actions/checkout (×3)      | v5      | v7     | **major** | .github/workflows/ci.yaml      |
| actions/setup-node (×2)    | v5      | v7     | **major** | .github/workflows/ci.yaml      |
| docker/setup-buildx-action | v3      | v4     | **major** | .github/workflows/ci.yaml      |
| docker/build-push-action   | v6      | v7     | **major** | .github/workflows/ci.yaml      |
| actions/checkout (×3)      | v5      | v7     | **major** | .github/workflows/release.yaml |
| docker/setup-buildx-action | v3      | v4     | **major** | .github/workflows/release.yaml |
| docker/login-action        | v3      | v4     | **major** | .github/workflows/release.yaml |
| docker/metadata-action     | v5      | v6     | **major** | .github/workflows/release.yaml |
| docker/build-push-action   | v6      | v7     | **major** | .github/workflows/release.yaml |
| azure/setup-helm           | v4      | v5     | **major** | .github/workflows/release.yaml |
