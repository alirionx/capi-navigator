# Architecture decision records

One short ADR per decision that deviates from or refines `docs/requirements.md`.

| ADR                                                         | Title                                                                            | Status   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | -------- |
| [0001](0001-typescript-6.md)                                | TypeScript 6.0 instead of 7.0                                                    | accepted |
| [0002](0002-cluster-scoped-provider-identities.md)          | Cluster-scoped provider identities                                               | accepted |
| [0003](0003-aws-stock-images-without-secrets-manager.md)    | AWS user data without Secrets Manager on stock images                            | accepted |
| [0004](0004-node-provider-id-and-openstack-cloud-config.md) | providerID from instance metadata; OpenStack cloud config via ClusterResourceSet | accepted |
| [0005](0005-workload-kubeconfig-view-and-download.md)       | Showing and downloading workload cluster kubeconfigs                             | accepted |
| [0006](0006-cluster-deletion-with-cleanup.md)               | Cluster deletion with cleanup inside the workload cluster                        | accepted |
| [0007](0007-bastion-host.md)                                | Bastion host via the providers' built-in bastion                                 | accepted |
| [0008](0008-node-shell-via-privileged-pod.md)               | Node shell via a privileged pod                                                  | accepted |
