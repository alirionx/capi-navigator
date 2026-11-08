// Generated from versions.yaml by `pnpm versions:generate` (FP-20). Do not edit.
import type { VersionsFile } from './versions/schema.js';

export const VERSIONS: VersionsFile = {
  "schemaVersion": 1,
  "providers": {
    "cluster-api": {
      "version": "v1.14.4",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/cluster-api"
      },
      "verified": "2026-11-08",
      "note": "CAPI contract v1beta2. v1.14.4 has bug fixes and Go updates only; the CRDs and manifests of core, kubeadm bootstrap and control plane are unchanged from v1.14.3 apart from the images. Verified live on 2026-11-08: upgrade on kind, kubeadm v1.36.6 on Proxmox VE, RKE2 on GCP."
    },
    "rke2": {
      "version": "v0.27.1",
      "source": {
        "datasource": "github-releases",
        "package": "rancher/cluster-api-provider-rke2"
      },
      "verified": "2026-10-28",
      "note": "v0.27.1 only updates Go (1.27.3). No API changes from v0.26.0; built on CAPI v1.14.3. `airGappedChecksum` is still broken (issue #1128), the app does not set it (ADR-0030)."
    },
    "k0smotron": {
      "version": "v2.3.1",
      "source": {
        "datasource": "github-releases",
        "package": "k0sproject/k0smotron"
      },
      "verified": "2026-10-31",
      "note": "v2.3.1 contains #1705: the scale down waits until deleted control plane machines are gone, so three and five nodes are replaced one at a time (ADR-0013, update 2026-10-31). The control plane's `version` is now required (the app always sets it); the webhook now always copies the deprecated `infrastructureRef` into the nested one (the app writes both, equal). Taken one day before the minimum release age for 0.14.0. The deprecated `version` of the worker config is still honoured."
    },
    "openstack": {
      "version": "v0.15.1",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/cluster-api-provider-openstack"
      },
      "verified": "2026-10-28",
      "note": "Needs the ORC version of its minor (prerequisites.orc). v0.15.1 has bug fixes only, no API changes."
    },
    "aws": {
      "version": "v2.13.1",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/cluster-api-provider-aws"
      },
      "verified": "2026-10-17"
    },
    "gcp": {
      "version": "v1.13.1",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/cluster-api-provider-gcp"
      },
      "verified": "2026-10-20",
      "note": "Still implements the v1beta1 contract (built against CAPI v1.13.2). CAPI v1.14 supports it; CAPI plans to drop v1beta1 contract support with v1.16 (tentatively April 2027), so CAPG must move to v1beta2 before core can go there."
    },
    "proxmox": {
      "version": "v0.9.2",
      "source": {
        "datasource": "github-releases",
        "package": "ionos-cloud/cluster-api-provider-proxmox"
      },
      "verified": "2026-11-08",
      "note": "API v1alpha2, contract v1beta2. v0.9.2: security and bug fixes (among them waiting for the boot disk resize and for running VM tasks); CRDs and manifests unchanged from v0.9.1 apart from the image. Verified live on 2026-11-08 (kubeadm v1.36.6: CCM, CSI and LoadBalancer). Upstream lists CAPI v1.11/v1.12; verified live with CAPI v1.14.3 (RKE2 and k0s, FP-31 spike). Skips TLS verification unless PROXMOX_INSECURE=false."
    },
    "ipam-in-cluster": {
      "version": "v1.1.1",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/cluster-api-ipam-provider-in-cluster"
      },
      "verified": "2026-10-23",
      "note": "Contract v1beta2 from v1.1. Holds released addresses for a grace period before reuse."
    },
    "helm": {
      "version": "v0.6.4",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/cluster-api-addon-provider-helm"
      },
      "verified": "2026-10-17"
    }
  },
  "prerequisites": {
    "cert-manager": {
      "version": "v1.21.3",
      "source": {
        "datasource": "github-releases",
        "package": "cert-manager/cert-manager"
      },
      "verified": "2026-10-28",
      "note": "Install command uses the Helm chart oci://quay.io/jetstack/charts/cert-manager with this version."
    },
    "capi-operator": {
      "version": "v0.30.0",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/cluster-api-operator"
      },
      "verified": "2026-10-20",
      "note": "The Helm chart version is this version without the leading \"v\". v0.30.0 taken on its release day together with k0smotron v2.3.0; no API changes."
    },
    "orc": {
      "source": {
        "datasource": "github-releases",
        "package": "k-orc/openstack-resource-controller"
      },
      "verified": "2026-10-17",
      "byCapoMinor": {
        "v0.15": "v2.6.0",
        "v0.14": "v2.4.0",
        "v0.13": "v2.3.0"
      }
    }
  },
  "kubernetes": {
    "rke2": {
      "source": {
        "datasource": "github-releases",
        "package": "rancher/rke2"
      },
      "verified": "2026-11-08",
      "note": "Latest patch per minor from the rancher/rke2 releases. The RKE2 provider runs its e2e tests with Kubernetes v1.35; v1.36 was verified live in FP-29 (upgrade from v1.35, 2026-10-28). Patches v1.34.13, v1.35.10, v1.36.6 and v1.37.2 (containerd 2.2.9 or 2.3.6, chart updates) taken on 2026-11-08, three days after their release, at the user's request. v1.33.13+rke2r3 is a Prime-only release without assets on GitHub (no install, no image lists); v1.33 stays on v1.33.13+rke2r2, the last community release of that minor.",
      "versions": [
        {
          "version": "v1.37.2+rke2r1",
          "verifiedWithProvider": "v0.27.1",
          "untested": true
        },
        {
          "version": "v1.36.6+rke2r1",
          "verifiedWithProvider": "v0.27.1",
          "default": true
        },
        {
          "version": "v1.35.10+rke2r1",
          "verifiedWithProvider": "v0.27.1"
        },
        {
          "version": "v1.34.13+rke2r1",
          "verifiedWithProvider": "v0.27.1"
        },
        {
          "version": "v1.33.13+rke2r2",
          "verifiedWithProvider": "v0.27.1"
        }
      ]
    },
    "k0s": {
      "source": {
        "datasource": "github-releases",
        "package": "k0sproject/k0s"
      },
      "verified": "2026-11-08",
      "note": "Latest patch per minor from the k0sproject/k0s releases. k0smotron runs its e2e tests with v1.31 only; v1.34 and v1.35 were verified live in FP-9, v1.36 in FP-29 (v1.36.4, upgrade from v1.35.8, 2026-10-28). The patches of 2026-10-27 (v1.34.12, v1.35.9, v1.36.5) were taken one day after their release, before the minimum release age, at the user's request for 0.12.0. v1.37.1: a one-node cluster on Proxmox VE upgraded live from v1.36.5 (2026-10-28). k0smotron v2.3.1 (2026-10-31): three control plane nodes upgraded live from v1.35.9 to v1.36.5 on OpenStack (ADR-0013); the patch release changes nothing for the other versions. 2026-11-08: patches v1.34.13, v1.35.10, v1.36.6 and v1.37.2 (Kubernetes patches, containerd 2.3.6 for v1.36 and v1.37), five days after their release; the hosted k0s images exist. v1.37.2+k0s.1 (2026-11-06, Helm extension, kine and Traefik fixes) two days after its release, at the user's request.",
      "versions": [
        {
          "version": "v1.37.2+k0s.1",
          "verifiedWithProvider": "v2.3.1"
        },
        {
          "version": "v1.36.6+k0s.0",
          "verifiedWithProvider": "v2.3.1",
          "default": true
        },
        {
          "version": "v1.35.10+k0s.0",
          "verifiedWithProvider": "v2.3.1"
        },
        {
          "version": "v1.34.13+k0s.0",
          "verifiedWithProvider": "v2.3.1"
        },
        {
          "version": "v1.33.13+k0s.1",
          "verifiedWithProvider": "v2.3.1"
        }
      ]
    },
    "kubeadm": {
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes/kubernetes"
      },
      "verified": "2026-11-08",
      "note": "Checked against dl.k8s.io/release/stable-1.XX.txt and the pkgs.k8s.io deb and rpm repositories (FP10-F-02); Cluster API v1.14 supports v1.33 to v1.37 for kubeadm. The Cluster API images of capi-navigator-images and osism carry the same patch versions (ADR-0032).",
      "versions": [
        {
          "version": "v1.37.2",
          "verifiedWithProvider": "v1.14.4"
        },
        {
          "version": "v1.36.6",
          "verifiedWithProvider": "v1.14.4",
          "default": true
        },
        {
          "version": "v1.35.10",
          "verifiedWithProvider": "v1.14.4"
        },
        {
          "version": "v1.34.13",
          "verifiedWithProvider": "v1.14.4"
        },
        {
          "version": "v1.33.13",
          "verifiedWithProvider": "v1.14.4"
        }
      ]
    }
  },
  "addonPresets": {
    "openstack-ccm": {
      "version": "2.37.1",
      "source": {
        "datasource": "helm",
        "package": "openstack-cloud-controller-manager",
        "registry": "https://kubernetes.github.io/cloud-provider-openstack"
      },
      "verified": "2026-10-17",
      "note": "Released together with openstack-csi; keep both on the same version."
    },
    "openstack-csi": {
      "version": "2.37.1",
      "source": {
        "datasource": "helm",
        "package": "openstack-cinder-csi",
        "registry": "https://kubernetes.github.io/cloud-provider-openstack"
      },
      "verified": "2026-10-17"
    },
    "aws-ccm": {
      "version": "0.0.12",
      "source": {
        "datasource": "helm",
        "package": "aws-cloud-controller-manager",
        "registry": "https://kubernetes.github.io/cloud-provider-aws"
      },
      "verified": "2026-10-17"
    },
    "aws-csi": {
      "version": "2.67.2",
      "source": {
        "datasource": "helm",
        "package": "aws-ebs-csi-driver",
        "registry": "https://kubernetes-sigs.github.io/aws-ebs-csi-driver"
      },
      "verified": "2026-10-28"
    },
    "proxmox-ccm": {
      "version": "0.2.32",
      "source": {
        "datasource": "docker",
        "package": "sergelogvinov/charts/proxmox-cloud-controller-manager",
        "registry": "ghcr.io"
      },
      "verified": "2026-10-23",
      "note": "App v0.16.1 (2026-09-28). features.provider=capmox for CAPMOX's provider ID; one maintainer."
    },
    "proxmox-csi": {
      "version": "0.5.12",
      "source": {
        "datasource": "docker",
        "package": "sergelogvinov/charts/proxmox-csi-plugin",
        "registry": "ghcr.io"
      },
      "verified": "2026-10-23",
      "note": "App v0.20.0 (2026-08-05); chart 0.5.13 (v0.21.0, 2026-10-17) was less than two weeks old. Needs the region and zone labels the CCM sets; volumes on local storage stay on their node."
    },
    "proxmox-kube-vip": {
      "version": "0.11.2",
      "source": {
        "datasource": "helm",
        "package": "kube-vip",
        "registry": "https://kube-vip.github.io/helm-charts"
      },
      "verified": "2026-10-28",
      "note": "A DaemonSet driven by env; 0.11.2 only raises the default image tag over 0.11.1, which the preset overrides. Rendered with the preset values it matches the FP-32 spike."
    },
    "proxmox-kube-vip-cloud-provider": {
      "version": "0.2.11",
      "source": {
        "datasource": "helm",
        "package": "kube-vip-cloud-provider",
        "registry": "https://kube-vip.github.io/helm-charts"
      },
      "verified": "2026-11-08",
      "note": "0.2.11 only raises appVersion to v0.0.13 (templates and values unchanged). Chart default image is on Docker Hub; the preset uses images.kube-vip-cloud-provider. RBAC identical to the upstream manifest of v0.0.13."
    },
    "kured": {
      "version": "6.1.0",
      "source": {
        "datasource": "helm",
        "package": "kured",
        "registry": "https://kubereboot.github.io/charts"
      },
      "verified": "2026-10-18"
    }
  },
  "kubeadmRuntime": {
    "containerd": {
      "version": "2.4.2",
      "source": {
        "datasource": "github-releases",
        "package": "containerd/containerd"
      },
      "verified": "2026-10-20",
      "note": "containerd's compatibility table lists 2.4 for Kubernetes 1.37 and 2.3 for 1.36+; the older catalog minors run on it through CRI v1 as well. Its own runc pin is 1.5.2, like ours."
    },
    "runc": {
      "version": "1.5.2",
      "source": {
        "datasource": "github-releases",
        "package": "opencontainers/runc"
      },
      "verified": "2026-10-18"
    }
  },
  "cni": {
    "calico": {
      "version": "v3.33.0",
      "source": {
        "datasource": "github-releases",
        "package": "projectcalico/calico"
      },
      "verified": "2026-10-18",
      "manifest": "calico-vxlan-v3.33.0.yaml",
      "sha256": "202d70b43e38b60ebc60736c96e64e6de683053aab2e89da84ea9d904a9ef24c"
    }
  },
  "addonManifests": {
    "gcp-ccm": {
      "version": "v37.2.5",
      "source": {
        "datasource": "docker",
        "package": "cloud-provider-gcp/cloud-controller-manager",
        "registry": "https://registry.k8s.io"
      },
      "verified": "2026-11-08",
      "note": "The repository has tags but no GitHub releases; the image follows the Kubernetes minor (v36 = 1.36) and supports the minors around it. The manifest is meant for tooling (empty args, cloud config from the host); the app fills both (gcp-addons.ts). v37 for all catalog minors at the user's decision (2026-11-08), as v36 was before: newer than the API server of v1.33 to v1.36, outside the version skew policy. The manifest differs from v36.4.9 only in its image line. Verified live on 2026-11-08 with RKE2 v1.36.6: provider IDs, zones, a LoadBalancer Service.",
      "manifest": "gcp-ccm-v37.2.5.yaml",
      "sha256": "5e20f64573d7e83b9a03eca5e2266f013b930b3970e3d2819fd272f62a740d65"
    },
    "gcp-csi": {
      "version": "v1.28.1",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/gcp-compute-persistent-disk-csi-driver"
      },
      "verified": "2026-11-08",
      "note": "The overlay of v1.27.5 and v1.28.1 renders identically: upstream's stable-master still pins the driver image v1.26.0 and the sidecars. The app pins the driver image to this version (gcp-addons.ts); before 2026-11-08 clusters ran driver v1.26.0. Verified live on 2026-11-08 (RKE2 v1.36.6, PVC on pd-balanced bound).",
      "manifest": "gcp-pd-csi-noauth-v1.28.1.yaml",
      "sha256": "72d2f057d3d69bad407cea926e2de62d9ca4e19aef9a0c383e3d6c48500e9b22"
    }
  },
  "images": {
    "node-shell": {
      "version": "3.24",
      "source": {
        "datasource": "docker",
        "package": "alpine",
        "registry": "docker.io"
      },
      "verified": "2026-10-20"
    },
    "kube-vip": {
      "version": "v1.3.1",
      "source": {
        "datasource": "docker",
        "package": "kube-vip/kube-vip",
        "registry": "ghcr.io"
      },
      "verified": "2026-10-23",
      "note": "Detects the interface itself when vip_interface is unset. Verified live with RKE2 and k0s, always with the node's admin kubeconfig (localhost), never in-cluster credentials: a workaround for the missing API server health check in ARP mode (ADR-0027). On updates, check whether kube-vip issue 1787 (control plane health check for ARP) has been released. Also the image of the Services preset (FP-32), so both instances move together."
    },
    "kube-vip-cloud-provider": {
      "version": "v0.0.13",
      "source": {
        "datasource": "docker",
        "package": "kube-vip/kube-vip-cloud-provider",
        "registry": "ghcr.io"
      },
      "verified": "2026-10-24",
      "note": "Reads its ConfigMap on every Service sync, so a changed range applies without a restart; ranges are always start-end. Verified live in the FP-32 spike."
    },
    "k0smotron-etcd": {
      "version": "v3.7.1",
      "source": {
        "datasource": "docker",
        "package": "k0sproject/etcd",
        "registry": "quay.io"
      },
      "verified": "2026-11-04",
      "note": "The default of k0smotron v2.3.1 (CRD default of storage.etcd.image). Pinned so that the YAML and the image list of air-gapped hosts do not depend on the installed k0smotron (ADR-0037). Follow k0smotron's default on updates; its webhook refuses to skip an etcd minor version."
    }
  },
  "testTools": {
    "dex": {
      "version": "0.26.0",
      "source": {
        "datasource": "helm",
        "package": "dex",
        "registry": "https://charts.dexidp.io"
      },
      "verified": "2026-10-20"
    },
    "socat": {
      "version": "1.8.1.3",
      "source": {
        "datasource": "docker",
        "package": "alpine/socat",
        "registry": "docker.io"
      },
      "verified": "2026-11-08"
    },
    "gitleaks": {
      "version": "v8.30.1",
      "source": {
        "datasource": "docker",
        "package": "gitleaks/gitleaks",
        "registry": "https://ghcr.io"
      },
      "verified": "2026-10-22"
    }
  }
};
