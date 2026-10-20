# ADR-0023: Google Cloud CCM and CSI driver as manifests with node credentials

- Status: accepted
- Date: 2026-10-20
- Pack: FP-25
- Refines: FP25-F-08, [ADR-0014](0014-kubeadm-on-stock-images.md) (Calico by ClusterResourceSet)

## Context

The other clouds get their cloud controller manager (CCM) and CSI driver as CAAPH Helm presets.
For Google Cloud neither kubernetes/cloud-provider-gcp nor
kubernetes-sigs/gcp-compute-persistent-disk-csi-driver publishes a Helm chart (FP25-F-08):

- cloud-provider-gcp has tags but no releases. Its `deploy/packages/default/manifest.yaml` is
  meant for tooling such as kops: the arguments are empty, the cloud config is read from the host
  (`/etc/kubernetes/cloud.config`), the image is `:latest`, and the API server is assumed at
  `127.0.0.1` with the port of the `kubernetes` Service.
- The PD CSI driver ships kustomize overlays; `noauth` drops the service account key and uses the
  account of the node through the metadata server.

Both need Google credentials. Copying the stored key into every workload cluster (as k0rdent does)
spreads the key; the default compute account works without a key but has no roles in many newer
projects.

## Decision

- **Manifests, verified and adapted.** The upstream files are shipped unchanged in
  `apps/backend/assets/gcp` (CCM: the manifest of the tag; CSI: `kubectl kustomize` of the
  `noauth` overlay of the release) and pinned with version and sha256 in `versions.yaml`
  (`addonManifests`). Pure functions in `packages/shared` (`gcp-addons.ts`) adapt them, with
  tests: the CCM gets a pinned image, its arguments (no route or CIDR management, which the CNI
  does), its cloud config as ConfigMap (`multizone`; project, zone, network and node tags come from
  the metadata server) and the API port 6443 (ADR-0022). The CSI driver gets its namespace, its
  controller on control plane nodes and a default StorageClass `pd-balanced`.
- **Generic manifest add-ons.** `MANIFEST_ADDONS` lists add-ons by cluster label, file, checksum
  and adapter; the backend delivers every add-on a cluster's labels select with a
  ClusterResourceSet per namespace (`ApplyOnce`, versioned names), like Calico. Nothing in the
  backend names Google Cloud.
- **Credentials of the control plane machines.** The control plane machines run as the service
  account of the credential (`GCPMachineTemplate.serviceAccounts`, scope `cloud-platform`; default
  in the wizard, can be changed or cleared). CCM and CSI controller run on control plane nodes and
  get their tokens from the metadata server. No key reaches the workload cluster; workers keep
  CAPG's default account.

## Consequences

- Workloads on control plane nodes (all-in-one clusters) can obtain tokens of that account, like
  pods with host access on AWS can use the instance profile (ADR-0003). A dedicated account with
  fewer roles can be entered in the wizard.
- A new CCM or CSI version needs the new file and checksum in `versions.yaml`; the update report
  lists both under "Add-on manifests".
- A new version or content of an add-on gets a new resource set name. When the app adds it to a
  namespace, it removes the older resource sets of the same add-on (and Calico's) with their
  ConfigMaps, announced in the preview: otherwise new clusters would get every version. Clusters
  that already got an older version keep its objects (`ApplyOnce`).
- The CCM runs with `--use-service-account-credentials=false`, since the manifest only grants its
  own service account; its role cannot delete Node objects, which CAPI removes on machine deletion.
