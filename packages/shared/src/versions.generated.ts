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
      "version": "v0.27.0",
      "source": {
        "datasource": "github-releases",
        "package": "rancher/cluster-api-provider-rke2"
      },
      "verified": "2026-10-20",
      "note": "v0.27.0 was taken one day after its release, before the minimum release age, to test the update and rollback procedure. No API changes from v0.26.0; built on CAPI v1.14.3."
    },
    "k0smotron": {
      "version": "v2.2.0",
      "source": {
        "datasource": "github-releases",
        "package": "k0sproject/k0smotron"
      },
      "verified": "2026-10-17",
      "note": "Control plane machine replacement is blocked (ADR-0013); check the release notes first."
    },
    "openstack": {
      "version": "v0.15.0",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/cluster-api-provider-openstack"
      },
      "verified": "2026-10-17",
      "note": "Needs the ORC version of its minor (prerequisites.orc)."
    },
    "aws": {
      "version": "v2.13.1",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/cluster-api-provider-aws"
      },
      "verified": "2026-10-17"
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
      "version": "v1.21.2",
      "source": {
        "datasource": "github-releases",
        "package": "cert-manager/cert-manager"
      },
      "verified": "2026-10-17",
      "note": "Install command uses the Helm chart oci://quay.io/jetstack/charts/cert-manager with this version."
    },
    "capi-operator": {
      "version": "v0.29.0",
      "source": {
        "datasource": "github-releases",
        "package": "kubernetes-sigs/cluster-api-operator"
      },
      "verified": "2026-10-17",
      "note": "The Helm chart version is this version without the leading \"v\"."
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
      "note": "Latest patch per minor from the rancher/rke2 releases. The RKE2 provider runs its e2e tests with Kubernetes v1.35.",
      "versions": [
        {
          "version": "v1.37.1+rke2r1",
          "verifiedWithProvider": "v0.27.0",
          "untested": true
        },
        {
          "version": "v1.36.5+rke2r1",
          "verifiedWithProvider": "v0.27.0",
          "untested": true
        },
        {
          "version": "v1.35.9+rke2r1",
          "verifiedWithProvider": "v0.27.0",
          "default": true
        },
        {
          "version": "v1.34.12+rke2r1",
          "verifiedWithProvider": "v0.27.0"
        },
        {
          "version": "v1.33.13+rke2r3",
          "verifiedWithProvider": "v0.27.0"
        }
      ]
    },
    "k0s": {
      "source": {
        "datasource": "github-releases",
        "package": "k0sproject/k0s"
      },
      "verified": "2026-10-18",
      "note": "Latest patch per minor from the k0sproject/k0s releases. k0smotron runs its e2e tests with v1.31 only; v1.34 and v1.35 were verified live in FP-9.",
      "versions": [
        {
          "version": "v1.36.4+k0s.1",
          "verifiedWithProvider": "v2.2.0",
          "untested": true
        },
        {
          "version": "v1.35.8+k0s.1",
          "verifiedWithProvider": "v2.2.0",
          "default": true
        },
        {
          "version": "v1.34.11+k0s.1",
          "verifiedWithProvider": "v2.2.0"
        },
        {
          "version": "v1.33.13+k0s.1",
          "verifiedWithProvider": "v2.2.0"
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
      "version": "2.67.0",
      "source": {
        "datasource": "helm",
        "package": "aws-ebs-csi-driver",
        "registry": "https://kubernetes-sigs.github.io/aws-ebs-csi-driver"
      },
      "verified": "2026-10-17"
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
  "images": {
    "node-shell": {
      "version": "3.24",
      "source": {
        "datasource": "docker",
        "package": "alpine",
        "registry": "docker.io"
      },
      "verified": "2026-10-20"
    }
  }
};
