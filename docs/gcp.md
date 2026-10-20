# Google Cloud

CAPI Navigator creates Kubernetes clusters on Google Cloud with the Cluster API provider CAPG
(FP-25). This page covers the one-time setup in the Google Cloud project, what the app creates per
cluster, and the limits compared with OpenStack and AWS.

## Setup in the Google Cloud project

1. **Project**: use a project for Cluster API only, so the service account's roles do not reach
   other workloads. Note its project ID (not the display name).
2. **APIs**: enable the **Compute Engine API** (APIs & Services → Library). The **Cloud Resource
   Manager API** is optional: without it the app's credential test cannot check the permissions
   and shows a warning instead.
3. **Service account**: IAM & Admin → Service accounts → Create. Grant it on the project the role
   **Editor** (`roles/editor`), or the narrower pair **Compute Admin** (`roles/compute.admin`) and
   **Service Account User** (`roles/iam.serviceAccountUser`). Grant the roles on the project (IAM &
   Admin → IAM → Grant access), not on the service account itself. Roles such as "Compute Engine
   Service Agent" are meant for Google's own accounts and do not work.
4. **Key**: on the service account, Keys → Add key → Create new key → JSON. If key creation is
   refused, the organization policy `iam.disableServiceAccountKeyCreation` blocks it; an
   organization admin can allow it for this project.
5. **Quota**: a cluster with three control plane nodes and two workers on `e2-standard-2` needs
   10 vCPUs in the region, one global external IP address for the API, one regional IP for Cloud
   NAT and one per LoadBalancer Service. New projects often start with 24 vCPUs per region
   (IAM & Admin → Quotas).

## In the app

1. **Providers**: install core, the providers of your distribution (RKE2, k0smotron or kubeadm),
   **Google Cloud (CAPG)** and CAAPH. CAPG takes no global credentials; every cluster names its
   own.
2. **Credentials → Add Google Cloud**: upload the JSON key and choose a default region, e.g.
   `europe-west3` (Frankfurt) or `europe-west6` (Zurich). The key is stored as a Secret in
   `capg-system` and never shown again. **Test** checks the key, the Compute Engine API, the region
   and the permissions Cluster API needs; missing ones are named with the role that grants them.
3. **Create cluster**: choose Google Cloud. Project and region come from the credential; the zone
   is optional (empty: CAPG spreads the control plane over the region's zones). Machine types and
   the public Ubuntu, Debian and Rocky Linux images come from the project.

## What the app creates

Everything is standard CAPG and stays manageable without the app:

| Resource                   | Details                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network                    | A VPC named after the cluster with one subnet (default `10.6.0.0/24`); CAPG adds a Cloud Router with Cloud NAT, so nodes have no public IP. All of it is deleted with the cluster. |
| Firewall                   | CAPG's rules: all traffic between the cluster's machines, and the health checks of the API load balancer                                                                           |
| API load balancer          | A global TCP proxy on port 6443 ([ADR-0022](adr/0022-gcp-api-load-balancer.md))                                                                                                    |
| Machines                   | `GCPMachineTemplate` with machine type, image, boot disk (default 30 GB `pd-standard`) and the cluster's subnet; the control plane runs as the service account of the credential   |
| Cloud controller manager   | kubernetes/cloud-provider-gcp, delivered by ClusterResourceSet ([ADR-0023](adr/0023-gcp-ccm-and-csi-as-manifests.md)): node initialization and `LoadBalancer` Services             |
| Persistent disk CSI driver | kubernetes-sigs/gcp-compute-persistent-disk-csi-driver with the default StorageClass `pd-balanced`                                                                                 |

CCM and CSI driver authenticate through the metadata server with the service account of the
control plane machines; no key is copied into the workload cluster. The wizard fills in the
credential's account; another account with fewer roles can be entered.

## Differences to OpenStack and AWS

- **API load balancer**: it forwards only the API port and checks `/readyz` without credentials.
  k0s therefore runs without Konnectivity, and RKE2 allows anonymous requests, which the default
  RBAC limits to health and version endpoints ([ADR-0022](adr/0022-gcp-api-load-balancer.md)).
- **Hostnames**: GCE hands out the FQDN as hostname; nodes get the short instance name before the
  distribution is installed.
- **No bastion host**: CAPG has none. Reach nodes with SSH through Identity-Aware Proxy: allow
  `tcp:22` from `35.235.240.0/20` on the cluster's network, then
  `gcloud compute ssh <instance> --zone <zone> --tunnel-through-iap`. The SSH keys of the wizard's
  advanced step are installed for the image's default user.

## Deleting

Delete clusters in the app with cleanup: it removes `LoadBalancer` Services and volumes first,
so the load balancers and persistent disks the CCM and the CSI driver created in Google Cloud are
gone before CAPG removes machines, load balancer and network. Afterwards the project holds nothing
of the cluster.
