# Architecture

This document explains how CAPI Navigator works behind the UI: which clusters are involved,
which resources the app writes, which controllers turn them into machines and Helm releases, and
where each part lives in the code. It complements the binding [requirements](requirements.md) and
the [architecture decisions](adr/README.md).

The one idea to keep in mind: **the app writes standard Kubernetes resources; controllers in the
management cluster do the actual work.** The app never creates a VM, never installs Kubernetes on
a node and never runs `helm install`. It writes a `Cluster`, a `KubeadmControlPlane` or a
`HelmChartProxy`, and Cluster API, the providers and CAAPH reconcile them. That is why clusters
stay manageable with `kubectl` and `clusterctl` after the app is removed.

## The three kinds of clusters

```
┌───────────────────────┐        ┌──────────────────────────────────────┐        ┌──────────────────┐
│ Home cluster          │        │ Management cluster(s)                │        │ Workload clusters│
│                       │        │                                      │        │                  │
│ CAPI Navigator pod    │──API──▶│ cert-manager, CAPI Operator          │──────▶ │ the clusters the │
│ app state:            │        │ providers: core, RKE2/k0s/kubeadm,   │ cloud  │ users run their  │
│  CRDs (users,         │        │   CAPO + ORC, CAPA, CAAPH            │  APIs  │ apps on          │
│  connections, repos,  │        │ CAPI resources of every workload     │        │                  │
│  audit), Secrets,     │        │   cluster, credentials (Secrets +    │        │ CCM, CSI, CNI,   │
│  ConfigMaps           │        │   identities), HelmChartProxies      │        │ add-ons          │
└───────────────────────┘        └──────────────────────────────────────┘        └──────────────────┘
```

| Cluster                | Role                                                                                  | What the app does there                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Home cluster**       | Runs the app and holds its own state (there is no database)                           | Reads and writes the app's CRDs, Secrets and ConfigMaps in its namespace (`NAVIGATOR_NAMESPACE`)                                                                                       |
| **Management cluster** | Runs Cluster API and the providers; holds the CAPI resources of the workload clusters | Installs providers, stores cloud credentials, writes the CAPI resources of workload clusters and the add-ons                                                                           |
| **Workload cluster**   | A cluster created through CAPI                                                        | Mostly nothing directly. The app reads it for the dashboard, opens node shells and cleans up before deletion, using the kubeconfig Secret that CAPI writes into the management cluster |

The home cluster can also be a management cluster (connection "Home cluster",
`homeClusterAsManagementCluster` in the Helm chart). In local development, the kind cluster is
both.

## Components

```
Browser (Vue 3 SPA)  ──REST + SSE + WebSocket──▶  NestJS backend  ──Kubernetes API──▶  home / management / workload clusters
        │                                              │
        └──────────── packages/shared (Zod schemas, catalogs, transformation, presets) ────────┘
```

| Part       | Path                                          | Responsibility                                                                                                                                                                                  |
| ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend   | [apps/frontend/src](../apps/frontend/src)     | Views, forms and previews. One Pinia store per domain ([stores](../apps/frontend/src/stores)); texts in [i18n](../apps/frontend/src/i18n). Never talks to Kubernetes and never sees credentials |
| Backend    | [apps/backend/src](../apps/backend/src)       | REST API, permission checks, audit, all Kubernetes access, live updates, background jobs                                                                                                        |
| Shared     | [packages/shared/src](../packages/shared/src) | Zod schemas (types, form and API validation, CRD schemas), catalogs of providers and versions, the pure transformation from cluster spec to CAPI resources, add-on presets                      |
| Deployment | [deploy](../deploy)                           | Generated CRDs, Helm chart, access manifests for management clusters                                                                                                                            |

Because frontend and backend import the same Zod schemas from `packages/shared`, a field is
defined once: the wizard validates it, the API validates it again, and the CRDs are generated
from it (`pnpm crds:generate`).

### Backend modules

One NestJS module per domain:

| Module             | Path                                                                       | What it does                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`             | [auth](../apps/backend/src/auth)                                           | Local users (`NavigatorUser` CRs, password hashes in Secrets) with role assignments, custom roles (`NavigatorRole`), sign-in with rate limit, sessions as signed cookies, the global permission guard |
| `audit`            | [audit](../apps/backend/src/audit)                                         | Interceptor that writes an `AuditEvent` for every mutating request and sensitive reads; cleanup after the retention period                                                                            |
| `store`            | [store](../apps/backend/src/store)                                         | Typed access to the app's CRDs (informer-backed cache, so reads do not hit the API server), Secrets and ConfigMaps in the home cluster                                                                |
| `kube`             | [kube](../apps/backend/src/kube)                                           | Kubernetes client helpers: server-side apply and dry runs, diffs, conflict parsing, error translation, Leases, live channels (watches → SSE)                                                          |
| `connections`      | [connections](../apps/backend/src/connections)                             | Management cluster connections (`ManagementCluster` CR + Secret with kubeconfig or token), connection tests, one cached client per connection                                                         |
| `operator`         | [operator](../apps/backend/src/operator)                                   | Prerequisites (cert-manager, CAPI Operator), ORC, provider CRs of the CAPI Operator                                                                                                                   |
| `credentials`      | [credentials](../apps/backend/src/credentials)                             | Cloud credentials on the management cluster; tests and lookups (images, flavors, networks) against the cloud                                                                                          |
| `infra-providers`  | [infra-providers](../apps/backend/src/infra-providers)                     | Credential plugins for OpenStack (`clouds.yaml`, Keystone/Nova/Neutron client) and AWS                                                                                                                |
| `clusters`         | [clusters](../apps/backend/src/clusters)                                   | Create, change, scale, label and delete workload clusters; status and resource tree; rollout controller; Calico manifest                                                                              |
| `helm`             | [helm](../apps/backend/src/helm)                                           | Helm repositories (`HelmRepository` CRs), chart browsing, add-ons as `HelmChartProxy`, CCM/CSI/kured presets                                                                                          |
| `dashboard`        | [dashboard](../apps/backend/src/dashboard)                                 | Read-only view into a workload cluster, polled while someone looks at it                                                                                                                              |
| `node-shell`       | [node-shell](../apps/backend/src/node-shell)                               | Root shell on a node through a temporary privileged pod, relayed over a WebSocket                                                                                                                     |
| `health`, `config` | [health](../apps/backend/src/health), [config](../apps/backend/src/config) | Liveness/readiness and health of connections; environment variables validated with Zod                                                                                                                |

## Where state lives

| State                              | Stored as                                                                                                                                                                                  | Where                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Custom roles                       | `NavigatorRole` CR                                                                                                                                                                         | Home cluster            |
| API tokens of technical users      | `NavigatorToken` CR with the SHA-256 hash of the token (never the token)                                                                                                                   | Home cluster            |
| Users and role assignments         | `NavigatorUser` CR, password hash in a Secret                                                                                                                                              | Home cluster            |
| Sessions                           | Signed cookie in the browser; the signing key is a Secret                                                                                                                                  | Home cluster (key only) |
| Management cluster connections     | `ManagementCluster` CR, kubeconfig or token in a Secret                                                                                                                                    | Home cluster            |
| Helm repositories                  | `HelmRepository` CR, OCI credentials in a Secret                                                                                                                                           | Home cluster            |
| Preset overrides (CCM, CSI, kured) | ConfigMap                                                                                                                                                                                  | Home cluster            |
| Audit log                          | `AuditEvent` CRs                                                                                                                                                                           | Home cluster            |
| Cloud credentials                  | Secret in the provider namespace (`capo-system`, `capa-system`) plus a cluster-scoped identity listing the allowed namespaces ([ADR-0002](adr/0002-cluster-scoped-provider-identities.md)) | Management cluster      |
| A workload cluster                 | **Cluster spec** as annotation `capi-navigator.io/cluster-spec` on the CAPI `Cluster`, plus the generated CAPI resources                                                                   | Management cluster      |
| Rollout and deletion progress      | Fields in the stored spec (`kubernetes.workerVersion`) and the annotation `capi-navigator.io/deletion`                                                                                     | Management cluster      |
| Add-ons                            | `HelmChartProxy` (the source of truth, [ADR-0011](adr/0011-helm-addons.md))                                                                                                                | Management cluster      |

Nothing is kept in the backend process beyond caches. Any replica can serve any request, and a
restarted pod continues where the previous one stopped. Background jobs (rollout controller,
audit cleanup) run on one replica at a time, elected with a `Lease`
([lease.ts](../apps/backend/src/kube/lease.ts)).

## Who does the work: resources and their controllers

| The app writes                                                                                         | In                 | Reconciled by                                | Result                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CoreProvider`, `BootstrapProvider`, `ControlPlaneProvider`, `InfrastructureProvider`, `AddonProvider` | Management cluster | CAPI Operator                                | Provider controllers and their CRDs are installed                                                                                                                                                                           |
| `Cluster`                                                                                              | Management cluster | CAPI core                                    | Ties infrastructure and control plane together, writes the kubeconfig Secret of the workload cluster                                                                                                                        |
| `OpenStackCluster` / `AWSCluster`                                                                      | Management cluster | CAPO / CAPA                                  | Network, security groups, API load balancer, optional bastion                                                                                                                                                               |
| `RKE2ControlPlane` / `K0sControlPlane` / `KubeadmControlPlane`                                         | Management cluster | Control plane provider                       | Control plane machines, their bootstrap data, version upgrades, rolling replacement                                                                                                                                         |
| `MachineDeployment`                                                                                    | Management cluster | CAPI core                                    | `MachineSet`s and `Machine`s per worker pool, rolling replacement                                                                                                                                                           |
| `OpenStackMachineTemplate` / `AWSMachineTemplate`                                                      | Management cluster | CAPO / CAPA (per machine)                    | VMs with the chosen size, image and disks                                                                                                                                                                                   |
| `RKE2ConfigTemplate` / `K0sWorkerConfigTemplate` / `KubeadmConfigTemplate`                             | Management cluster | Bootstrap provider (per machine)             | cloud-init user data that installs and joins Kubernetes                                                                                                                                                                     |
| `ClusterResourceSet` + Secret/ConfigMap                                                                | Management cluster | CAPI core                                    | Plain manifests applied into workload clusters: the OpenStack cloud config ([ADR-0004](adr/0004-node-provider-id-and-openstack-cloud-config.md)) and, for kubeadm, Calico ([ADR-0014](adr/0014-kubeadm-on-stock-images.md)) |
| `HelmChartProxy`                                                                                       | Management cluster | CAAPH                                        | One `HelmReleaseProxy` and one Helm release per matching workload cluster                                                                                                                                                   |
| Secret + identity (`OpenStackClusterIdentity`, `AWSClusterStaticIdentity`)                             | Management cluster | CAPO / CAPA (when a cluster references them) | Cloud API access for the provider                                                                                                                                                                                           |

## Pinned versions

Every version the app installs or offers (CAPI providers, cert-manager, the CAPI Operator, ORC,
Kubernetes versions per distribution, the preset charts, containerd, runc, Calico, the node shell
image) comes from [versions.yaml](../versions.yaml). `pnpm versions:generate` validates it with a Zod
schema and writes `packages/shared/src/versions.generated.ts`, which the catalogs and the
transformation import, so the app never reads the file at runtime and each app version is
reproducible. Node scripts such as the kubeadm install script are template files
(`packages/shared/src/cluster/templates`), likewise turned into modules. How to update them:
[maintenance.md](maintenance.md) ([ADR-0018](adr/0018-versions-yaml-and-update-report.md)).

## The cluster spec and the transformation

A workload cluster is described by a small typed **cluster spec**
([spec.ts](../packages/shared/src/cluster/spec.ts)): name, distribution and version, topology
(control plane replicas, worker pools), infrastructure (provider, credential, image, network),
add-ons and node customization. The function `transform(spec)`
([transform.ts](../packages/shared/src/cluster/transform.ts)) turns it into the complete list of
CAPI resources. It is pure: no I/O, no cluster access, and the same spec always gives
byte-identical YAML, which snapshot tests pin down.

Providers and distributions are plugins, so the core knows neither OpenStack nor RKE2:

| Plugin         | Interface                                                                                             | Implementations                                                                                                                                             | Contributes                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Infrastructure | `InfraTransformPlugin` ([plugins.ts](../packages/shared/src/cluster/plugins.ts))                      | [openstack.ts](../packages/shared/src/cluster/openstack.ts), [aws.ts](../packages/shared/src/cluster/aws.ts)                                                | Infrastructure cluster, machine templates, provider ID format, firewall rules from the distribution's network needs ([ADR-0012](adr/0012-flavor-network-requirements.md)) |
| Distribution   | `BootstrapFlavorPlugin` ([plugins.ts](../packages/shared/src/cluster/plugins.ts))                     | [rke2.ts](../packages/shared/src/cluster/rke2.ts), [k0s.ts](../packages/shared/src/cluster/k0s.ts), [kubeadm.ts](../packages/shared/src/cluster/kubeadm.ts) | Control plane, bootstrap templates, ports, whether it needs a CNI, how version upgrades run                                                                               |
| Credentials    | `CredentialPlugin` ([credential-plugin.ts](../apps/backend/src/infra-providers/credential-plugin.ts)) | OpenStack, AWS                                                                                                                                              | Storing, testing and cloud lookups for the wizard (backend only, it does I/O)                                                                                             |

The spec is stored on the `Cluster` itself. It is the source of truth for every later change.

## Main flows

### Live updates

Lists and status pages subscribe to server-sent events. The backend opens Kubernetes watches for
the relevant resources; any event triggers a debounced recomputation that is pushed to every
subscriber of that channel. Watches stop when nobody listens
([live-channels.ts](../apps/backend/src/kube/live-channels.ts)). Only the dashboard polls (every
15 s), because metrics cannot be watched ([ADR-0009](adr/0009-dashboard-polling.md)).

### Every request: permission check and audit

1. The global guard ([auth.guard.ts](../apps/backend/src/auth/auth.guard.ts)) verifies the
   session cookie and the permission the endpoint declares with `@Requires` (14 permissions,
   [permissions.ts](../packages/shared/src/permissions.ts)). It reads the user's role assignments
   and the roles from the cache on every request, so changes apply immediately, and checks them
   in the scope of the request: connection and namespace from the route, or the namespace in the
   body when something is created. Assignments limited to connections and namespaces restrict
   actions only; every user can read everything. The built-in roles viewer, operator and admin
   live in code; custom roles are `NavigatorRole` resources
   ([ADR-0015](adr/0015-permissions-and-scoped-role-assignments.md)). An endpoint without a rule
   is denied. The frontend runs the same check to hide buttons, which is cosmetic only.
   Scripts and pipelines authenticate with an **API token** of a technical user instead
   (`Authorization: Bearer capin_…`, [ADR-0017](adr/0017-api-tokens-for-technical-users.md)): the
   guard looks up the SHA-256 hash of the token in the cached `NavigatorToken` resources, checks
   expiry and the user, and continues with the role assignments of that user. A request with a
   token ignores the session cookie and needs no CSRF header; tokens never reach endpoints that need
   `users.manage` or the node shell.
2. The audit interceptor ([audit.interceptor.ts](../apps/backend/src/audit/audit.interceptor.ts))
   writes an `AuditEvent` with actor, action, target and outcome for every mutating request.
3. Kubernetes errors are translated into a message with a hint; the original stays expandable.

### Connecting a management cluster and installing providers

1. The admin adds a connection with a kubeconfig or a service account token (access manifests in
   [deploy/management-cluster](../deploy/management-cluster)). The app stores it in the home
   cluster and tests it. Every later call for that management cluster uses exactly these
   credentials ([management-cluster-clients.ts](../apps/backend/src/connections/management-cluster-clients.ts)).
2. The providers page checks cert-manager and the CAPI Operator and shows install commands if
   they are missing.
3. Installing a provider writes a provider CR of the CAPI Operator with the version from the
   catalog ([providers.ts](../packages/shared/src/catalog/providers.ts)), after a preview. The
   operator downloads the provider's components and installs them; the page follows the progress
   live.

### Creating a cluster

1. The wizard builds a cluster spec. Selection lists (images, sizes, networks) come from the cloud
   through the stored credential; the browser never sees the credential.
2. **Preview** (`POST …/clusters/preview`): the backend runs `transform(spec)`, adds the helper
   objects the cluster needs (cloud config, the add-on presets of its namespace, the Calico
   ClusterResourceSet for kubeadm), checks blockers (missing or unready providers and ORC, a credential that is missing, untested or not allowed in the namespace) and
   runs a server-side **dry run** of all objects. The user sees the YAML.
3. **Create** (`POST …/clusters`): the same plan is applied with server-side apply, field manager
   `capi-navigator` ([clusters.service.ts](../apps/backend/src/clusters/clusters.service.ts)).
4. From here on, the controllers take over. CAPO/CAPA create network and load balancer. The
   control plane provider creates the first machine, whose bootstrap data installs Kubernetes
   at first boot on the stock image. CAPI writes the kubeconfig Secret. Then the workers join.
5. The labels on the `Cluster` select the add-ons: CAAPH installs CCM and CSI (and kured, if
   chosen) as Helm releases into the new cluster; the ClusterResourceSets deliver the cloud config
   and, for kubeadm, Calico. Nodes become `Ready` once the CNI runs and the CCM has initialised
   them.

### Day-2 changes, drift and template rotation

Every change (machine size, image, scaling, pools, node customization, upgrade, bastion) works
the same way:

1. The form produces a change; the backend applies it to the **stored spec**, not to YAML.
2. `transform(newSpec)` generates the new objects and the backend diffs them against the live
   ones. Only changed objects are applied.
3. A dry-run server-side apply reveals fields that another field manager (e.g. `kubectl edit`)
   owns. These are shown as **drift**; the user must confirm taking them over, nothing is
   silently overwritten.
4. Changes that affect machines never edit an existing template: the transformation names
   templates after a hash of their content, so a change creates **new** templates and switches
   the references. CAPI then replaces machines one at a time (rolling update). The preview shows
   which groups will roll.
5. Only one rollout runs per cluster at a time; a second change is blocked until the first one
   has finished.

k0s is the exception for control plane versions: k0smotron upgrades them in place, and changes
that would replace k0s control plane machines are blocked
([ADR-0013](adr/0013-k0s-control-plane-replacement.md)).

### Kubernetes upgrades and the rollout controller

An upgrade must reach the control plane before the workers. The change sets the new
`kubernetes.version` and keeps the old one in `kubernetes.workerVersion`, so only the control
plane rolls. The **rollout controller**
([rollout-controller.service.ts](../apps/backend/src/clusters/rollout-controller.service.ts),
every 20 s, one replica via Lease) watches for the control plane to report the new version with
all replicas ready, then removes `workerVersion` through the normal change pipeline, and the
workers follow. When nothing rolls, it deletes templates that nothing references anymore
([ADR-0010](adr/0010-rollout-controller.md)).

### Helm add-ons

An add-on is a `HelmChartProxy` in one namespace of the management cluster with chart, version,
values and a **label selector**. Assigning an add-on to a cluster means adding the selector's
labels to the `Cluster`. CAAPH finds all clusters in the same namespace whose labels match and
creates one `HelmReleaseProxy` and one Helm release per cluster. The cluster's add-on tab shows
these releases. Presets (OpenStack CCM and Cinder CSI, AWS CCM and EBS CSI, kured) are add-ons the
app creates per namespace, selected by reserved labels that the transformation sets
([addons.ts](../packages/shared/src/cluster/addons.ts)). Admins can override their version and
values ([ADR-0011](adr/0011-helm-addons.md)).

### Deleting a cluster

Deleting the `Cluster` alone would leave cloud resources behind: load balancers and volumes that
the CCM and CSI created inside the workload cluster are unknown to CAPO/CAPA. With cleanup (the
default), the backend first deletes workloads, `LoadBalancer` services and PVCs in the workload
cluster while CCM and CSI still run, waits until the cloud resources are gone, and then deletes
the `Cluster`; CAPI cascades to machines and infrastructure. Progress is kept in an annotation on
the `Cluster` ([cluster-deletion.service.ts](../apps/backend/src/clusters/cluster-deletion.service.ts),
[ADR-0006](adr/0006-cluster-deletion-with-cleanup.md)).

### OpenAPI description and Swagger UI

The API description is generated from the code, not written by hand
([ADR-0016](adr/0016-openapi-from-zod-and-route-metadata.md),
[openapi.ts](../apps/backend/src/openapi/openapi.ts)). Nothing has to be kept in sync manually:

1. **Find the controllers.** `collectControllers(AppModule)` walks the static `@Module` metadata
   (`imports`, `controllers`) from the root module. No app instance is needed, so the same code
   runs in the backend, in tests and in `pnpm openapi:generate`.
2. **Read each route from its decorators.** For every handler method, NestJS has stored
   `@Get`/`@Post`/… (method and path), `@HttpCode` (status), `@Sse` (live updates), and our own
   `@Requires`/`@SignedIn`/`@Public` (access rule). The parameter decorators keep their pipes: a
   `@Body(new ZodValidationPipe(CreateUserRequestSchema))` tells the generator the request schema,
   a `@Query(new ZodValidationPipe(…))` the query parameters. These are the very schemas that
   validate the request, so the description cannot drift from the validation.
3. **Add what only the author knows.** `@Api({ summary, description, response })` on each
   endpoint gives a one-line summary and the response: a Zod schema from `packages/shared` for
   JSON, `liveEvents(schema)` for server-sent events, a content type for downloads, or `'empty'`.
   A test fails for any endpoint without it.
4. **Turn Zod into JSON Schema.** Zod 4's `z.toJSONSchema` (draft 2020-12, the dialect of OpenAPI
   3.1) converts the schemas. Every schema exported from `packages/shared` as `…Schema` is
   registered under its name, so it becomes a named component (`UserSchema` →
   `#/components/schemas/User`) and nested shared schemas become `$ref`s. Requests are converted
   as input (fields with defaults are optional), responses as output; where the two shapes differ,
   the input gets its own component (`…Input`).
5. **Assemble the document.** Paths use OpenAPI syntax (`:name` → `{name}`); each operation gets
   tag (controller), summary, the access rule in words plus `x-permission`, the CSRF header for
   mutating requests, the response and a common error body. `info.version` is the app version.
6. **Serve and commit it.** The backend renders the document once per process at
   `GET /api/openapi.json`. `pnpm openapi:generate` writes the same document to
   [docs/api/openapi.json](api/openapi.json) (with version `0.0.0-dev`), and a test fails when the
   committed file differs from what the code produces, so API changes show in pull requests.

Swagger UI under `/api/docs` is a small page of our own
([assets/swagger-ui](../apps/backend/assets/swagger-ui)) that loads the `swagger-ui-dist` files from
the same server, so the Content Security Policy stays `script-src 'self'`. "Try it out" sends
requests from the browser with its session cookie and the CSRF header; permissions, preview and
audit apply as for the app. Both paths are public and can be switched off (`API_DOCS_ENABLED`).

### Dashboard, node shell and kubeconfig

These are the only features that touch the workload cluster directly, always with the kubeconfig
Secret that CAPI maintains:

- **Dashboard**: read-only lists of nodes, workloads, services, ingresses, routes and metrics;
  never Secrets or ConfigMaps ([ADR-0009](adr/0009-dashboard-polling.md)).
- **Node shell**: a privileged pod on the chosen node, `nsenter` into the host, relayed over a
  WebSocket; deleted when the session ends ([ADR-0008](adr/0008-node-shell-via-privileged-pod.md)).
- **Kubeconfig**: view and download for operators, every access audited
  ([ADR-0005](adr/0005-workload-kubeconfig-view-and-download.md)).

## Security boundaries

- Only the backend talks to Kubernetes. The browser gets display data, never credentials;
  Secret values in previews are masked.
- Permissions are enforced in the backend for every endpoint and for the node shell WebSocket.
- Each management cluster is accessed with the credentials of its connection only; the minimal
  access manifest limits what the app can do there.
- Sessions are signed cookies (Secure, HttpOnly) with a fixed lifetime; sign-in is rate-limited.
- The app sets no owner references or finalizers on CAPI resources and uses only labels and
  annotations under `capi-navigator.io/`, so uninstalling it leaves the clusters intact.

## Further reading

- [requirements.md](requirements.md): goals, feature packs, non-functional requirements.
- [adr/](adr/README.md): decisions that refine or deviate from the requirements.
- [README](../README.md): installation, configuration locations, development commands.
