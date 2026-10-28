// Generated from versions.yaml by `pnpm versions:generate` (FP-20). Do not edit.
import type { VersionsFile } from './versions/schema.js';

export const VERSIONS: VersionsFile = {
  "schemaVersion": 1,
  "providers": {
    "cluster-api": {
      "version": "v1.14.3",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/cluster-api"
      },
      "verified": "2026-10-17",
      "note": "CAPI contract v1beta2."
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
      "version": "v2.3.0",
      "source": {
        "datasource": "github-releases",
        "package": "k0sproject/k0smotron"
      },
      "verified": "2026-10-20",
      "note": "v2.3.0 taken on its release day for ADR-0013: control plane replacement works live for one node; three nodes are all removed at once (etcd on one member for minutes), accepted since 2026-10-28 until the fix #1705 is released. Re-test multi-node replacement with every release. The deprecated `version` of the worker config is still honoured."
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
      "version": "v0.9.1",
      "source": {
        "datasource": "github-releases",
        "package": "ionos-cloud/cluster-api-provider-proxmox"
      },
      "verified": "2026-10-23",
      "note": "API v1alpha2, contract v1beta2. Upstream lists CAPI v1.11/v1.12; verified live with CAPI v1.14.3 (RKE2 and k0s, FP-31 spike). Skips TLS verification unless PROXMOX_INSECURE=false."
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
      "verified": "2026-10-20",
      "note": "Latest patch per minor from the rancher/rke2 releases. The RKE2 provider runs its e2e tests with Kubernetes v1.35; v1.36 was verified live in FP-29 (upgrade from v1.35, 2026-10-28).",
      "versions": [
        {
          "version": "v1.37.1+rke2r1",
          "verifiedWithProvider": "v0.27.1",
          "untested": true
        },
        {
          "version": "v1.36.5+rke2r1",
          "verifiedWithProvider": "v0.27.1"
        },
        {
          "version": "v1.35.9+rke2r1",
          "verifiedWithProvider": "v0.27.1",
          "default": true
        },
        {
          "version": "v1.34.12+rke2r1",
          "verifiedWithProvider": "v0.27.1"
        },
        {
          "version": "v1.33.13+rke2r3",
          "verifiedWithProvider": "v0.27.1"
        }
      ]
    },
    "k0s": {
      "source": {
        "datasource": "github-releases",
        "package": "k0sproject/k0s"
      },
      "verified": "2026-10-28",
      "note": "Latest patch per minor from the k0sproject/k0s releases. k0smotron runs its e2e tests with v1.31 only; v1.34 and v1.35 were verified live in FP-9, v1.36 in FP-29 (v1.36.4, upgrade from v1.35.8, 2026-10-28). The patches of 2026-10-27 (v1.34.12, v1.35.9, v1.36.5) were taken one day after their release, before the minimum release age, at the user's request for 0.12.0. v1.37.1: a one-node cluster on Proxmox VE upgraded live from v1.36.5 (2026-10-28).",
      "versions": [
        {
          "version": "v1.37.1+k0s.0",
          "verifiedWithProvider": "v2.3.0",
          "untested": true
        },
        {
          "version": "v1.36.5+k0s.0",
          "verifiedWithProvider": "v2.3.0"
        },
        {
          "version": "v1.35.9+k0s.0",
          "verifiedWithProvider": "v2.3.0",
          "default": true
        },
        {
          "version": "v1.34.12+k0s.0",
          "verifiedWithProvider": "v2.3.0"
        },
        {
          "version": "v1.33.13+k0s.1",
          "verifiedWithProvider": "v2.3.0"
        }
      ]
    },
    "kubeadm": {
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes/kubernetes"
      },
      "verified": "2026-10-18",
      "note": "Checked against dl.k8s.io/release/stable-1.XX.txt and the pkgs.k8s.io deb and rpm repositories (FP10-F-02); Cluster API v1.14 supports v1.33 to v1.37 for kubeadm.",
      "versions": [
        {
          "version": "v1.37.1",
          "verifiedWithProvider": "v1.14.3"
        },
        {
          "version": "v1.36.5",
          "verifiedWithProvider": "v1.14.3"
        },
        {
          "version": "v1.35.9",
          "verifiedWithProvider": "v1.14.3",
          "default": true
        },
        {
          "version": "v1.34.12",
          "verifiedWithProvider": "v1.14.3"
        },
        {
          "version": "v1.33.13",
          "verifiedWithProvider": "v1.14.3"
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
      "version": "0.2.10",
      "source": {
        "datasource": "helm",
        "package": "kube-vip-cloud-provider",
        "registry": "https://kube-vip.github.io/helm-charts"
      },
      "verified": "2026-10-24",
      "note": "Chart default image is v0.0.12 on Docker Hub; the preset uses images.kube-vip-cloud-provider. RBAC identical to the upstream manifest of v0.0.13."
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
      "version": "v36.4.9",
      "source": {
        "datasource": "docker",
        "package": "cloud-provider-gcp/cloud-controller-manager",
        "registry": "https://registry.k8s.io"
      },
      "verified": "2026-10-20",
      "note": "The repository has tags but no GitHub releases; the image follows the Kubernetes minor (v36 = 1.36) and supports the minors around it. The manifest is meant for tooling (empty args, cloud config from the host); the app fills both (gcp-addons.ts).",
      "manifest": "gcp-ccm-v36.4.9.yaml",
      "sha256": "46ffa27d31d17a8f7cbfbabefa61b6031def573763bb7be1b3bc0d5525e91970"
    },
    "gcp-csi": {
      "version": "v1.27.5",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/gcp-compute-persistent-disk-csi-driver"
      },
      "verified": "2026-10-20",
      "manifest": "gcp-pd-csi-noauth-v1.27.5.yaml",
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
      "version": "1.8.1.1",
      "source": {
        "datasource": "docker",
        "package": "alpine/socat",
        "registry": "docker.io"
      },
      "verified": "2026-10-20"
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
