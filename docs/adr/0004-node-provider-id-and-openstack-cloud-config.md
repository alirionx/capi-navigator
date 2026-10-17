# ADR-0004: providerID from instance metadata; OpenStack cloud config via ClusterResourceSet

- Status: accepted
- Date: 2026-10-17
- Pack: FP-5

## Context

1. CAPI links Machines to Nodes through `spec.providerID`. The RKE2 provider (v0.26.0) does not set
   it; usually the cloud controller manager does. With the CCM deselected (FP5-F-09 allows that),
   machines would never get a node and the cluster would never become ready.
2. The OpenStack CCM and Cinder CSI need a cloud config with credentials inside the workload
   cluster. Putting it into HelmChartProxy values would store credentials in plain text in a
   custom resource (hard rule 8).

## Decision

1. Every node sets the kubelet argument `provider-id` from cloud-init instance data (the RKE2
   provider renders user data as a Jinja template, `## template: jinja`):
   `openstack:///{{ v1.instance_id }}` and `aws:///{{ v1.availability_zone }}/{{ v1.instance_id }}`,
   and uses `{{ v1.local_hostname }}` as node name (required by the AWS CCM). This works with and
   without CCM; each infrastructure plugin provides its format.
2. For OpenStack, the backend creates one Secret per cluster in the management cluster (type
   `addons.cluster.x-k8s.io/resource-set`) that contains the `kube-system/cloud-config` Secret
   derived from the credential, and a `ClusterResourceSet` (strategy `Reconcile`, GA in CAPI 1.14)
   delivers it. The CCM and CSI charts only reference that Secret. AWS needs no secret: CCM and EBS
   CSI use the IAM instance profiles created by `clusterawsadm`.

## Consequences

- Clusters become ready with or without CCM.
- Credentials stay in Secrets; rotating a credential updates the workload clusters via the CRS.
- ClusterResourceSet is upstream CAPI, so clusters stay manageable without the app (POS-01).
