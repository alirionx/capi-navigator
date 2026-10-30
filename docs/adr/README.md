# Architecture decision records

One short ADR per decision that deviates from or refines `docs/requirements.md`.

| ADR                                                         | Title                                                                            | Status   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | -------- |
| [0001](0001-typescript-6.md)                                | TypeScript 7 compiler, TypeScript 6 API for the tools                            | accepted |
| [0002](0002-cluster-scoped-provider-identities.md)          | Cluster-scoped provider identities                                               | accepted |
| [0003](0003-aws-stock-images-without-secrets-manager.md)    | AWS user data without Secrets Manager on stock images                            | accepted |
| [0004](0004-node-provider-id-and-openstack-cloud-config.md) | providerID from instance metadata; OpenStack cloud config via ClusterResourceSet | accepted |
| [0005](0005-workload-kubeconfig-view-and-download.md)       | Showing and downloading workload cluster kubeconfigs                             | accepted |
| [0006](0006-cluster-deletion-with-cleanup.md)               | Cluster deletion with cleanup inside the workload cluster                        | accepted |
| [0007](0007-bastion-host.md)                                | Bastion host via the providers' built-in bastion                                 | accepted |
| [0008](0008-node-shell-via-privileged-pod.md)               | Node shell via a privileged pod                                                  | accepted |
| [0009](0009-dashboard-polling.md)                           | Polling for the read-only cluster dashboard                                      | accepted |
| [0010](0010-rollout-controller.md)                          | Background rollout controller in the backend                                     | accepted |
| [0011](0011-helm-addons.md)                                 | Helm add-ons with the HelmChartProxy as source of truth                          | accepted |
| [0012](0012-flavor-network-requirements.md)                 | Kubernetes distributions declare their network needs                             | accepted |
| [0013](0013-k0s-control-plane-replacement.md)               | k0s control plane replacement                                                    | accepted |
| [0014](0014-kubeadm-on-stock-images.md)                     | kubeadm on stock images with release binaries for the container runtime          | accepted |
| [0015](0015-permissions-and-scoped-role-assignments.md)     | Permissions and scoped role assignments                                          | accepted |
| [0016](0016-openapi-from-zod-and-route-metadata.md)         | OpenAPI generated from Zod schemas and route metadata                            | accepted |
| [0017](0017-api-tokens-for-technical-users.md)              | API tokens for technical users                                                   | accepted |
| [0018](0018-versions-yaml-and-update-report.md)             | versions.yaml and an update report instead of update bots                        | accepted |
| [0019](0019-oidc-sign-in-with-group-mapping.md)             | OpenID Connect sign-in with group mapping                                        | accepted |
| [0020](0020-oidc-settings-in-the-web-ui.md)                 | OpenID Connect settings in the web UI                                            | accepted |
| [0021](0021-plugin-described-provider-forms.md)             | Provider forms described by the infrastructure plugins                           | accepted |
| [0022](0022-gcp-api-load-balancer.md)                       | Distributions behind the Google Cloud API load balancer                          | accepted |
| [0023](0023-gcp-ccm-and-csi-as-manifests.md)                | Google Cloud CCM and CSI driver as manifests with node credentials               | accepted |
| [0024](0024-manifest-addons-through-caaph.md)               | Manifest add-ons through CAAPH with a generic chart of the project               | proposed |
| [0025](0025-changes-apply-only-what-they-touch.md)          | Cluster changes apply only the objects they touch                                | accepted |
| [0026](0026-openstack-volumes-across-zones.md)              | OpenStack volumes not bound to an availability zone (optional)                   | accepted |
| [0027](0027-proxmox-ve-with-capmox.md)                      | Proxmox VE with CAPMOX, kube-vip and per-cluster address ranges                  | proposed |
| [0028](0028-proxmox-loadbalancer-services-as-presets.md)    | LoadBalancer Services on Proxmox VE through kube-vip presets                     | accepted |
| [0029](0029-outbound-proxy-for-app-and-providers.md)        | Outbound proxy for the app and the provider controllers                          | accepted |
| [0030](0030-air-gapped-nodes-from-an-internal-registry.md)  | Air-gapped nodes from an internal OCI registry                                   | accepted |
| [0031](0031-vuetify-4.md)                                   | Vuetify 4                                                                        | accepted |
| [0032](0032-kubeadm-on-capi-images.md)                      | kubeadm on Cluster API images, online and air-gapped                             | accepted |
