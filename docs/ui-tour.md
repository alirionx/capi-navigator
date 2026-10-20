# UI tour

A walk through CAPI Navigator, from an empty management cluster to operating workload clusters.
Each step names the Cluster API resources behind the screen, because the app is meant to make
them visible. The two demo clusters run RKE2 on OpenStack (Infomaniak) and kubeadm on AWS.

The screenshots are generated with `pnpm docs:screenshots` (see [Updating the screenshots](#updating-the-screenshots)).

- [1. Getting started](#1-getting-started)
- [2. Preparing the management cluster](#2-preparing-the-management-cluster)
- [3. Creating a cluster](#3-creating-a-cluster)
- [4. Understanding a cluster](#4-understanding-a-cluster)
- [5. Day-2 operations](#5-day-2-operations)
- [6. Add-ons](#6-add-ons)
- [7. Administration and API](#7-administration-and-api)

## 1. Getting started

The home page shows the active management cluster: its installed providers and the workload
clusters that use them. The lines show which providers a cluster depends on, e.g. an RKE2 cluster
on OpenStack needs the core provider, the RKE2 bootstrap and control plane providers and CAPO.

![Home page with providers and workload clusters](images/ui-tour/01-home.png)

The cluster list covers all workload clusters (`Cluster` resources) of the management cluster,
with distribution, version, node counts and labels, live via server-sent events.

![Cluster list](images/ui-tour/02-clusters.png)

## 2. Preparing the management cluster

**Connections**: one installation manages several management clusters. The home cluster, which
also stores the app's own state, is always there; others are added with a kubeconfig or a
service account token. The credentials stay in Secrets in the backend.

![Management cluster connections](images/ui-tour/03-connections.png)

**Providers**: cert-manager and the CAPI Operator are prerequisites; the app installs and upgrades
ORC and the CAPI providers declaratively as `CoreProvider`, `BootstrapProvider`,
`ControlPlaneProvider`, `InfrastructureProvider` and `AddonProvider` resources. The versions come
from the pinned catalog ([versions.yaml](../versions.yaml)); downgrades are refused.

![Providers](images/ui-tour/04-providers.png)

**Credentials**: an OpenStack `clouds.yaml`, AWS access keys or a Google Cloud service account key
are stored once as a Secret, for OpenStack and AWS plus a cluster-wide identity
(`OpenStackClusterIdentity`, `AWSClusterStaticIdentity`); Google Cloud clusters reference the Secret
directly ([setup](gcp.md)). A test checks authentication and the required permissions.

![Cloud credentials](images/ui-tour/05-credentials.png)

**Helm repositories** are the sources for add-ons; their credentials stay in Secrets as well.

![Helm repositories](images/ui-tour/06-helm-repositories.png)

## 3. Creating a cluster

The wizard has eight steps. Every field explains its default and the CAPI resource and field it
maps to, so the form doubles as documentation.

**Basics**: name, namespace, distribution (RKE2, k0s or kubeadm), Kubernetes version from the
version catalog, infrastructure provider and credentials.

![Wizard: basics](images/ui-tour/20-wizard-basics.png)

**Topology**: standard (control plane plus worker pools) or all-in-one, the number of control plane
nodes (1, 3 or 5 for etcd quorum), machine sizes, root disks and node labels.

![Wizard: topology](images/ui-tour/21-wizard-topology.png)

**Infrastructure**: images, flavors, networks and key pairs are looked up live in the cloud with
the selected credentials, so there is nothing to copy from the cloud console.

![Wizard: infrastructure with images from the cloud](images/ui-tour/22-wizard-infrastructure.png)

**Add-ons**: the cloud controller manager and the CSI driver are rolled out as Helm charts through
CAAPH; a reboot daemon (kured) is optional.

![Wizard: add-ons](images/ui-tour/23-wizard-addons.png)

**Preview**: before anything is applied, the wizard shows every object it will create, plain
upstream Cluster API YAML applied with server-side apply. Secret values are masked.

![Wizard: YAML preview](images/ui-tour/24-wizard-preview.png)

## 4. Understanding a cluster

The overview shows the state of the `Cluster`, the infrastructure cluster, the control plane and
each worker pool, plus the infrastructure details from the stored cluster spec.

![Cluster overview](images/ui-tour/10-cluster-overview.png)

The **resource tree** shows how the CAPI objects belong together: `Cluster` → infrastructure
cluster, control plane and `MachineDeployment` → `Machine`. Each node opens its live YAML.

![Resource tree](images/ui-tour/11-resource-tree.png)

**Machines** lists every `Machine` with its node, provider ID, size and image.

![Machines](images/ui-tour/12-machines.png)

The **dashboard** reads the workload cluster itself: node usage against requests and limits,
workloads, services and events. It is read-only.

![Cluster dashboard](images/ui-tour/13-dashboard.png)

The **node shell** opens a root shell on a node in the browser: a short-lived privileged pod
enters the host namespaces, like `kubectl debug node`. It needs its own permission, and start and
end are recorded in the audit log.

![Node shell](images/ui-tour/14-node-shell.png)

The same views exist for AWS; here a kubeadm cluster with a bastion host.

![Cluster on AWS](images/ui-tour/19-cluster-aws.png)

The **events** tab shows what the CAPI controllers report for the cluster's objects.

![Events](images/ui-tour/18-events.png)

## 5. Day-2 operations

All changes go through forms that update the stored cluster spec; the YAML is never edited by hand.
The configuration tab offers upgrades, scaling, machine size and image changes, node
customization, rebuilds and worker pools. Changes made outside the app show up as drift.

![Cluster configuration](images/ui-tour/15-configuration.png)

Every change shows a diff of the affected objects before it is applied. Changes that replace
machines create new templates instead of editing existing ones, and the preview names the groups
that roll.

![Change preview with diff](images/ui-tour/16-change-preview.png)

## 6. Add-ons

A cluster's **add-ons** tab shows the Helm releases CAAPH rolled out to it, here the OpenStack
cloud controller manager and Cinder CSI.

![Add-ons of a cluster](images/ui-tour/17-cluster-addons.png)

The **add-ons** page manages `HelmChartProxy` resources: a chart with values and a label selector
that picks the clusters. The presets for CCM, CSI and kured can be overridden here.

![Helm add-ons and presets](images/ui-tour/30-addons.png)

## 7. Administration and API

**Roles** are sets of permissions. The built-in roles viewer, operator and admin cannot be
changed; custom roles can, and role assignments can be limited to connections and namespaces.

![Roles](images/ui-tour/31-roles.png)

![Role editor](images/ui-tour/32-role-editor.png)

**Users** are local accounts with role assignments. Technical users exist for scripts only.

![Users](images/ui-tour/33-users.png)

Technical users get **API tokens** with an expiry date; the token is shown once.

![API tokens of a technical user](images/ui-tour/34-api-tokens.png)

The **REST API** is described with OpenAPI 3.1 and can be tried out in the Swagger UI
(`/api/docs`, the **API** button in the app bar).

![Swagger UI](images/ui-tour/35-swagger.png)

## Updating the screenshots

`pnpm docs:screenshots` runs [e2e/ui-tour.tour.ts](../e2e/ui-tour.tour.ts) with Playwright against
the running app (`pnpm dev`). It only reads: the wizard stops at the preview and change dialogs
stop at their diff. It needs an admin password and two running workload clusters:

```sh
E2E_ADMIN_PASSWORD=… TOUR_OPENSTACK=<cluster> TOUR_AWS=<cluster> \
  TOUR_REPLACE='real-name=demo-name,…' pnpm docs:screenshots
```

Before each screenshot it replaces the names from `TOUR_REPLACE`, AWS account IDs and the end of
access keys in the page, moves public IP addresses to the documentation range `203.0.113.0/24`
and blacks out the last octet of private ones, so no real account data ends up in the images.
Review the images before committing them.
