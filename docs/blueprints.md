# Cluster blueprints

A cluster blueprint is a cluster spec that an admin has reviewed, plus a few parameters that may
vary within limits. Clients create clusters from a blueprint through the API without composing a
spec and without a preview per request: the blueprint is what was reviewed when it was saved
([ADR-0035](adr/0035-clusters-from-blueprints-without-preview.md), FP-34). The first client is
meant to be an Open Service Broker for Cloud Foundry, built as a separate project (outlook FP-35).

## What a blueprint fixes

A blueprint takes the spec of a cluster the app created. Everything in it is fixed:

- the management cluster connection and the namespace,
- the credential, the infrastructure provider and its settings (network, image, …),
- the distribution, the topology (standard, all-in-one or hosted), add-ons and labels,
- node customization, SSH keys and rollout settings.

The cluster name in the base spec is only the example used for the check when saving.

On OpenStack all clusters of a blueprint share its node network unless the blueprint has a node
network pool (see below). Each cluster has its own network and router, so a shared network works on
most clouds.

## Parameters

Only these parameters exist. Each one has a default (the value of the base spec) and limits:

| Parameter               | Limits                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Workers per worker pool | Minimum and maximum                                                                          |
| Machine size per pool   | A list of sizes: flavors, instance or machine types, or the sizes of a Proxmox VE credential |
| Kubernetes version      | Versions from the version catalog; not offered for air-gapped clusters                       |

`GET /api/blueprints/{name}` returns the parameters as JSON Schema draft-04 in
`parametersSchema`, ready to be used as the plan schema of a service broker:

```json
{
  "workerPools": { "default": { "replicas": 3, "machineSize": "t3.xlarge" } },
  "kubernetesVersion": "v1.36.5+rke2r1"
}
```

Unknown parameters and values outside the limits are refused with `400`.

## Address pool (Proxmox VE)

On Proxmox VE the API address, the node addresses and the LoadBalancer addresses belong to one
cluster. A blueprint there carries an **address pool** instead: for every order the app takes free
addresses of the pool (addresses no other Proxmox cluster of the management cluster uses, without
the gateway):

- one API address,
- the nodes of the cluster plus the largest surge of a rollout (by default one),
- as many LoadBalancer addresses as the base spec has.

Orders of a connection run one after another, so two orders never get the same addresses. When the
pool is used up, an order is refused with `409`. Blueprints of hosted control planes are not
supported on Proxmox VE.

## Node network pool (OpenStack)

On OpenStack, a blueprint should carry a **node network pool**, e.g. `10.7.0.0/16`
([ADR-0038](adr/0038-node-network-pool-for-openstack-blueprints.md)). For every order the app
takes the first network of the size of the base spec's node network (e.g. `/24`) that neither the
node network of another OpenStack cluster of the management cluster nor a subnet of the project
uses. Separate networks per cluster are good practice:

- networks of a project can only be routed to each other (or to a VPN) when they do not overlap,
  e.g. to reach a database VM in another network of the project;
- some clouds refuse overlapping subnets in a project, e.g. clouds with a routed VRF per project:
  the second cluster of a blueprint with a shared network then never comes up, and CAPO reports
  `SubnetOverlapInRoutedVRF`.

The blueprints page suggests the /16 of the node network as pool for a new blueprint.

- The pool is optional. Without it, all clusters of the blueprint share its node network, which
  most clouds accept.
- The pool must not overlap the pod and service networks of the base spec.
- When the pool is used up, an order is refused with `409`. A deleted cluster frees its network
  only when CAPO has removed the subnet, so shortly after a deletion a nearly full pool may still
  answer `409`.
- If the app cannot read the subnets of the project, the order is refused with `502` rather than
  given a network that might be taken.
- The pool works for blueprints of hosted control planes too.

## Saving a blueprint

The Blueprints page (users with `blueprints.manage`, admins) creates a blueprint from the spec of an
existing cluster. **Check** builds the cluster with the default parameters, shows the generated
YAML and runs a dry run on the management cluster, with the same blockers as the wizard: providers
installed, credential tested and allowed in the namespace, versions in the catalog. **Save** is
possible only after a check without blockers.

Changing a blueprint applies only to clusters created afterwards. A blueprint cannot be deleted
while clusters created from it exist.

## Creating a cluster from a blueprint

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  https://navigator.example.com/api/blueprints/small/clusters \
  -d '{"name": "orders-dev",
       "parameters": {"workerPools": {"default": {"replicas": 3}}},
       "labels": {"example.com/instance-id": "b5a3f0c2"}}'
```

The request needs `clusters.create` in the blueprint's namespace. Additional labels follow the rules
of cluster labels (nothing under `capi-navigator.io/` or `cluster.x-k8s.io/`) and cannot change the
blueprint's labels. The answer is the cluster summary; creation continues asynchronously, like in
the wizard. Find the cluster again by its label:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  'https://navigator.example.com/api/connections/home/clusters?labelSelector=example.com/instance-id=b5a3f0c2'
```

The cluster stores its spec like every other cluster, with `blueprint: small`, and carries the
annotation `capi-navigator.io/blueprint`. It stays a regular Cluster API cluster that works without
the app.

### Technical user for a client

A client such as a service broker uses a technical user with an API token (FP-22) and a role with
these permissions. Limit the assignment of `clusters.create`, `clusters.delete` and
`clusters.kubeconfig` to the connection and namespace of its blueprints. `view` cannot be limited
(FP-19): the user can read every cluster and blueprint of the app, but change none outside its
scope.

| Permission            | For                                                      |
| --------------------- | -------------------------------------------------------- |
| `view`                | Read blueprints, the cluster list and the cluster status |
| `clusters.create`     | Create clusters from blueprints                          |
| `clusters.delete`     | Delete them again (with cleanup in the workload cluster) |
| `clusters.kubeconfig` | Hand out the admin kubeconfig (audited)                  |

## Bound clusters

A cluster created from a blueprint stays bound to it. The backend refuses scaling, labels, pools,
machine changes, infrastructure settings, the bastion and add-on assignment by label with `409`.
Only users with `blueprints.manage` can upgrade its Kubernetes version or reapply its spec (for
example after an app update), with the usual preview; the workers follow an upgrade automatically.
Deleting, the kubeconfig, the dashboard and the node shell work as for every cluster.

## Not in the first version

- No blueprint versions: changes do not reach existing clusters, and there is no update of a
  cluster to a newer state of its blueprint.
- No changes of parameters after creation (no broker updates).
- No limit on the number of clusters per blueprint; capacity stays with the admins.
- No creation from a blueprint in the UI; the wizard stays the way to create clusters by hand.
