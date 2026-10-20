# CAPI Navigator – Requirements Specification

Oct 16, 2026 · @Daniel Quilitzsch

## 1. About this document

This document specifies **CAPI Navigator**, a web application that simplifies installing, configuring and using Cluster API through a graphical interface.

**Audience:** software developers, DevOps engineers and site reliability engineers, as well as AI coding agents such as Claude Code. Every feature pack is therefore self-contained, has a unique ID and testable acceptance criteria.

**How to read this document:**

- Requirements carry IDs in the format `FP<n>-<type>-<no>`, e.g. `FP2-F-03` (F = functional, NF = non-functional).
- **MUST** = mandatory for the feature pack, **SHOULD** = strongly recommended, **MAY** = optional.
- Feature packs are implemented strictly in order, starting with FP-0. A pack is done only when all MUST acceptance criteria are met.

### Glossary

| Term | Meaning |
| --- | --- |
| CAPI | Cluster API, the Kubernetes project for declarative cluster lifecycle management |
| Home cluster | Kubernetes cluster in which CAPI Navigator runs and stores all of its own state (CRDs, Secrets, ConfigMaps); often the same as the management cluster |
| Management cluster | Kubernetes cluster that runs CAPI and its providers and manages workload clusters |
| Workload cluster | Kubernetes cluster created and managed by CAPI |
| CAPI Operator | Cluster API Operator, manages CAPI providers declaratively through its own CRDs |
| Core provider | CAPI core components (`CoreProvider` CR) |
| Infrastructure provider | Provider for the infrastructure, e.g. CAPO (OpenStack), CAPA (AWS) |
| ORC | OpenStack Resource Controller, a prerequisite of current CAPO versions |
| Bootstrap provider | Generates the bootstrap configuration for nodes, e.g. kubeadm, RKE2, k0s |
| Control plane provider | Manages the control plane of a workload cluster, e.g. KubeadmControlPlane, RKE2ControlPlane, K0sControlPlane |
| k0smotron | Project providing the CAPI bootstrap and control plane providers for k0s |
| Add-on provider | Installs add-ons into workload clusters; here CAAPH (Cluster API Add-on Provider for Helm) |
| CCM / CSI | OpenStack Cloud Controller Manager and Cinder CSI driver, installed into workload clusters |
| Worker pool | A group of identical worker nodes, implemented as one `MachineDeployment` |
| Template rotation | Changing nodes by creating a new machine or bootstrap template and switching the reference, which makes CAPI replace the nodes in a rolling update |
| Node customization | Extra cloud-init configuration per control plane or worker pool: files and commands before or after the Kubernetes installation |
| ClusterClass | CAPI template for reusable cluster topologies |
| Cluster spec | The simplified, typed input model of this app (see section 5) |
| cloud-init | Standard for initial configuration of VMs at first boot |

## 2. Background and goals

Cluster API is the de facto standard for lifecycle management of Kubernetes clusters on infrastructure clouds, but its modularity makes it hard to get started. CAPI Navigator makes the key workflows visible and usable through forms, instead of doing everything with YAML and `kubectl`.

### Positioning

CAPI Navigator is a showcase and entry point for Cluster API, not a competitor to commercial platforms such as Rancher. It helps DevOps engineers and SREs understand how Cluster API works, and it is a practical option for small cluster fleets.

Because everything it creates is standard Cluster API, clusters stay open to other tools: `kubectl`, `clusterctl`, and future CAPI-aware platforms (e.g. Rancher with its CAPI integration) can read and manage them.

- **POS-01** MUST create only standard upstream resources (CAPI, CAPO, RKE2 provider, CAAPH) for workload clusters. The app's own CRDs hold app state only and are never needed for a cluster to run.
- **POS-02** MUST NOT set owner references or finalizers from its own resources on CAPI resources, so the app can be uninstalled without affecting any cluster.
- **POS-03** MUST use only neutral, documented labels and annotations (`capi-navigator.io/...`) that other tools can ignore.
- **POS-04** SHOULD show for every form field which CAPI resource and field it maps to, with a link to the official documentation (“learn mode”).
- **POS-05** SHOULD document how to continue managing clusters without the app, e.g. with `clusterctl` or by moving them to another management cluster (`clusterctl move`).
- **POS-06** Target size: small fleets of up to about 50 workload clusters per management cluster (see NF-12).

### Problem

- CAPI consists of many components (core, infrastructure, bootstrap, control plane and add-on providers), and how they interact is hard to grasp.
- Even managing providers through the CAPI Operator CRDs is tedious via the plain Kubernetes API.
- The CAPI manifests for a single cluster are large, provider-specific and error-prone.
- Vanilla Kubernetes with kubeadm requires prebuilt OS images (Image Builder), which is laborious and inflexible.
- Rolling out add-ons such as CNI, CSI or ingress to many workload clusters needs extra tooling.

### Goals

1. **Provider management via UI:** check whether the CAPI Operator is installed on a management cluster, and install, configure, upgrade and remove official providers through it.
2. **Cluster creation via forms:** create a standard workload cluster (control plane and worker pools, or a single all-in-one node) on VMs in a dedicated virtual network, starting with OpenStack on Infomaniak Public Cloud and Amazon Web Services (AWS).
3. **Standard OS images:** Kubernetes is installed via cloud-init on official cloud images, with RKE2 or k0s. Prebuilt Kubernetes images are not required.
4. **Ready-to-use clusters:** OpenStack Cloud Controller Manager and Cinder CSI are rolled out with each cluster and can be deselected.
5. **Day-2 operations with rolling updates:** Kubernetes version upgrades, scaling, flavor changes and node rebuilds from new cloud images. Nodes are replaced instead of patched, so no OS patch management is needed.
6. **Abstraction instead of YAML:** a simplified, typed cluster model is translated automatically into valid CAPI manifests.
7. **Transparent YAML:** every resource the app shows can be viewed live as YAML (read-only), similar to the Rancher UI. Changes go through forms that update the cluster spec.
8. **Helm add-ons:** Helm charts are managed centrally and assigned to workload clusters via the Cluster API Add-on Provider for Helm (CAAPH).
9. **No separate datastore:** all app state lives in Kubernetes (CRDs, Secrets, ConfigMaps), the way Rancher does it.
10. **Extensibility:** further infrastructure providers (e.g. Azure, GCP) and Kubernetes distributions can be added as modules without changing the core.
11. **Secure access:** local user accounts with roles from day one; an external identity provider may follow later.

### Non-goals (for now)

- Competing with commercial platforms such as Rancher (multi-tenancy, enterprise features, support)
- Control plane hosting such as Kamaji or hosted control planes
- Full coverage of all CAPI providers and all configuration options
- General workload management inside workload clusters (deployments, pods); only Helm add-ons are in scope
- Building OS images
- Multi-tenant billing or cost management

## 3. Roles and user stories

The app has three built-in roles. The permissions apply across all feature packs. Since FP-19, admins can also define their own roles from a fixed set of permissions and assign roles per management cluster connection and namespace.

| Role | Can |
| --- | --- |
| Viewer | View management clusters, providers, workload clusters and Helm add-ons; read status and YAML |
| Operator | Additionally create, scale and delete workload clusters; assign Helm add-ons; run day-2 operations (scaling, flavor, upgrades, rebuilds, node customization) |
| Admin | Additionally connect management clusters; install, configure and remove providers; manage Helm repositories, users and roles |

### User stories

- **US-01** As an admin, I want to register an existing Kubernetes cluster as a management cluster via kubeconfig or service account token so the app can work with it.
- **US-02** As an admin, I want to see at a glance whether the CAPI Operator and cert-manager are installed, and in which version.
- **US-03** As an admin, I want to pick official providers from a list, set version and configuration, and install them with one click.
- **US-04** As an admin, I want to store credentials for an infrastructure provider (e.g. OpenStack `clouds.yaml`) securely.
- **US-05** As an operator, I want to create a workload cluster through a guided wizard with only a few required fields, choosing RKE2 or k0s.
- **US-06** As an operator, I want to preview the generated CAPI manifests as YAML before applying them, and download them.
- **US-07** As an operator, I want to follow cluster creation in a live status view (cluster, machines, conditions).
- **US-08** As an operator, I want to download the kubeconfig of a ready workload cluster.
- **US-09** As an operator, I want to scale worker pools and delete a cluster.
- **US-10** As a viewer, I want a graphical overview of which providers are installed and which clusters use them.
- **US-11** As an operator, I want to open the live YAML of any resource shown in the app, and change safe values such as replicas and flavor through a form.
- **US-12** As an admin, I want to add Helm repositories and define Helm charts with default values.
- **US-13** As an operator, I want to assign a Helm chart to one or more workload clusters by label, override values, and see the release status per cluster.
- **US-14** As an operator, I want to upgrade the Kubernetes version of a cluster with a rolling update.
- **US-15** As an operator, I want to rebuild the nodes of a cluster from a new cloud image, so I do not need OS patch management.
- **US-16** As an operator, I want to add extra cloud-init configuration (files, commands) per control plane or worker pool.

## 4. Architecture and tech stack

CAPI Navigator is a single-page app (Vue 3) with a NestJS backend that is the only component talking directly to the Kubernetes API of the management clusters. The browser never has direct access to clusters or credentials.

&#91;embedded content: Architecture · browser, backend, management cluster, OpenStack\]

The browser calls only the backend (REST and server-sent events). The backend translates the cluster spec into manifests and talks to the management cluster via the Kubernetes API; there, CAPI, CAPO with ORC and CAAPH create the resources in OpenStack and the Helm releases (including CCM and CSI) in the workload clusters. The app's own state lives in the home cluster as CRDs and Secrets.

### Tech stack

| Area | Technology | Note |
| --- | --- | --- |
| Language | TypeScript (strict) in Backend, Frontend and shared package | Recommended over JavaScript: typing the cluster model is the core of the app, and NestJS is TypeScript-first |
| Backend | NestJS (current LTS), Node.js 24 LTS | One module per feature pack |
| Kubernetes client | `@kubernetes/client-node` | Official client maintained by Kubernetes SIG API Machinery |
| Validation | Zod, shared by backend and frontend | One schema source for types, form and API validation |
| Persistence | None: Kubernetes API of the home cluster (CRDs, Secrets, ConfigMaps) | No database, like Rancher; see “State storage” below |
| Frontend | Vue 3 (Composition API, `<script setup>`), Vite |  |
| State | Pinia | One store per domain (auth, connections, providers, clusters, addons) |
| Routing | Vue Router | Routes with role guards |
| UI | Vuetify 3 | Light/dark theme, form components, steppers for wizards |
| YAML editor | Monaco Editor with `monaco-yaml` | Read-only YAML view with syntax highlighting; also used for Helm values in FP-8 |
| YAML | `yaml` (npm) | Generating and rendering manifests |
| Live status | Server-sent events fed by Kubernetes watches | Simpler than WebSockets, sufficient for status views |
| Tests | Vitest (unit), Playwright (E2E), kind (integration) |  |

Vue 3, Pinia, Vue Router and Vuetify fit the goal of a lean stack well: little configuration, a clear component structure, and ready-made form and stepper components.

### Repository layout (monorepo with pnpm workspaces)

```
capi-navigator/
├── apps/
│   ├── backend/          # NestJS
│   │   └── src/
│   │       ├── auth/             # FP-1: local users, sessions, roles
│   │       ├── store/            # typed access to own CRDs, Secrets, ConfigMaps
│   │       ├── connections/      # FP-2: management clusters
│   │       ├── operator/         # FP-3: CAPI Operator, ORC and providers
│   │       ├── credentials/      # FP-4: provider credentials
│   │       ├── clusters/         # FP-5/6: workload clusters, generic
│   │       ├── infra-providers/
│   │       │   ├── openstack/    # FP-5: OpenStack plugin
│   │       │   └── aws/          # FP-5: AWS plugin
│   │       ├── resources/        # FP-7: YAML view, safe edits
│   │       ├── addons/           # FP-5/8: Helm add-ons (CAAPH), CCM/CSI presets
│   │       └── kube/             # Kubernetes client factory, informers, watches
│   └── frontend/         # Vue 3 + Vuetify
│       └── src/{views,components,stores,router,api}
├── packages/
│   └── shared/           # Zod schemas, types, provider catalog
├── deploy/
│   ├── crds/             # CRDs of CAPI Navigator
│   └── helm/capi-navigator/
└── docs/
```

### State storage (no separate datastore)

CAPI Navigator keeps no database. All of its own state lives in the home cluster as Kubernetes resources in a dedicated namespace (default `capi-navigator-system`), under its own API group `navigator.capi-navigator.io/v1alpha1`.

| Data | Stored as | Sensitive parts |
| --- | --- | --- |
| Users and roles | `NavigatorUser` CR (username, role, disabled flag) | Password hash (bcrypt or argon2) in a Secret |
| Management cluster connections | `ManagementCluster` CR (name, API server URL, auth type, status) | kubeconfig or service account token + CA in a Secret |
| Helm repositories | `HelmRepository` CR (name, URL, type HTTP/OCI) | Repository credentials in a Secret |
| Add-on presets (CCM, CSI) | ConfigMap with default chart, version and values | – |
| App settings | ConfigMap `capi-navigator-settings` | Session signing key in a Secret |
| Audit log | `AuditEvent` CR with retention (default 90 days, cleaned up by the backend) | – |
| Cluster spec | Annotation on the CAPI `Cluster` object in the management cluster | – |
| Provider credentials | Secret in the management cluster, in the format the provider expects | All |

- **STATE-01** MUST access all state only through the Kubernetes API; no local files or databases.
- **STATE-02** MUST ship the CRDs with OpenAPI schemas generated from the Zod schemas in `packages/shared`.
- **STATE-03** MUST use informers (cached watches) for reading, so the UI does not query the API server on every request.
- **STATE-04** MUST keep the backend stateless so it can run with more than one replica; sessions are signed cookies, not server-side sessions.
- **STATE-05** SHOULD rely on Kubernetes encryption at rest for Secrets and document how to enable it.

### Operations

- **MUST** ship as a single container image (the backend serves the built frontend statically).
- **SHOULD** publish each release from a version tag: the image `ghcr.io/<owner>/capi-navigator:<version>` and the packaged Helm chart as a GitHub release asset, with chart version and app version equal to the tag.
- **MUST** run locally with `pnpm dev` and a kind cluster as home and management cluster; the backend uses `KUBECONFIG` for the home cluster.
- **MUST** be installable into a Kubernetes cluster via Helm chart, including CRDs, RBAC and the in-cluster service account as home cluster access.
- **MUST** let the Helm chart expose the app through a Service of type `ClusterIP`, `NodePort` or `LoadBalancer` (with annotations and load balancer settings), an optional Ingress and an optional Gateway API `HTTPRoute`, alone or combined. When an Ingress or HTTPRoute is enabled, the app trusts `X-Forwarded-For` from private proxy addresses by default; the Secure cookie flag can be disabled only explicitly for plain-HTTP test setups.
- **MUST** take configuration exclusively from environment variables and the settings ConfigMap (12-factor).

## 5. Abstraction layer: cluster spec and transformation

The user describes a cluster with a small, typed **cluster spec**; pure functions translate it deterministically into complete CAPI manifests. This is the central design principle of the app.

### Principles

- **Single source of truth:** the cluster spec is defined as a Zod schema in `packages/shared`. TypeScript types, frontend form validation and backend API validation are all derived from it.
- **Generic part + provider part:** the spec consists of a provider-independent core and a provider-specific block (`infrastructure`), typed as a discriminated union on `provider`.
- **Pure transformation:** `transform(spec) → KubernetesObject[]` has no side effects and no cluster access. The same input yields byte-identical YAML, which makes it testable with snapshot tests.
- **Sensible defaults:** only a few fields are required; everything else has documented defaults.
- **Preview before apply:** generated manifests are always shown first and applied via server-side apply only after confirmation.
- **The spec stays the source of truth:** the app never edits YAML directly. Day-2 changes (replicas, flavor) go through forms that update the stored spec first (FP-7). Changes made outside the app are detected and shown as drift, never silently overwritten.

### Cluster spec (draft)

```typescript
// packages/shared/src/cluster-spec.ts (simplified)
type NodeCustomization = {
  files?: { path: string; content: string; permissions?: string; owner?: string }[];
  preCommands?: string[];       // before Kubernetes install (RKE2: preRKE2Commands, k0s: preStartCommands)
  postCommands?: string[];      // after Kubernetes install (RKE2: postRKE2Commands, k0s: postStartCommands)
};

type MachineGroup = {
  machineSize: string;          // flavor
  image?: string;               // overrides infrastructure.image for this group
  customization?: NodeCustomization;
};

type ClusterSpec = {
  name: string;                 // DNS-1123, max. 40 characters
  namespace: string;            // default: "default"
  labels?: Record<string, string>;  // set on the Cluster; used to assign Helm add-ons (FP-8)
  kubernetes: {
    flavor: "rke2" | "k0s" | "kubeadm";     // k0s from FP-9, kubeadm from FP-10
    version: string;            // e.g. "v1.31.4+rke2r1" or "v1.31.4+k0s.0"
    podCidr: string;            // default: "10.42.0.0/16"
    serviceCidr: string;        // default: "10.43.0.0/16"
  };
  topology: {
    mode: "standard" | "all-in-one";
    controlPlane: MachineGroup & { replicas: 1 | 3 | 5 };
    workerPools: (MachineGroup & {
      name: string;             // e.g. "default", "gpu"
      replicas: number;
      nodeLabels?: Record<string, string>;
    })[];                        // empty for all-in-one
  };
  rollout?: {
    rebuildRequestedAt?: string;  // ISO timestamp; changing it rebuilds all nodes (FP-7)
    maxSurge?: number;            // workers, default 1
    maxUnavailable?: number;      // workers, default 0
  };
  addons: {
    cloudControllerManager: boolean;  // default: true (OpenStack CCM)
    csiDriver: boolean;               // default: true (Cinder CSI)
  };
  sshPublicKeys?: string[];
  infrastructure: OpenStackInfra | AwsInfra;   // discriminated union on `provider`
};

type OpenStackInfra = {
  provider: "openstack";
  credentialRef: string;        // reference to stored clouds.yaml credentials (FP-4)
  image: string;                // default standard cloud image, e.g. Ubuntu 24.04
  externalNetwork: string;      // for router and floating IP
  network: { nodeCidr: string; dnsNameservers: string[] };  // dedicated network per cluster
  apiServerLoadBalancer: boolean;  // Octavia, default: true
  failureDomain?: string;       // availability zone
  sshKeyName?: string;
};

type AwsInfra = {
  provider: "aws";
  credentialRef: string;        // reference to stored AWS credentials = AWSClusterStaticIdentity (FP-4)
  region: string;               // e.g. "eu-central-1"
  image?: string;               // AMI ID; default: official Canonical Ubuntu 24.04 AMI of the region
  network: { vpcCidr: string; availabilityZones?: string[] };  // dedicated VPC per cluster, managed by CAPA
  apiServerLoadBalancer: boolean;  // AWS load balancer for the API server, default: true
  sshKeyName?: string;          // EC2 key pair
};
```

### Transformation (example: OpenStack + RKE2)

| Part of the spec | Generated CAPI resources |
| --- | --- |
| `name`, `namespace`, `labels`, CIDRs | `Cluster` (cluster.x-k8s.io) referencing infrastructure and control plane |
| `infrastructure.*` | `OpenStackCluster` with network, subnet, router, security groups, API load balancer, `identityRef` |
| `topology.controlPlane` + `kubernetes` | RKE2: `RKE2ControlPlane`; k0s: `K0sControlPlane`; plus `OpenStackMachineTemplate` for control plane nodes |
| `topology.workerPools[]` + `kubernetes` | Per pool: `MachineDeployment` + bootstrap template (RKE2: `RKE2ConfigTemplate`, k0s: `K0sWorkerConfigTemplate`) + `OpenStackMachineTemplate` |
| `machineSize`, `image` per group | Fields of that group's `OpenStackMachineTemplate`; a change creates a new template (template rotation) |
| `customization` per group | `files` and pre/post commands of that group's bootstrap config; a change creates a new bootstrap template |
| `kubernetes.version` | Version field of control plane and `MachineDeployments`; CAPI rolls out control plane first, then workers |
| `rollout.rebuildRequestedAt` | `rolloutAfter` where the provider supports it, otherwise template rotation with unchanged content |
| `addons.cloudControllerManager` | Kubernetes configured for an external cloud provider + add-on label on the `Cluster`, matched by the CCM preset `HelmChartProxy` |
| `addons.csiDriver` | Add-on label on the `Cluster`, matched by the Cinder CSI preset `HelmChartProxy` |
| `sshPublicKeys` | cloud-init user data in the bootstrap config |
| `credentialRef` | Reference to a secret containing `clouds.yaml` in the cluster's namespace; CCM and CSI receive a cloud config derived from it |

With `mode: "all-in-one"`, no `MachineDeployment` and no worker templates are generated; control plane nodes stay schedulable for workloads.

### Transformation (AWS + RKE2)

The generic part (`Cluster`, control plane, `MachineDeployments`, bootstrap templates, add-on labels) is the same as for OpenStack; the AWS plugin replaces the infrastructure part. Exact CAPA field names are verified against the CAPA CRDs in FP-5.

| Part of the spec | Generated CAPI resources |
| --- | --- |
| `infrastructure.*` | `AWSCluster` with region, dedicated VPC and subnets, API server load balancer, `identityRef` to the `AWSClusterStaticIdentity` |
| `topology.*` groups | `AWSMachineTemplate` per group: instance type (`machineSize`), AMI, IAM instance profile created by the CAPA IAM prerequisites, SSH key |
| `addons.cloudControllerManager` | External cloud provider + add-on label matched by the AWS cloud controller manager preset `HelmChartProxy` |
| `addons.csiDriver` | Add-on label matched by the AWS EBS CSI driver preset `HelmChartProxy` |
| `credentialRef` | `identityRef` of the `AWSCluster`; the identity's `allowedNamespaces` includes the cluster's namespace |

### Provider plugin interface

Each infrastructure provider is a plugin implementing this interface. New providers (AWS etc.) require no changes to the core.

```typescript
interface InfraProviderPlugin<TInfra> {
  id: string;                          // "openstack"
  capiProviderName: string;            // name in the CAPI Operator, e.g. "openstack"
  infraSchema: ZodType<TInfra>;        // form + validation
  credentialSchema: ZodType<unknown>;  // e.g. clouds.yaml fields
  lookups?: Record<string, (cred) => Promise<Option[]>>;  // images, flavors, networks for dropdowns
  transformInfra(spec: ClusterSpec): KubernetesObject[];
  machineTemplate(role: "control-plane" | "worker", spec: ClusterSpec): KubernetesObject;
}
```

Kubernetes distributions are likewise interchangeable through an analogous `BootstrapFlavorPlugin` interface: RKE2 in FP-5, k0s in FP-9, kubeadm in FP-10. Each plugin maps `NodeCustomization`, version and rollout settings to its own bootstrap and control plane resources.

## 6. Feature packs

Implementation proceeds in eleven core feature packs (FP-0 to FP-10) that build on each other, plus optional packs (FP-17 to FP-20, FP-22, FP-23) specified below; further ideas are in the outlook (section 8). Each pack ends in a working, tested state.

| Pack | Content | Depends on |
| --- | --- | --- |
| FP-0 | Project scaffold | – |
| FP-1 | Authentication and authorization | FP-0 |
| FP-2 | Management cluster connections | FP-1 |
| FP-3 | CAPI Operator and provider management | FP-2 |
| FP-4 | Infrastructure provider credentials (OpenStack, AWS) | FP-3 |
| FP-5 | Create workload clusters: OpenStack and AWS + RKE2 | FP-4 |
| FP-6 | Cluster lifecycle and visualization | FP-5 |
| FP-7 | Live YAML view and day-2 operations | FP-6 |
| FP-8 | Helm add-ons via CAAPH | FP-7 |
| FP-9 | k0s as second Kubernetes distribution | FP-7 |
| FP-10 | Vanilla Kubernetes with kubeadm on stock images (experimental) | FP-8 |
| FP-19 | Role management: custom roles and scoped role assignments (optional) | FP-1 |
| FP-20 | Version maintenance: versions.yaml and update report (optional) | FP-10 |
| FP-22 | API tokens for technical users (optional) | FP-19, FP-23 |
| FP-23 | OpenAPI description and Swagger UI (optional) | FP-19 |

### FP-0: Project scaffold

**Goal:** an empty but fully wired monorepo on which all further packs build.

- **FP0-F-01** MUST set up the monorepo as described in section 4 with pnpm workspaces (`apps/backend`, `apps/frontend`, `packages/shared`).
- **FP0-F-02** MUST configure TypeScript strict, ESLint and Prettier consistently.
- **FP0-F-03** MUST provide a backend endpoint `GET /api/health`; the frontend shows a Vuetify layout with navigation and calls it.
- **FP0-F-04** MUST provide a multi-stage Dockerfile that builds a single image.
- **FP0-F-05** MUST include a CI pipeline (e.g. GitHub Actions) for lint, typecheck, tests and image build.
- **FP0-F-06** SHOULD ship a script for a local kind cluster acting as management cluster.

**Acceptance criteria**

- [x] `pnpm install && pnpm dev` starts backend and frontend; the start page shows “Backend: OK”.
- [x] `pnpm test` and `pnpm lint` run without errors.
- [x] `docker build` produces a working image.

### FP-1: Authentication and authorization

**Goal:** only signed-in users can use the app, and every action is checked against a role.

- **FP1-F-01** MUST provide local user accounts stored as `NavigatorUser` resources with password hashes in Secrets (see “State storage”). No external identity provider in this pack.
- **FP1-F-02** MUST create an initial admin on first start from a Secret or environment variable, and force a password change on first login.
- **FP1-F-03** MUST keep sessions in signed, HttpOnly, Secure, SameSite cookies (key from a Secret); no tokens in local storage and no server-side session store.
- **FP1-F-04** MUST enforce the viewer, operator and admin roles (section 3) on every endpoint via a NestJS guard.
- **FP1-F-05** MUST let admins create, disable and delete users, assign roles and reset passwords in the UI.
- **FP1-F-06** MUST keep an audit log of all mutating actions as `AuditEvent` resources (who, what, when, on which cluster).
- **FP1-F-07** MUST show or hide routes and controls in the frontend by role; enforcement always happens in the backend.
- **FP1-F-08** SHOULD isolate authentication behind an interface so that OIDC can be added later without changing the guards.

**Acceptance criteria**

- [x] Unauthenticated calls to `/api/*` (except health and login) return 401.
- [x] A viewer receives 403 on mutating endpoints.
- [x] The initial admin can log in, change the password, and create a viewer and an operator.
- [x] After a backend restart, users and sessions still work (state only in the home cluster).
- [x] Every mutating action creates an `AuditEvent`.

### FP-2: Management cluster connections

**Goal:** admins register one or more management clusters for the app to work with.

- **FP2-F-01** MUST create, edit and delete connections by either kubeconfig (upload or input) or service account token (API server URL, token, CA certificate).
- **FP2-F-02** MUST store each connection as a `ManagementCluster` resource with its credentials in a Secret in the home cluster, and never return credentials to the frontend.
- **FP2-F-03** MUST offer the home cluster itself as a connection (in-cluster service account), so a single cluster can act as home and management cluster.
- **FP2-F-04** MUST test a connection: reachability, Kubernetes version, permissions (via `SelfSubjectAccessReview`), and store the result in the resource status.
- **FP2-F-05** MUST make the active connection globally selectable in the frontend (Pinia store, visible in the app bar).
- **FP2-F-06** MUST explain missing permissions clearly instead of showing raw API errors.
- **FP2-F-07** SHOULD provide a ready-made ServiceAccount, ClusterRole and token Secret manifest for preparing a management cluster.

**Acceptance criteria**

- [x] A kind cluster can be added via kubeconfig and via service account token; the test shows version and status “reachable”.
- [x] Credentials exist only as Secrets in the home cluster and never appear in API responses.
- [x] An invalid kubeconfig or token produces a clear error message.

### FP-3: CAPI Operator and provider management

**Goal:** admins see the state of CAPI on a management cluster and install and configure official providers through the CAPI Operator.

**Detection**

- **FP3-F-01** MUST check whether cert-manager is installed and ready (a prerequisite of the operator).
- **FP3-F-02** MUST check whether the CAPI Operator is installed (CRDs of the `operator.cluster.x-k8s.io` API group and a running deployment) and show its version.
- **FP3-F-03** MUST show clear instructions with installation commands (Helm) if the operator or cert-manager is missing.
- **FP3-F-04** MAY install the operator and cert-manager directly from the app via Helm (separate follow-up pack if complex).
- **FP3-F-04a** MUST check whether the OpenStack Resource Controller (ORC) is installed and ready, since CAPO requires it. If missing, MUST offer to install it from its official release manifest before CAPO is installed, and show the ORC version compatible with the selected CAPO version.

**Provider catalog**

- **FP3-F-05** MUST maintain a provider catalog in `packages/shared`: name, type (core, infrastructure, bootstrap, control plane, add-on), description, recommended version, `fetchConfig` URL where needed, dependencies.
- **FP3-F-06** MUST include at least: core (cluster-api), kubeadm bootstrap and control plane, RKE2 bootstrap and control plane, OpenStack infrastructure, Helm add-on provider (CAAPH, as `AddonProvider`). AWS infrastructure (CAPA) MUST be installable as well, as it is needed by FP-4 and FP-5. The k0smotron bootstrap and control plane providers (k0s) MUST be added by FP-9.
- **FP3-F-07** SHOULD load available versions from the GitHub releases of each provider.
- **FP3-F-07a** MUST maintain a version catalog per Kubernetes distribution (available RKE2 and k0s versions and which provider versions support them), used by the wizard and by upgrades in FP-7.

**Installation and configuration**

- **FP3-F-08** MUST list installed providers: type, name, namespace, version, status conditions.
- **FP3-F-09** MUST install providers through a dialog: version, namespace, optional configuration variables (as `configSecret`) and feature flags (`manager.featureGates`).
- **FP3-F-10** MUST show the generated provider manifest (e.g. `InfrastructureProvider`) as a YAML preview before applying.
- **FP3-F-11** MUST ensure the core provider is installed before other providers and show dependencies in the dialog.
- **FP3-F-12** MUST change provider version and configuration (upgrade) and remove providers; removal requires confirmation and warns if clusters still use the provider.
- **FP3-F-13** MUST show installation progress live (watch on the provider CRs).

**Acceptance criteria**

- [x] On a kind cluster with cert-manager and CAPI Operator, ORC, core, RKE2 bootstrap, RKE2 control plane, OpenStack and CAAPH can be installed via the UI.
- [x] The AWS infrastructure provider (CAPA) can be installed via the UI.
- [x] Installing CAPO without ORC is blocked with a hint to install ORC first.
- [x] All providers and ORC reach the Ready state and are shown as such.
- [x] A provider version upgrade via the UI is carried out by the operator.
- [x] Without an installed operator, the installation instructions appear instead of an error.

### FP-4: Infrastructure provider credentials (OpenStack, AWS)

**Goal:** OpenStack and AWS credentials are stored securely once and only referenced by clusters.

**OpenStack**

- **FP4-F-01** MUST capture OpenStack credentials via `clouds.yaml` upload or a form (auth URL, region, project, domain, application credential ID and secret).
- **FP4-F-02** SHOULD prefer application credentials over username and password, and recommend them in the form.
- **FP4-F-03** MUST store credentials as a Kubernetes secret in the target namespace of the management cluster, in the format CAPO expects (key `clouds.yaml`, optionally `cacert`). Refined by ADR-0002: one Secret in the CAPO namespace plus an `OpenStackClusterIdentity` that lists the allowed namespaces.
- **FP4-F-04** MUST test the credentials (obtain a token, read the project) and show the result.
- **FP4-F-05** MUST use the credentials to populate selection lists for cluster creation: images, flavors, external networks, availability zones, SSH key pairs.
- **FP4-F-06** MUST never return secret contents to the frontend in plain text after saving.

**AWS**

- **FP4-F-07** MUST capture AWS credentials of a dedicated IAM user (access key ID and secret access key) plus a default region via a form, and recommend a dedicated IAM user with only the CAPA permissions instead of personal or root credentials.
- **FP4-F-08** MUST store the access key in a Secret in the format CAPA expects and create an `AWSClusterStaticIdentity` that references it; `allowedNamespaces` lists the namespaces that may use the credentials.
- **FP4-F-09** MUST test the credentials (identity of the caller) and check that the IAM prerequisites of CAPA (roles, policies and instance profiles as created by `clusterawsadm bootstrap iam create-cloudformation-stack`) exist. If they are missing, MUST show the `clusterawsadm` command instead of creating IAM resources itself.
- **FP4-F-10** MUST use the AWS credentials to populate selection lists for cluster creation: regions, availability zones, instance types, the official OS AMIs of the region (Ubuntu LTS as default; Rocky Linux and Debian from their publishers' accounts, with the RKE2 support level), and EC2 key pairs.
- **FP4-F-06** applies to AWS credentials as well.

**Acceptance criteria**

- [x] Against Infomaniak Public Cloud, credentials from a downloaded clouds.yaml can be created and tested successfully.
- [x] Images, flavors and external networks appear as selection lists.
- [x] The secret exists in the management cluster and is accepted by CAPO.
- [x] AWS credentials of an IAM user can be created and tested; missing CAPA IAM prerequisites are reported with the `clusterawsadm` command.
- [x] Regions, instance types, Ubuntu AMIs and key pairs appear as selection lists.
- [x] The `AWSClusterStaticIdentity` and its Secret exist in the management cluster and are accepted by CAPA.

### FP-5: Create workload clusters (OpenStack and AWS + RKE2)

**Goal:** an operator creates a standard Kubernetes cluster on OpenStack or AWS through a wizard, without writing YAML and without prebuilt Kubernetes images.

**Wizard (Vuetify stepper)**

1. **Basics:** name, namespace, labels, Kubernetes distribution (RKE2; k0s from FP-9; kubeadm, experimental, from FP-10) and version.
2. **Topology:** standard (control plane with 1, 3 or 5 nodes + one or more worker pools) or all-in-one (1 node); per group: replicas, machine size, optional image override.
3. **Infrastructure:** provider (OpenStack or AWS) and credentials; OpenStack: image, external network, node CIDR, DNS servers, API load balancer yes/no, availability zone, SSH key; AWS: region, availability zones, VPC CIDR, AMI (default: Ubuntu 24.04), API load balancer yes/no, key pair.
4. **Add-ons:** cloud controller manager and CSI driver of the selected provider (OpenStack CCM and Cinder CSI, or AWS cloud controller manager and EBS CSI driver), both preselected and individually deselectable; shows chart version and lets the user override values.
5. **Node customization (collapsed):** per control plane and per worker pool, extra files and commands before or after the Kubernetes installation.
6. **Advanced (collapsed):** pod and service CIDR, additional SSH public keys, rollout settings (max surge, max unavailable).
7. **Preview:** summary + generated manifests as YAML (readable, copyable, downloadable).
8. **Create:** server-side apply, then redirect to the status view.

**Requirements**

- **FP5-F-01** MUST implement the cluster spec and the OpenStack plugin as described in section 5.
- **FP5-F-02** MUST validate every field in the frontend with the same Zod schema as the backend.
- **FP5-F-03** MUST create a dedicated network, subnet and router per cluster on OpenStack (via `OpenStackCluster`).
- **FP5-F-04** MUST install Kubernetes via RKE2 using cloud-init; a standard cloud image (e.g. Ubuntu 24.04) must be sufficient.
- **FP5-F-05** MUST check that the required providers (core, RKE2 bootstrap and control plane, OpenStack with ORC, and CAAPH when add-ons are selected) are installed and ready, and otherwise point to FP-3.
- **FP5-F-06** MUST label all generated resources with a common label (e.g. `capi-navigator.io/managed-by`) so the app can find them again.
- **FP5-F-07** MUST store the cluster spec as an annotation on the `Cluster` object so the app can read and edit it later.
- **FP5-F-08** SHOULD run a dry run (`dryRun=All`) against the Kubernetes API before creating, and show errors in the wizard.
- **FP5-F-09** MUST roll out OpenStack CCM and Cinder CSI when selected, via preset `HelmChartProxy` resources (CAAPH) that match an add-on label on the `Cluster`. The presets are created on first use; FP-8 later makes them editable.
- **FP5-F-10** MUST configure RKE2 for an external cloud provider when the CCM is selected, and provide CCM and CSI with a cloud config derived from the cluster's `clouds.yaml` credentials.
- **FP5-F-11** MUST work with Infomaniak Public Cloud defaults (standard OpenStack APIs, Octavia load balancer, regions and availability zones).
- **FP5-F-12** MUST support multiple worker pools, each as its own `MachineDeployment` with its own templates, size and optional node labels.
- **FP5-F-13** MUST apply node customization per group as files and pre/post commands of the bootstrap config, and show the resulting cloud-init content in the preview.
- **FP5-F-14** MUST restrict node customization to operator and admin, record it in the audit log, and warn against putting secrets into file content inline. SHOULD support file content from a Secret where the bootstrap provider supports it.
- **FP5-F-15** MUST implement the AWS plugin (`InfraProviderPlugin`) as described in section 5, without AWS-specific logic in generic modules (hard rule 10).
- **FP5-F-16** MUST create a dedicated VPC with subnets per AWS cluster (via `AWSCluster`) and install RKE2 via cloud-init on the official Canonical Ubuntu AMI; a prebuilt Kubernetes AMI must not be required.
- **FP5-F-17** MUST roll out the AWS cloud controller manager and the AWS EBS CSI driver via preset `HelmChartProxy` resources when selected, analogous to FP5-F-09.
- **FP5-F-18** MUST check that the AWS infrastructure provider is installed and ready, and that the selected credentials passed their test (FP-4), and otherwise point to FP-3 or FP-4.
- **FP5-F-19** MUST make the root disk of every machine group configurable (size and, optionally, type), with an option to use the same root disk for all groups. OpenStack: without a size the node uses the flavor's local disk; with a size it boots from a Cinder volume (`rootVolume.sizeGiB`, `rootVolume.type` from the Cinder volume types of the cloud); flavors without local disk require a size. AWS: EBS root volume (`rootVolume.size`, default 50 GB; `rootVolume.type` gp3 or gp2, default gp3).
- **FP5-F-20** SHOULD offer an optional bastion host per cluster for SSH access to the nodes, using the provider's built-in bastion (CAPO/CAPA): configurable in the wizard and switchable as a day-2 change without rebuilding nodes; AWS restricts SSH to allowed source networks; the detail view shows the bastion address and an `ssh -J` command per machine (ADR-0007).

**Acceptance criteria**

- [x] Snapshot tests cover the transformation for the standard topology (3 control plane + 2 workers), all-in-one, and with and without add-ons.
- [x] A standard cluster is created on Infomaniak Public Cloud from an unmodified Ubuntu cloud image and reaches the Provisioned state.
- [x] With CCM and CSI selected, all nodes are initialized, a `LoadBalancer` service gets an external IP, and a PVC is bound to a Cinder volume.
- [x] An all-in-one cluster is created and can run workloads.
- [x] Invalid input (e.g. overlapping CIDRs) is reported in the wizard before anything is created.
- [x] Snapshot tests cover the AWS transformation for the standard topology and all-in-one, with and without add-ons.
- [x] A standard cluster is created on AWS from the official Ubuntu AMI and reaches the Provisioned state; with CCM and CSI, a `LoadBalancer` service gets an address and a PVC is bound to an EBS volume. Tests that create real AWS resources run only after explicit confirmation and delete everything afterwards.
- [x] Root disk size and type are configurable per group and for all groups at once on OpenStack and AWS; snapshot tests cover a Cinder root volume with type on a flavor with local disk and an EBS root volume with gp2 (FP5-F-19).

### FP-6: Cluster lifecycle and visualization

**Goal:** existing clusters are clearly visible and can be managed day to day.

- **FP6-F-01** MUST show a cluster list per management cluster: name, provider, distribution, version, node count, phase, labels.
- **FP6-F-02** MUST show a detail view with live status: `Cluster`, control plane, worker pools (`MachineDeployments`), individual `Machines` with phase, image, flavor and conditions, related events.
- **FP6-F-03** MUST render the resource tree of a cluster graphically (cluster → infrastructure, control plane, MachineDeployments → machines), with a status color per node.
- **FP6-F-04** MUST offer the workload cluster kubeconfig (secret `<name>-kubeconfig`) for download; operator and admin only.
- **FP6-F-05** MUST scale worker pools.
- **FP6-F-06** MUST delete a cluster, confirmed by typing the cluster name.
- **FP6-F-07** MUST edit cluster labels (used for Helm add-on assignment in FP-8).
- **FP6-F-08** SHOULD offer an overview page per management cluster: installed providers and the clusters using them, as a graphic.
- Version upgrades, flavor changes and node rebuilds are covered by FP-7.

**Acceptance criteria**

- [x] Status changes appear in under 5 seconds without reloading the page.
- [x] Scaling from 2 to 3 workers creates a new machine that appears in the view.
- [x] After deletion, all OpenStack resources of the cluster are removed and the cluster disappears from the list.

Note from the FP-5 live tests: CAPO does not remove load balancers, floating IPs and volumes that the OpenStack CCM and Cinder CSI created for `LoadBalancer` services and PVCs; they block the deletion of the cluster's router. The delete flow therefore removes workloads, these services and PVCs in the workload cluster first, while CCM and CSI still run (ADR-0006). CAPA removes the CCM's load balancers itself, but not EBS volumes with a `Retain` policy.
- [x] A viewer sees no kubeconfig download and no delete or scale buttons.

### FP-7: Live YAML view and day-2 operations

**Goal:** every resource shown in the app can be inspected as live YAML, read-only, similar to “View YAML” in the Rancher UI. Day-2 changes run through forms that update the cluster spec; anything that affects machines uses CAPI's rolling updates. Nodes are replaced, never patched in place, so no OS patch management is needed.

**Viewing (read-only)**

- **FP7-F-01** MUST provide a “View YAML” action on every resource the app shows (provider CRs, clusters, machines, templates, secrets metadata, HelmChartProxies, HelmReleaseProxies).
- **FP7-F-02** MUST update the displayed YAML live via watch.
- **FP7-F-03** MUST hide `metadata.managedFields` by default (toggle to show).
- **FP7-F-04** MUST never show secret `data` values; secrets show keys only.
- **FP7-F-05** MUST allow copying and downloading the YAML. Free-form YAML editing is out of scope.

**Day-2 operations via forms**

- **FP7-F-06** MUST scale the control plane (1, 3 or 5) and each worker pool, and add or remove worker pools. Scaling the control plane down MUST require an extra confirmation with a warning about etcd quorum.
- **FP7-F-07** MUST change the flavor (machine size) per group, picked from the flavor list of the cluster's credentials (FP-4).
- **FP7-F-08** MUST upgrade the Kubernetes version (RKE2 or k0s) with a rolling update: pick a version from the version catalog (FP3-F-07a), only upgrades, at most one minor version per step. The control plane is upgraded first, worker pools afterwards.
- **FP7-F-09** MUST run pre-checks before an upgrade: all machines healthy, installed providers support the target version, no other rollout running.
- **FP7-F-10** MUST rebuild the nodes of a group from a new image picked from the image list of the credentials (immutable infrastructure instead of OS patching).
- **FP7-F-11** MUST offer “Rebuild nodes” without any change, replacing all nodes of a group with fresh ones (via `rolloutAfter` where supported, otherwise template rotation).
- **FP7-F-12** SHOULD detect when a newer image of the same OS appears in OpenStack (by name pattern or image properties such as `os_distro` and `os_version`) and suggest a rebuild.
- **FP7-F-13** MUST edit node customization per group; the change is rolled out by rebuilding that group's nodes.
- **FP7-F-14** MUST apply every change by updating the stored cluster spec first and then regenerating and applying the manifests through the same transformation as cluster creation.
- **FP7-F-15** MUST implement all machine-affecting changes by template rotation: create new machine and bootstrap templates with new names and switch the references. Existing templates are never modified. Old templates SHOULD be deleted after the rollout.
- **FP7-F-16** MUST show a preview before applying: manifest diff, which nodes will be replaced, in which order, with which surge settings.
- **FP7-F-17** MUST allow only one rollout per cluster at a time, and show its progress live (old and new machines, current step).
- **FP7-F-18** SHOULD let the user set max surge and max unavailable for worker pools.
- **FP7-F-19** MUST detect changes made outside the app (e.g. with `kubectl`) to app-managed resources, show them as drift, and offer “reapply from spec”.
- **FP7-F-20** MUST record every change in the audit log.

**Acceptance criteria**

- [x] The YAML of every listed resource type opens, updates live and offers no edit option.
- [x] Changing worker pool replicas from 2 to 3 via form creates a new machine that appears in the view.
- [x] Upgrading RKE2 by one minor version replaces control plane nodes first, then workers, and the cluster stays available.
- [x] Selecting a newer Ubuntu cloud image rebuilds all nodes of the group; no existing template is modified.
- [x] “Rebuild nodes” replaces all workers of a pool with fresh machines.
- [x] A file added via node customization exists on all new nodes of that pool after the rollout.
- [x] A downgrade or a jump of two minor versions is rejected in the form.
- [x] A replica change made with `kubectl` shows up as drift.
- [x] A viewer sees the YAML but no edit forms.

### FP-8: Helm add-ons via CAAPH

**Goal:** Helm charts are managed centrally and rolled out to workload clusters via the Cluster API Add-on Provider for Helm (CAAPH), using `HelmChartProxy` resources and label selectors.

**Prerequisites and repositories**

- **FP8-F-01** MUST check that CAAPH is installed and ready (`AddonProvider` via FP-3) and otherwise point to FP-3.
- **FP8-F-02** MUST let admins manage Helm repositories (name, URL, HTTP or OCI), stored as HelmRepository resources in the home cluster.
- **FP8-F-03** MUST support private OCI registries with credentials stored in a Secret, and custom CA certificates, using the credentials and TLS options of HelmChartProxy.
- **FP8-F-04** MUST let users browse charts and versions of a repository (backend reads the index) and show the chart's default `values.yaml`.

**Assignment**

- **FP8-F-05** MUST create a `HelmChartProxy` via form: name, chart, repository URL, version, release name and namespace, values, cluster selector.
- **FP8-F-06** MUST edit values in Monaco Editor and support CAAPH's values templating (e.g. cluster name); show an example.
- **FP8-F-07** MUST define the cluster selector by labels and show live which clusters currently match.
- **FP8-F-08** SHOULD offer a quick “assign to this cluster” action on the cluster detail view, which adds a matching label.
- **FP8-F-09** MUST let the user choose the reconcile strategy (continuous or install once).
- **FP8-F-10** MUST show the generated `HelmChartProxy` YAML as a preview before applying.

**Status and lifecycle**

- **FP8-F-11** MUST list `HelmReleaseProxy` objects per chart and per cluster: cluster, release, chart version, revision, status, conditions.
- **FP8-F-12** MUST show the Helm add-ons of a cluster on its detail view.
- **FP8-F-13** MUST upgrade chart version and values, and remove a `HelmChartProxy` with a warning that releases will be uninstalled from all matching clusters.
- **FP8-F-14** MUST make the OpenStack CCM and Cinder CSI presets from FP-5 viewable and editable (chart version, default values), and SHOULD allow admins to define further presets.

**Acceptance criteria**

- [x] A chart from a public repository (e.g. ingress-nginx) is rolled out to two labelled workload clusters, and both releases show as deployed.
- [x] Adding the label to a third cluster installs the release there automatically.
- [x] Changing values updates the releases on all matching clusters.
- [x] Deleting the `HelmChartProxy` removes the releases after confirmation.

Verified on 2026-10-18 with podinfo 6.15.0 instead of ingress-nginx (retired in March 2026) on two OpenStack clusters and an AWS cluster in one namespace, plus a private OCI registry with credentials and a custom CA (ADR-0011). Deferred: admin-defined presets (SHOULD part of FP8-F-14).

### FP-9: k0s as second Kubernetes distribution

**Goal:** k0s becomes an alternative to RKE2. Like RKE2, it is installed via cloud-init on official cloud images, using the k0smotron bootstrap and control plane providers with the control plane running on regular machines (not hosted).

- **FP9-F-01** MUST add the k0smotron bootstrap and control plane providers to the provider catalog and install them via FP-3.
- **FP9-F-02** MUST implement the `BootstrapFlavorPlugin` for k0s, generating `K0sControlPlane` and `K0sWorkerConfigTemplate`.
- **FP9-F-03** MUST map node customization to the k0s equivalents (files, pre-start and post-start commands).
- **FP9-F-04** MUST support CCM and CSI with k0s (external cloud provider configuration).
- **FP9-F-05** MUST support all day-2 operations from FP-7 for k0s clusters: scaling, flavor change, version upgrade, rebuild.
- **FP9-F-06** MUST let the wizard choose between RKE2 and k0s, with RKE2 as default.
- **FP9-F-07** MUST NOT require changes to the cluster spec core or to the OpenStack plugin; only the new flavor plugin is added.

**Acceptance criteria**

- [x] Snapshot tests cover k0s for the standard topology and all-in-one.
- [x] A k0s standard cluster is created on Infomaniak Public Cloud from an unmodified Ubuntu cloud image, with CCM and CSI working.
- [ ] A k0s cluster can be upgraded by one minor version and rebuilt from a new image via FP-7. **Partly met, blocked upstream:** the upgrade works (control plane in place via k0s autopilot, workers replaced); a new image reaches the worker pools only, because k0smotron v2.2.0 cannot replace control plane machines without losing etcd quorum (ADR-0013). OS updates of control plane nodes run via unattended-upgrades and the kured preset.

Verified on 2026-10-18 on Infomaniak (3 control plane nodes + 1 worker, v1.34.11+k0s.1 → v1.35.8+k0s.1, Ubuntu 22.04 → 24.04 for workers). Deviations: ADR-0012 (distributions declare their network needs), ADR-0013 (in-place control plane upgrades, no control plane replacement).

### FP-10: Vanilla Kubernetes with kubeadm on stock images (experimental)

**Goal:** offer upstream Kubernetes via the official kubeadm providers without prebuilt images. Containerd, kubelet and kubeadm are installed at first boot on an official Ubuntu cloud image via `preKubeadmCommands`. This is not an officially supported CAPI path, so the app marks it as experimental.

- **FP10-F-01** MUST implement the `BootstrapFlavorPlugin` for kubeadm, generating `KubeadmControlPlane` and `KubeadmConfigTemplate` (providers already in the catalog from FP-3).
- **FP10-F-02** MUST generate an install script in `preKubeadmCommands` that prepares the node (kernel modules, sysctl, swap off), installs containerd, and installs kubelet and kubeadm of exactly the selected version from the official package repository `pkgs.k8s.io`, holding the packages against automatic updates.
- **FP10-F-03** MUST support Ubuntu LTS cloud images only at first; other distributions MAY follow.
- **FP10-F-04** MUST roll out a CNI, since kubeadm ships none: a preset via CAAPH (e.g. Calico or Cilium), selectable in the wizard's add-on step and preselected for kubeadm clusters.
- **FP10-F-05** MUST map node customization to `files`, `preKubeadmCommands` (after the install script) and `postKubeadmCommands`.
- **FP10-F-06** MUST support CCM and CSI (kubelet configured for an external cloud provider).
- **FP10-F-07** MUST support all day-2 operations from FP-7. A version upgrade works by template rotation: new machines run the install script with the new version.
- **FP10-F-08** MUST label kubeadm as “experimental” in the wizard and explain the trade-offs: longer node start, dependency on reachable package repositories, not covered by official CAPI support.
- **FP10-F-09** SHOULD allow a custom package mirror URL for environments without direct internet access.

**Acceptance criteria**

- [x] Snapshot tests cover the kubeadm flavor including the generated install script.
- [x] A kubeadm standard cluster is created on Infomaniak Public Cloud from an unmodified Ubuntu cloud image, with CNI, CCM and CSI working.
- [x] Upgrading by one minor version replaces all nodes, and the new nodes run the new kubelet version.
- [x] The wizard shows the experimental label and the trade-offs before creation.

Verified on 2026-10-18 on Infomaniak with `fp10-kubeadm-c` (1 control plane, 1 worker): created from stock Ubuntu 24.04 with kubeadm v1.34.12; Calico, OpenStack CCM (load balancer with public IP) and Cinder CSI (volume bound and mounted) working; pod traffic across nodes by pod IP and service name. Upgrade to v1.35.9 replaced both nodes (control plane first) without API downtime; changing the image of control plane and workers to Debian 13 created new templates and left existing ones unchanged; then deleted with cleanup. Refinements (ADR-0014): containerd and runc come as checksum-verified release binaries, so Debian and Rocky/Alma images work as well (FP10-F-03); Calico is delivered by a `ClusterResourceSet` instead of CAAPH, because its CRD chart exceeds the 1 MiB Helm release limit (FP10-F-04).

### FP-17: Node shell (implemented ahead of FP-7)

**Goal:** a root shell on any node of a workload cluster or of the management cluster from the web UI, for troubleshooting, without SSH keys (ADR-0008).

- **FP17-F-01** MUST open a terminal (xterm.js over WebSocket) on a node through a short-lived privileged pod that enters the host namespaces with `nsenter`.
- **FP17-F-02** MUST allow workload cluster nodes for operators and admins and management cluster nodes for admins only; the backend enforces the roles and a same-origin check on the WebSocket. Since FP-19 these are the permissions `nodes.shell` (in the cluster's connection and namespace) and `managementNodes.shell`.
- **FP17-F-03** MUST delete the pod when the session ends, after 15 minutes without input, and at the latest after one hour (`activeDeadlineSeconds`), and remove leftovers.
- **FP17-F-04** MUST record start and end of every session as `AuditEvent`, without terminal content.
- **FP17-F-05** SHOULD make the pod image configurable for mirrors (FP-16).
- A web SSH terminal through the bastion host (FP5-F-20) is on hold.

**Acceptance criteria**

- [x] An admin opens a shell on a management cluster node (kind) and runs commands as root in the host namespaces; the pod is gone after closing.
- [x] Operators see a shell button per machine with a node; viewers see none and the backend refuses their WebSocket.
- [x] A WebSocket without the app's origin is refused.

### FP-18: Read-only cluster dashboard (implemented ahead of FP-7)

**Goal:** a quick read-only overview of what runs inside a workload cluster (ADR-0009).

- **FP18-F-01** MUST show CPU and memory per node and for the cluster: usage (metrics-server), requests and limits relative to the allocatable capacity, and pod counts.
- **FP18-F-02** MUST show workloads (Deployments, StatefulSets, DaemonSets, running or failed Jobs) with ready/desired, unhealthy ones first, and pods with problems (CrashLoopBackOff, image pull errors, unschedulable, failed, many restarts).
- **FP18-F-03** MUST show LoadBalancer and NodePort services with their external addresses, ingresses and HTTPRoutes with hosts, TLS and backends.
- **FP18-F-04** MUST show the newest events of the cluster, filterable by namespace and to warnings.
- **FP18-F-05** MUST be readable by viewers and offer no actions; Secret and ConfigMap content is never read.
- **FP18-F-06** SHOULD refresh while open and work without metrics-server (requests and limits only).

**Acceptance criteria**

- [x] On an RKE2 cluster on Infomaniak, usage and requests match `kubectl top nodes` and `kubectl describe node`.
- [x] A viewer opens the dashboard and sees nodes and workloads; no action buttons.
- [x] Without metrics-server the dashboard still works and says so.

### FP-19: Role management (optional)

**Goal:** admins define their own roles as a set of permissions and assign roles to users, optionally limited to management cluster connections and namespaces (e.g. operator only in `home/team-a`). The three built-in roles stay and behave exactly as before (ADR-0015).

**Permissions**

| Permission | Allows | Built-in role | Scopable |
| --- | --- | --- | --- |
| `view` | Read everything: clusters, status, YAML, dashboard, providers, add-ons, events | viewer | – (reading is global, see FP19-F-04) |
| `clusters.create` | Create workload clusters, incl. cloud lookups in the wizard and allowing a credential in the cluster's namespace | operator | yes |
| `clusters.change` | Day-2 changes, scaling, labels (which also assigns add-ons), bastion | operator | yes |
| `clusters.delete` | Delete workload clusters | operator | yes |
| `clusters.kubeconfig` | View and download workload kubeconfigs | operator | yes |
| `nodes.shell` | Node shell on workload cluster nodes | operator | yes |
| `addons.manage` | Create, change and delete add-ons; browse charts | operator | yes |
| `presets.manage` | Override and roll out CCM, CSI and kured presets | admin | no |
| `providers.manage` | Install, change and remove ORC and providers | admin | no |
| `credentials.manage` | Manage and test cloud credentials | admin | no |
| `connections.manage` | Connect management clusters | admin | no |
| `helmRepositories.manage` | Manage Helm repositories | admin | no |
| `managementNodes.shell` | Node shell on management cluster nodes | admin | no |
| `users.manage` | Manage users, roles and role assignments | admin | no |

Built-in roles: viewer = `view`; operator = viewer plus all `clusters.*`, `nodes.shell` and `addons.manage`; admin = all permissions.

**Requirements**

- **FP19-F-01** MUST define the permissions above once in `packages/shared`; the built-in roles viewer, operator and admin are fixed in code, cannot be changed or deleted and grant exactly the access of FP-1.
- **FP19-F-02** MUST store custom roles as `NavigatorRole` resources in the app namespace of the home cluster (display name, description, permissions; every role includes `view`).
- **FP19-F-03** MUST give each user one or more role assignments (bindings), each optionally limited to management cluster connections and namespaces. An assignment without a limit applies everywhere. A limited assignment may only grant scopable permissions.
- **FP19-F-04** MUST apply the limits to actions only: every signed-in user can read all clusters, add-ons and events; lists are not filtered.
- **FP19-F-05** MUST check permissions in the backend on every endpoint and on the node shell WebSocket instead of fixed roles (hard rule 9). The scope comes from the route (connection, namespace) or, for creation, from the requested namespace. An endpoint that names a connection but no namespace (e.g. cloud lookups, chart browsing) requires the permission for at least one namespace of that connection. Endpoints without a rule stay denied.
- **FP19-F-06** MUST resolve permissions on every request from the cached users and roles, so changes to roles and assignments apply without signing in again.
- **FP19-F-07** MUST keep existing users working after the update: a stored `role` becomes one unlimited assignment of that role.
- **FP19-F-08** MUST refuse deleting a role that is still assigned (the message names the users) and changes that would leave no enabled user with an unlimited `users.manage`.
- **FP19-F-09** MUST provide a roles page for users with `users.manage`: built-in and custom roles, permissions grouped with help texts, the users of each role, creating a role as a copy of another; and editing role assignments in the user management.
- **FP19-F-10** MUST show actions in the frontend according to the permissions for the respective cluster or namespace (cosmetic only); the wizard offers only namespaces in which the user may create clusters.
- **FP19-F-11** MUST record creating, changing and deleting roles and changes to role assignments as `AuditEvent`s.
- **FP19-F-12** SHOULD keep the mapping open for FP-14, where group claims of an identity provider become role assignments.

**Acceptance criteria**

- [x] A test lists every endpoint with its permission and checks that viewer, operator and admin get exactly the access they had before FP-19; all existing tests pass unchanged.
- [x] A custom role with `view` and `clusters.change` can scale a cluster but cannot create or delete clusters or read the kubeconfig: the backend answers 403 also to direct API calls, and the UI hides these actions.
- [x] An assignment "operator in `home/team-a`" can change clusters in `team-a` and gets 403 in another namespace, also for the node shell; the wizard offers only `team-a`.
- [x] Changing a role takes effect without signing in again; an assigned role and the built-in roles cannot be deleted; the last user with unlimited `users.manage` cannot be removed or limited.
- [x] Existing users keep their access after the update without manual steps.
- [x] Role and assignment changes appear as `AuditEvent`s.
- [x] A Playwright test covers the custom role case.

Verified on 2026-10-18 with unit, HTTP and Playwright tests and on the local kind cluster (users from before FP-19 keep their access; screenshots of the roles page, the assignment editor and the wizard with limited namespaces). The endpoint matrix test was checked to fail on a deliberate change. Open for later: filtering what users can read by their scope, and group claims of FP-14 (FP19-F-12).

### FP-20: Version maintenance (optional)

**Goal:** every version the app pins lives in one human-readable file, and a report on demand shows which newer versions exist, so the maintainers can update deliberately. No bot opens pull requests: the app has no team that reviews updates daily, and blind provider updates are risky (ADR-0018).

- **FP20-F-01** MUST keep all pinned versions of the app in `versions.yaml` at the repository root: CAPI providers, cert-manager, CAPI Operator, ORC per CAPO minor, the Kubernetes versions per distribution, the charts of the add-on presets, containerd and runc, the Calico manifest (version and SHA-256), and the node shell image. Each entry names its source (GitHub releases, Helm repository, container registry) and may carry a note (verified on, coupled with).
- **FP20-F-02** MUST validate `versions.yaml` with a Zod schema and turn it into a typed TypeScript module in `packages/shared` at build time (`pnpm versions:generate`); the app reads no file at runtime, so an app version stays reproducible. A test fails when the generated module is outdated.
- **FP20-F-03** MUST remove every other copy of these versions from the code, scripts and Helm values; the generated module is their only source. The generated manifests stay byte-identical (existing snapshot tests unchanged).
- **FP20-F-04** MUST check coupled versions with tests: the CAPI core and kubeadm providers share one version, the RKE2 bootstrap and control plane providers share one, the k0smotron providers share one, ORC exists for the CAPO minor version, and every distribution has exactly one default Kubernetes version.
- **FP20-F-05** MUST provide `pnpm versions:report`: Renovate in a pinned container image, `--platform=local`, read-only on the repository, finds newer versions for `versions.yaml` (custom manager in `renovate.json`) and for the GitHub Actions and Docker images of the repository. The script writes `docs/versions-report.md` with the date: "App versions" (from `versions.yaml`, grouped) and a short appendix for Actions and Docker, each with current version, newest version, update type (patch, minor, major) and where to change it (`versions.yaml` path or file). npm packages are not part of the report: `pnpm outdated -r` shows them and `pnpm up` updates all `package.json` files and the lockfile. Run by hand and committed; no scheduled job, no pull requests.
- **FP20-F-06** MUST use the local GitHub CLI login (`gh auth token`) for GitHub release lookups only for the duration of the run, never store it, and note sources that could not be checked without it in the report.
- **FP20-F-07** MUST turn the kubeadm install script into a template file (`kubeadm-install.sh.tmpl`) with placeholders, turned into a TypeScript module at build time and checked by `shellcheck` in CI; the transformation stays pure and the snapshots unchanged.
- **FP20-F-08** MUST document the procedure in `docs/maintenance.md` (when to run the report, how to update a version, what to verify: tests and snapshots for every update; for minor updates of CAPI, providers, CCM and CSI additionally a dry run on kind and a short live test) and link it from the README.

**Acceptance criteria**

- [x] `versions.yaml` holds every pinned version; searching the code, scripts and Helm values finds no second copy.
- [x] Changing a version in `versions.yaml` and running `pnpm versions:generate` changes the app; the tests detect an outdated generated module and broken couplings.
- [x] All snapshot tests pass unchanged after the move.
- [x] `pnpm versions:report` writes `docs/versions-report.md` with the app versions and the Actions/Docker appendix, without changing anything else in the repository.
- [x] The kubeadm install script is a template file and passes `shellcheck` in CI.
- [x] `docs/maintenance.md` exists and the README links to it.

Verified on 2026-10-19: all 36 pinned versions (32 entries) moved to `versions.yaml`, checked to equal the previous values; no snapshot changed (the generated manifests and node scripts are byte-identical). Renovate 44.133.0 finds all entries; the first report showed the RKE2 provider v0.27.0, containerd 2.4.2, alpine 3.24 and all GitHub Actions one or two majors behind. A test that a provider update without re-verified Kubernetes versions fails was checked to fail. Remaining version strings in code are comments naming what an implementation was verified against (see `docs/maintenance.md`).

### FP-22: API tokens for technical users (optional)

**Goal:** CI pipelines, GitOps tools and scripts call the REST API without a browser session. Admins create technical users ("API only") with role assignments (FP-19) and generate tokens for them in the user management (ADR-0017). Tokens for human users may follow later.

- **FP22-F-01** MUST let users with `users.manage` create technical users ("API only"): no password, sign-in refused, marked as technical in the user list; their access comes from role assignments like for every user.
- **FP22-F-02** MUST let users with `users.manage` generate, list and revoke tokens of technical users in the user management; tokens for human users are refused. A token has a name, an optional description, an expiry date (default 90 days, at most 365 days) and shows when it was last used.
- **FP22-F-03** MUST show a token exactly once after generating it. Tokens start with the prefix `capin_` (detectable by secret scanners) and carry 256 bits of randomness; only their SHA-256 hash is stored.
- **FP22-F-04** MUST accept `Authorization: Bearer <token>` on the REST API. A token acts with the role assignments of its technical user, resolved on every request (FP19-F-06); an expired or revoked token, or one of a disabled or deleted user, is refused with 401. Requests with a bearer token use no session cookie and need no CSRF header.
- **FP22-F-05** MUST refuse token requests to endpoints that need `users.manage` (users, roles, tokens), so a token can never extend its own access, and MUST refuse tokens on the node shell WebSocket.
- **FP22-F-06** MUST slow down repeated failed token attempts per client like failed logins (NF-04).
- **FP22-F-07** MUST record the token in the audit log of every mutating request (`actor` is the technical user, `token` the token name) and audit generating and revoking tokens.
- **FP22-F-08** MUST describe the bearer authentication in the OpenAPI document; Swagger UI accepts a token via "Authorize".
- **FP22-F-09** SHOULD update "last used" at most once per hour per token, so API calls do not cause constant writes to the home cluster.

**Acceptance criteria**

- [x] An admin creates a technical user with the role "operator in `home/team-a`", generates a token in the UI and sees it once.
- [x] With the token, `curl -H "Authorization: Bearer …"` reads clusters and changes a cluster in `team-a` without CSRF header and gets 403 in another namespace and on `/api/users`.
- [x] A revoked or expired token, and the token of a disabled technical user, answer 401; the technical user cannot sign in to the UI.
- [x] Tokens are stored only as hashes; the token value appears in no API response except the one after generating, and in no log or audit event.
- [x] Audit events of token requests name the technical user and the token.
- [x] Swagger UI "Authorize" with a token runs a request.
- [x] A Playwright test covers creating the technical user and the token in the UI and using the token.

Verified on 2026-10-19 with unit, HTTP and Playwright tests and with `curl` against the dev backend: reading 200, a change in `team-a` passed the permission check, `team-b` and `/api/users` 403, the token of a deleted user 401; the cluster held only the hash. Failed token attempts are throttled per client, but a valid token always passes (ADR-0017).

### FP-23: OpenAPI description and Swagger UI (optional)

**Goal:** a machine-readable OpenAPI 3.1 description of the REST API and a Swagger UI in the app, so users and scripts can explore and try the API, generated from the same Zod schemas that validate the requests (ADR-0016).

- **FP23-F-01** MUST generate an OpenAPI 3.1 document from the backend's controllers at runtime: paths, methods and parameters from the NestJS route metadata, request bodies and query parameters from the Zod schemas of the validation pipes (no second definition, hard rule 2), JSON Schema output of Zod 4, no new generator dependency.
- **FP23-F-02** MUST describe every operation with a short summary, a tag per domain, the required permission and its scope (FP-19), and the response: a named Zod schema from `packages/shared` for JSON responses, `text/event-stream` for live updates, no body for 204; errors use the common error body.
- **FP23-F-03** MUST describe the authentication: session cookie plus the CSRF header `x-capi-navigator: 1` for mutating requests, and API tokens of technical users (FP-22).
- **FP23-F-04** MUST serve the document at `GET /api/openapi.json` and Swagger UI at `GET /api/docs`, both without sign-in. Swagger UI is shipped with the app (`swagger-ui-dist`, no CDN, no inline scripts, unchanged Content Security Policy). "Try it out" uses the browser's session and adds the CSRF header to mutating requests; permissions, preview and audit apply unchanged.
- **FP23-F-05** MUST commit the generated document as `docs/api/openapi.json` (`pnpm openapi:generate`); a test fails when it is outdated or when an endpoint lacks summary, permission or (for JSON responses) response schema.
- **FP23-F-06** MUST be switchable off with the Helm value `apiDocs.enabled` (environment variable `API_DOCS_ENABLED`, default on); when off, both paths answer 404.
- **FP23-F-07** SHOULD link the API documentation from the user menu of the app.

**Acceptance criteria**

- [x] `/api/openapi.json` is a valid OpenAPI 3.1 document covering every endpoint; a test fails for an endpoint without summary, permission or response schema.
- [x] For a sample endpoint, a test shows that the documented request schema is the one the validation uses.
- [x] `docs/api/openapi.json` is committed and checked to be current.
- [x] `/api/docs` shows Swagger UI without external sources; "Try it out" works with the session for reading and mutating requests, and missing permissions still answer 403.
- [x] Every operation shows its required permission.
- [x] With `apiDocs.enabled=false` both paths answer 404.
- [x] A Playwright test opens Swagger UI and runs `GET /api/auth/me` with "Try it out".

Verified on 2026-10-19 with unit, HTTP and Playwright tests, in `pnpm dev` and in the built container image (document, Swagger UI, CSP unchanged). The image test also showed that `apps/backend/assets` was missing from the published images (Calico manifest of FP-10); fixed separately. Swagger UI sends the CSRF header from the documented parameter; its start script adds it as a fallback.

### FP-14: Sign-in with an OpenID Connect provider (optional)

**Goal:** people sign in to the web UI with the organisation's identity provider (any OpenID Connect provider, e.g. Okta, Auth0, Dex, Keycloak or Rancher). Access comes from the provider's groups, mapped to roles in the app; nobody has to be created in the app first. Local users stay available (break-glass admin, technical users of FP-22).

- **FP14-F-01** MUST support one OpenID Connect provider per installation. Users with `users.manage` configure it in the web UI (ADR-0020): issuer URL (discovery via `/.well-known/openid-configuration`), client ID, client secret, scopes, the name of the groups claim (also URL-like names such as Auth0's namespaced claims), the claim for the display name (default `preferred_username`, then `email`, then `sub`), the label of the sign-in button and a default role. Only the app's public URL is a deployment setting (Helm value `publicUrl`). No provider is hard-coded; anything beyond OpenID Connect Core and Discovery is configuration.
- **FP14-F-02** MUST sign in with the authorization code flow with PKCE, `state` and `nonce`, run by the backend as a confidential client. The backend validates the ID token (signature from the provider's JWKS, issuer, audience, expiry, nonce). Tokens of the provider never reach the browser and are not stored; the app issues its own session cookie (FP1-F-03) as for local users.
- **FP14-F-03** MUST build the redirect URI from the configured public URL (`<publicUrl>/api/auth/oidc/callback`), never from request headers, and refuse to enable OIDC while no public URL is configured.
- **FP14-F-04** MUST let users with `users.manage` map provider groups, and single people of the provider, to role assignments (role plus optional scope of connections and namespaces, as in FP-19), stored as `NavigatorGroup` custom resources in the home cluster. A person is identified by the subject (`sub`) and the issuer it was mapped for, never by a name; mappings of a person do not apply to another issuer. A person's access is the union of the assignments of their groups and of their person mapping, resolved on every request (FP19-F-06): changing or removing a mapping and adding a person mapping apply at once; a new group mapping and a changed group membership apply with the next sign-in. People signed in with OIDC see their subject in the user menu, and it is in the audit event of the sign-in, so admins can map providers without groups (e.g. Rancher with local accounts).
- **FP14-F-05** MUST give a person whose groups have no mapping the configured default role (default `viewer`) with unlimited scope, or refuse the sign-in with an understandable message if no default role is configured.
- **FP14-F-06** MUST keep the session cookie small: it holds the person's subject, display name and only those groups that are mapped in the app, and the same lifetime as local sessions (`SESSION_TTL_HOURS`).
- **FP14-F-07** MUST keep local sign-in available. The sign-in page shows the local form and, when OIDC is configured, a button "Sign in with …" below it. OIDC users and local users are separate; an OIDC user is shown as `<name> (oidc)` in the user menu and in the audit log (with the subject).
- **FP14-F-08** MUST NOT give OIDC users API tokens or a password; their user menu shows their groups instead of "Change password".
- **FP14-F-09** MUST audit successful and failed OIDC sign-ins (without tokens or codes) and every change of group mappings.
- **FP14-F-10** SHOULD sign the person out at the provider too when it offers an `end_session_endpoint`.
- **FP14-F-11** MUST document the setup, including the redirect URI and the groups claim, with examples in this order: Okta and Auth0, then Dex and Keycloak, then Rancher (explaining that Rancher can itself act as an OpenID Connect provider). Examples use placeholder URLs only.
- **FP14-F-12** MUST offer a page "Authentication" under Administration with the settings, the redirect URI to register at the provider, a test that runs the discovery with the entered values and shows what the provider offers (endpoints, scopes, end-session), and a switch to turn OIDC on and off without losing the settings. Saving shows a preview of the change and writes an `AuditEvent`.
- **FP14-F-13** MUST store the settings as a `NavigatorAuthSettings` resource and the client secret in a Secret in the home cluster, and apply changes without a restart on all replicas.
- **FP14-F-14** MUST treat the client secret as write-only: no API response, log or audit event contains it; the page shows only whether one is set and can replace it.

**Acceptance criteria**

- [x] With Dex, a person in a group mapped to "operator in `home/team-a`" signs in with the button, changes a cluster in `team-a` and gets 403 in `team-b`; nobody was created in the app beforehand.
- [x] A person without a mapped group gets the default role; with no default role the sign-in is refused with a message.
- [x] Removing a group mapping takes effect on the next request; local sign-in keeps working with OIDC enabled.
- [x] Wrong issuer, wrong audience, an expired ID token, a wrong `nonce` or `state` and a replayed callback are refused (tests against a test provider).
- [x] No provider token or authorization code appears in API responses, logs, the audit log or the browser.
- [x] The setup guide covers Okta, Auth0, Dex, Keycloak and Rancher, in this order.
- [x] A Playwright test signs in through a test provider.
- [ ] A person without groups (Dex user carol) gets a person mapping as operator and has that access on the next request; the mapping does not apply after switching to another issuer.
- [x] An admin configures Dex on the Authentication page, runs the test, saves, and the sign-in button appears without a restart; switching OIDC off hides it again.
- [x] The client secret appears in no API response, log or audit event.

Verified on 2026-10-20 with HTTP tests against an in-process test provider (all failure cases), a Playwright test against Dex v2.46 in kind (`pnpm dex:up`) and live checks: an OIDC operator of `team-a` passed the permission check in `team-a` and got 403 in `team-b` and on `/api/users`. The tests showed that `openid-client` accepts ID tokens with a foreign signature from the token endpoint unless `enableNonRepudiationChecks` is set; it is set (ADR-0019). The settings moved to the web UI the same day (ADR-0020): `pnpm dex:up` configured a running backend without restart, and a Playwright test saves, switches off and on again on the Authentication page.

## 7. Non-functional requirements

These requirements apply to all feature packs and are checked in every pack.

### Security

- **NF-01** MUST store all credentials (passwords, kubeconfigs, service account tokens, cloud credentials, Helm repository credentials) only in Kubernetes Secrets and never output them in logs or API responses.
- **NF-02** MUST execute every Kubernetes operation with the permissions of the stored connection; the app never escalates privileges.
- **NF-03** SHOULD ship an example of a minimal ClusterRole the app needs on the management cluster.
- **NF-04** MUST provide CSRF protection, a content security policy and rate limiting on login endpoints.
- **NF-05** MUST keep dependencies updated via Dependabot or Renovate.

### Usability

- **NF-06** MUST translate Kubernetes API errors into understandable messages with a hint for resolution; the original error stays expandable.
- **NF-07** MUST be able to show every mutating action as a YAML preview beforehand (“What will be applied?”).
- **NF-08** MUST explain every form field with short help (tooltip or hint text), including its default value.
- **NF-09** MUST route all UI texts through vue-i18n. The MVP ships English only; further languages (e.g. German) MAY be added later without code changes.
- **NF-10** SHOULD support light and dark mode.

### Performance and robustness

- **NF-11** MUST update lists and status via Kubernetes watches rather than polling, with automatic re-establishment of dropped watches.
- **NF-12** MUST remain responsive with 50 workload clusters per management cluster (page load under 2 seconds).
- **NF-13** MUST be idempotent: applying the same spec again changes nothing (server-side apply with a fixed field manager `capi-navigator`).

### Quality and testing

- **NF-14** MUST cover transformations with snapshot tests (one file per topology and provider).
- **NF-15** MUST cover backend services with unit tests; target at least 70 % line coverage in the backend.
- **NF-16** SHOULD run integration tests against a kind cluster with the CAPI Operator in CI.
- **NF-17** SHOULD test the main flows (login, install provider, cluster wizard up to the preview, replica and flavor change, Helm assignment) with Playwright.

### Operations and observability

- **NF-18** MUST write structured JSON logs.
- **NF-19** SHOULD expose Prometheus metrics at `/metrics`.
- **NF-20** MUST provide liveness and readiness endpoints for Kubernetes.

## 8. Outlook, open questions and notes for Claude Code

### Outlook after FP-10

- **FP-11: Further infrastructure providers** (e.g. Azure, GCP), purely as new plugins as described in section 5. AWS is part of FP-4 and FP-5.
- **FP-12: ClusterClass support**, so teams can offer their own cluster templates in the UI.
- **FP-13: Fleet view** across multiple management clusters, including bulk upgrades, bulk rebuilds and bulk add-on rollouts.
- **FP-14: External identity provider**: specified above as an optional pack (OpenID Connect sign-in with group mapping).
- **FP-15: Immutable OS images** such as openSUSE MicroOS. To check first: MicroOS is usually configured with Ignition or Combustion rather than cloud-init, so it may need its own bootstrap path.
- **FP-16: Operation behind an HTTP(S) proxy** (optional, after FP-10), for OpenStack in an own data center. Agreed scope:
  - The proxy is configured and enabled **per cluster**: per management cluster connection (CAPI Operator, providers, CAAPH, backend access) and per workload cluster (defaults from the management cluster connection, overridable or disabled per cluster). Hybrid setups are supported, e.g. management cluster in the intranet behind a proxy and workload clusters on a public cloud without one, or the other way round.
  - Workload clusters: `httpProxy`, `httpsProxy` and `noProxy` in the cluster spec. Each `BootstrapFlavorPlugin` writes its own proxy configuration (RKE2: `/etc/default/rke2-server|rke2-agent` plus exports for the install script; k0s and kubeadm analogous, including apt/dnf), each `InfraProviderPlugin` contributes its `NO_PROXY` entries. `NO_PROXY` is derived automatically (pod, service and node CIDRs, `.svc`, `.cluster.local`, `localhost`, API server endpoint, `169.254.169.254`, cloud API endpoints) and can be extended. CCM and CSI get the proxy through their Helm values.
  - The proxy intercepts TLS: a custom CA certificate (stored as a Secret) is distributed to the nodes (system trust store and container runtime), the backend (`NODE_EXTRA_CA_CERTS`), the CAPI Operator, the providers, CAAPH, CCM and CSI.
  - No proxy authentication (server-to-server in the data center); proxy URLs end up in the node user data and must not contain credentials.
  - Stages: (a) workload clusters, (b) management side, (c) custom CA for TLS interception. Fully air-gapped operation (registry mirror, `airGapped` installs, FP10-F-09) is a separate topic.
  - Tests: snapshot tests per flavor with and without proxy; integration test with a TLS-intercepting proxy (Squid with SSL bump) and a network without direct internet access.
- **FP-19: Role management**: specified in section 6 (custom roles and assignments limited to connections and namespaces). Possible later: filtering what users can read by their scope.
- **FP-20: Version maintenance**: specified in section 6 (`versions.yaml` and an update report on demand). Possible later: Renovate pull requests from a scheduled workflow, and in-app hints for newer preset charts and provider releases.
- **FP-21: CNI selection** (optional, low priority). Calico with VXLAN is the default for all distributions (RKE2 and k0s built in, kubeadm via a preset, FP-10). Later the wizard could offer a choice (e.g. Cilium or Flannel) per cluster, where each distribution supports it; the flavor plugins would then declare the CNIs they support and the node traffic each one needs (ADR-0012).
- **FP-22: API tokens**: specified in section 6 for technical users; tokens for human users, scoped tokens and Kubernetes ServiceAccount tokens (TokenReview) may follow.
- **FP-23: OpenAPI description and Swagger UI**: specified in section 6.
- Possible later: K3s, kubeadm with prebuilt images, control plane hosting (Kamaji), GitOps export of manifests, free-form YAML editing.

### Decisions

| Topic | Decision |
| --- | --- |
| Identity provider | Local user accounts (FP-1); OpenID Connect sign-in as optional pack FP-14. |
| Backend access to clusters | Via kubeconfig or service account token (FP-2). |
| Test and target cloud | [Infomaniak Public Cloud](https://www.infomaniak.com/en/support/faq/2601/getting-started-public-cloud): largely vanilla OpenStack with [Octavia load balancers](https://www.infomaniak.com/public-cloud), access via `clouds.yaml`. |
| AWS | Second target cloud from FP-4/FP-5 (CAPA). Credentials as `AWSClusterStaticIdentity` of a dedicated IAM user; the app checks the CAPA IAM prerequisites and shows the `clusterawsadm` command, but never creates IAM resources itself. Real AWS resources in tests only after explicit confirmation. |
| Kubernetes distributions | RKE2 (FP-5), k0s (FP-9) and kubeadm (FP-10, experimental, packages installed via preKubeadmCommands), all via cloud-init on official cloud images. |
| OS patching | None in place. Nodes are rebuilt from new cloud images via rolling update (FP-7). |
| ORC | Required; detected and installed in FP-3 before CAPO. |
| CCM and CSI | Rolled out with each cluster by default and deselectable in the wizard (FP-5). |
| CCM and CSI charts | OpenStack: current release of [kubernetes/cloud-provider-openstack](https://github.com/kubernetes/cloud-provider-openstack) (OpenStack Cloud Controller Manager and Cinder CSI); works on Infomaniak. AWS: current releases of [kubernetes/cloud-provider-aws](https://github.com/kubernetes/cloud-provider-aws) and [kubernetes-sigs/aws-ebs-csi-driver](https://github.com/kubernetes-sigs/aws-ebs-csi-driver). |
| CAAPH version | Current release. It supports the reconcile strategy and credentials for private OCI registries, so FP-8 uses both. |
| Manual YAML edits | Not supported. YAML is read-only; day-2 changes go through forms (FP-7). Changes made outside the app are shown as drift. |
| Datastore | None; all state in Kubernetes CRDs, Secrets and ConfigMaps, like Rancher (section 4). |
| API group of own CRDs | `navigator.capi-navigator.io` |
| Product name | CAPI Navigator. |

### Open questions

None at the moment. New questions are added here as a checklist.

### Notes for Claude Code and other coding agents

1. Work on exactly one feature pack at a time. Start with FP-0 and begin the next only when all MUST acceptance criteria are met.
2. Read sections 4 and 5 before every pack; they apply to all packs.
3. Always create new types and schemas in `packages/shared`, never duplicated in frontend or backend.
4. Keep transformations pure (no I/O) and write the snapshot test first.
5. Verify CRD fields and API versions of CAPI, CAPI Operator, CAPO, the RKE2 provider, k0smotron and CAAPH against the current official documentation instead of relying on memory.
6. At the end of each pack, run `pnpm lint`, `pnpm typecheck` and `pnpm test`, and tick off the acceptance criteria in this document.
7. Record decisions that deviate from this document as a short ADR under `docs/adr/`.
