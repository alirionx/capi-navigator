# Upstream manifests shipped with the backend

These files are copies of upstream manifests, verified by their checksum in `versions.yaml`. The app
adapts them in memory before it delivers them to workload clusters through ClusterResourceSets;
every adapted manifest starts with a comment that names the source, the license and the changes.
All three are licensed under the Apache License, Version 2.0 (copy: `LICENSE.Apache-2.0` in this
directory, or https://www.apache.org/licenses/LICENSE-2.0).

## calico/calico-vxlan-v3.33.0.yaml

- Source: Project Calico, `manifests/calico-vxlan.yaml` of release v3.33.0,
  https://github.com/projectcalico/calico (Copyright Tigera, Inc. and the Project Calico contributors)
- License: Apache License 2.0
- Changes by CAPI Navigator (`calicoManifestForCluster`, packages/shared/src/cluster/cni.ts):
  `CALICO_IPV4POOL_VXLAN` and `CALICO_IPV6POOL_VXLAN` set from `CrossSubnet` to `Always`.

## gcp/gcp-ccm-v36.4.9.yaml

- Source: Cloud Provider GCP, `deploy/packages/default/manifest.yaml` of tag v36.4.9,
  https://github.com/kubernetes/cloud-provider-gcp (Copyright The Kubernetes Authors)
- License: Apache License 2.0
- Changes by CAPI Navigator (`gcpCcmManifestForCluster`, packages/shared/src/cluster/gcp-addons.ts):
  pinned image, controller manager arguments, cloud configuration as ConfigMap instead of a host
  path, API server environment variables removed, a Role and RoleBinding for the `ingress-uid`
  ConfigMap added.

## gcp/gcp-pd-csi-noauth-v1.27.5.yaml

- Source: Google Compute Engine Persistent Disk CSI Driver, output of
  `kubectl kustomize deploy/kubernetes/overlays/noauth` at release v1.27.5,
  https://github.com/kubernetes-sigs/gcp-compute-persistent-disk-csi-driver
  (Copyright The Kubernetes Authors)
- License: Apache License 2.0
- Changes by CAPI Navigator (`gcpCsiManifestForCluster`, packages/shared/src/cluster/gcp-addons.ts):
  namespace added, controller kept on control plane nodes, node plugin allowed on control plane
  nodes, default StorageClass `pd-balanced` added.

## swagger-ui/

Own files of CAPI Navigator (start page of the API documentation); the Swagger UI itself comes from
the `swagger-ui-dist` package (Apache License 2.0).
