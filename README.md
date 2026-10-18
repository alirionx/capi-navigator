# CAPI Navigator

[![CI](https://github.com/alirionx/capi-navigator/actions/workflows/ci.yaml/badge.svg)](https://github.com/alirionx/capi-navigator/actions/workflows/ci.yaml)

A lean web UI for [Cluster API](https://cluster-api.sigs.k8s.io/) (CAPI). Connect a management
cluster, install the CAPI providers, store cloud credentials and create, operate and delete
Kubernetes clusters on OpenStack and AWS with RKE2, k0s or kubeadm, from forms with a preview of
every change instead of hand-written YAML.

## Why

Cluster API manages Kubernetes clusters declaratively, but getting started is hard: a management
cluster with cert-manager, the CAPI Operator and several providers, credentials in the format each
provider expects, and a dozen interlinked resources per cluster (`Cluster`, infrastructure cluster,
control plane, machine templates, bootstrap templates, MachineDeployments) whose fields change
between provider releases. Day-2 operations such as upgrades or image changes need template
rotation, and mistakes show up only when machines fail to boot.

CAPI Navigator is a **showcase and entry point** that makes these concepts visible, and a practical
option for **small fleets** (up to about 50 workload clusters per management cluster). It is not a
competitor to Rancher or other platforms.

Everything the app creates for workload clusters is **standard upstream Cluster API**: clusters
stay manageable with `kubectl`, `clusterctl` and other CAPI tools, even after the app is
uninstalled. The app keeps no database; its own state lives in the home cluster as custom
resources, Secrets and ConfigMaps.

### Supported infrastructure and distributions

|                        | Status                                              | Notes                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenStack (CAPO + ORC) | Tested on Infomaniak Public Cloud and Kolla-Ansible | Cloud controller manager and Cinder CSI as presets; bastion host; custom CA for the identity API                                                                                      |
| AWS (CAPA)             | Tested                                              | AWS cloud controller manager and EBS CSI as presets; dedicated VPC per cluster                                                                                                        |
| RKE2                   | Default distribution                                | All day-2 operations                                                                                                                                                                  |
| k0s (k0smotron)        | Supported                                           | Control plane upgrades run in place; control plane image changes are blocked until k0smotron replaces controllers safely ([ADR-0013](docs/adr/0013-k0s-control-plane-replacement.md)) |
| kubeadm                | Experimental                                        | Installed at first boot on stock Ubuntu, Debian or Rocky/Alma images; Calico via ClusterResourceSet ([ADR-0014](docs/adr/0014-kubeadm-on-stock-images.md))                            |

All distributions use Calico with VXLAN as CNI and run on unmodified cloud images.

## Features

- **Management clusters**: connect by kubeconfig or service account token; an access manifest
  with full or minimal permissions is downloadable. Connection health is checked continuously.
- **Providers**: install, upgrade and remove CAPI providers through the CAPI Operator, with the
  generated YAML shown before applying, and ORC for OpenStack. Shows which clusters use a provider.
- **Credentials**: OpenStack `clouds.yaml` (application credential or password, custom CA) and AWS
  access keys, tested against the cloud (services, IAM prerequisites, paging quirks) and used for
  the selection lists of the wizard. Secrets are never sent to the browser.
- **Cluster wizard**: topology (standard or all-in-one), machine sizes, images, root disks, worker
  pools with labels, add-ons, node customization (files, pre/post commands), bastion host, network
  ranges. Every field explains its default and the CAPI field it maps to.
- **Preview before apply**: every change shows the generated objects and a diff, runs as a server
  dry run, reports changes made outside the app as drift, and is applied by server-side apply.
- **Day-2 operations**: scale, change machine size or image, edit node customization, add and
  remove pools, rebuild nodes, upgrade Kubernetes (control plane first, then workers), with a
  rollout plan and one rollout at a time. Machine-affecting changes create new templates instead of
  editing existing ones.
- **Visibility**: live cluster list and status, resource tree, machines with images and addresses,
  events, read-only YAML of every resource, and a dashboard with nodes, workloads, services,
  ingresses and resource usage of the workload cluster.
- **Helm add-ons** via the Cluster API Add-on Provider for Helm (CAAPH): Helm repositories (HTTP
  and private OCI), chart browser with default values, add-ons assigned to clusters by label,
  release status per cluster, editable CCM/CSI presets and the kured reboot daemon.
- **Node shell**: a root shell on any node through a temporary privileged pod (operators for
  workload clusters, admins for the management cluster).
- **Kubeconfig**: view and download the admin kubeconfig of a workload cluster (audited).
- **Deletion** with cleanup of load balancers and volumes inside the cluster first, so nothing is
  left in the cloud.
- **Users and roles**: built-in roles viewer, operator and admin plus custom roles from 14
  permissions; role assignments can be limited to management cluster connections and namespaces
  (e.g. operator only in `team-a`). Enforced in the backend; every change is written
  to an audit log.
- Light and dark theme, live updates via server-sent events.

## Architecture

```
Browser (Vue 3 SPA)  ──REST + SSE──▶  NestJS backend  ──Kubernetes API──▶  Management cluster
                                       │                                    ├─ cert-manager
                                       │ own state (CRDs, Secrets,          ├─ CAPI Operator
                                       │ ConfigMaps) in the home cluster    └─ Providers: core, RKE2 / k0s / kubeadm,
                                       │                                       CAPO + ORC, CAPA, CAAPH
                                       ▼                                              │
                                   Transformation                                     ▼
                                   cluster spec → CAPI YAML                 OpenStack / AWS: workload clusters
                                   (pure functions)                         on stock cloud images
```

- Only the backend talks to Kubernetes; the browser never sees cluster credentials.
- A cluster is described by a **cluster spec** (stored as an annotation on the CAPI `Cluster`).
  Pure functions translate it into CAPI resources; providers and distributions are plugins.
- The **home cluster** holds the app's own state. It can also be one of the management clusters.

See [docs/architecture.md](docs/architecture.md) for how the parts work together: which
resources the app writes, which controllers act on them, and the main flows step by step.

## Quick start

### Local development with kind

Prerequisites: Node.js 24 (`.nvmrc`), pnpm via corepack (`corepack enable`), Docker, kind,
kubectl, Helm.

```sh
git clone https://github.com/alirionx/capi-navigator.git
cd capi-navigator
pnpm install
pnpm kind:up        # kind cluster "capi-navigator" with cert-manager and the CAPI Operator
pnpm dev            # backend on :3000, frontend on http://localhost:5173
```

The scripts always use `.kube/kind-capi-navigator.yaml` and ignore any `KUBECONFIG` in your shell,
so a real cluster is never touched by accident. `pnpm kind:down` deletes the cluster.

On first start the backend creates the user `admin`; the password must be changed at first sign-in.
Set `INITIAL_ADMIN_PASSWORD` in `.env.local` (see `.env.example`) before the first start, or read the
generated one:

```sh
kubectl --kubeconfig .kube/kind-capi-navigator.yaml -n capi-navigator-system \
  get secret capi-navigator-initial-admin -o jsonpath='{.data.password}' | base64 -d
```

### Install into a cluster with Helm

Every release publishes the image `ghcr.io/alirionx/capi-navigator:<version>` and attaches the
packaged chart to the [GitHub release](https://github.com/alirionx/capi-navigator/releases):

```sh
VERSION=0.2.0
helm install capi-navigator \
  https://github.com/alirionx/capi-navigator/releases/download/v${VERSION}/capi-navigator-${VERSION}.tgz \
  -n capi-navigator-system --create-namespace \
  --set homeClusterAsManagementCluster=true   # optional: use this cluster as management cluster
kubectl -n capi-navigator-system port-forward svc/capi-navigator 8080:80
```

The chart uses the image of its own version by default. To run a local build instead (for kind):

```sh
docker build -t capi-navigator:dev .
kind load docker-image capi-navigator:dev --name capi-navigator
helm install capi-navigator deploy/helm/capi-navigator \
  -n capi-navigator-system --create-namespace \
  --set image.repository=capi-navigator --set image.tag=dev
```

The chart installs the app's CRDs, RBAC and one replica. The initial admin password is read from
the Secret `capi-navigator-initial-admin` (key `password`) in the release namespace, or generated
there on first start.

### Exposing the app

The chart always creates a Service; an Ingress and a Gateway API `HTTPRoute` are optional and can
be combined with it and with each other:

| Option            | Values                                                                                                                                                                                                                                          | Notes                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Service           | `service.type` (`ClusterIP`, `NodePort`, `LoadBalancer`), `service.port`, `service.annotations`, `service.nodePort`, `service.externalTrafficPolicy`, `service.loadBalancerClass`, `service.loadBalancerIP`, `service.loadBalancerSourceRanges` | Annotations configure the cloud load balancer, e.g. Octavia or AWS NLB settings      |
| Ingress           | `ingress.enabled`, `ingress.className`, `ingress.annotations`, `ingress.hosts`, `ingress.path`, `ingress.pathType`, `ingress.tls`                                                                                                               | `networking.k8s.io/v1`; at least one host                                            |
| HTTPRoute         | `httpRoute.enabled`, `httpRoute.parentRefs`, `httpRoute.hostnames`, `httpRoute.path`, `httpRoute.timeouts`, `httpRoute.annotations`                                                                                                             | `gateway.networking.k8s.io/v1`; needs an existing Gateway (at least one `parentRef`) |
| Proxy and cookies | `trustProxy`, `auth.cookieSecure`                                                                                                                                                                                                               | See below                                                                            |

```yaml
# values-ingress.yaml: Ingress with TLS from cert-manager
ingress:
  enabled: true
  className: traefik
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  hosts: [capi-navigator.example.com]
  tls:
    - secretName: capi-navigator-tls
      hosts: [capi-navigator.example.com]
```

```yaml
# values-gateway.yaml: HTTPRoute on a shared Gateway that terminates TLS
httpRoute:
  enabled: true
  parentRefs:
    - name: shared-gateway
      namespace: gateway-system
      sectionName: https
  hostnames: [capi-navigator.example.com]
```

```yaml
# values-lb.yaml: cloud load balancer, restricted to an admin network
service:
  type: LoadBalancer
  loadBalancerSourceRanges: [203.0.113.0/24]
```

- **TLS:** sessions use Secure cookies, which browsers store only over HTTPS (or on `localhost`, as
  with `port-forward`). Terminate TLS at the Ingress, the Gateway or the load balancer. Only for
  plain-HTTP test setups, e.g. a LoadBalancer without TLS, set `auth.cookieSecure=false`.
- **Client IPs:** with the Ingress or HTTPRoute enabled, the chart trusts `X-Forwarded-For` from
  private addresses (`trustProxy` defaults to `loopback,linklocal,uniquelocal`), so the login rate
  limit sees the real client. Set `trustProxy` explicitly for other setups (Express "trust proxy"
  syntax).
- **Live updates** use server-sent events (long-lived HTTP responses). The app disables proxy
  buffering (`X-Accel-Buffering: no`); if a gateway cuts the stream after a fixed time, raise its
  timeout, e.g. `httpRoute.timeouts.request: 0s` where supported.

> [!IMPORTANT]
> The app manages clusters and stores cloud credentials. Expose it only via HTTPS (sessions use
> Secure cookies) and give the admin role, or any role with `users.manage`, to few people: they can
> grant every permission, install providers and open root shells on management cluster nodes;
> operators open root shells on workload cluster nodes.

## Using the app

1. **Connections**: add the management cluster (the kind cluster as **Home cluster**, or another
   cluster with the access manifest from `deploy/management-cluster/` and its service account
   token).
2. **Providers**: install ORC (for OpenStack) and the providers from the catalog: core, the
   bootstrap and control plane providers of your distribution, CAPO and/or CAPA, and CAAPH.
3. **Credentials**: upload the `clouds.yaml` of an OpenStack application credential or enter an AWS
   access key; run the test.
4. **Clusters → Create cluster**: walk through the wizard, check the preview and create. The
   resource tree and the events show the progress; the cluster is ready after a few minutes.
5. **Day-2**: the tabs of a cluster offer configuration changes (always with preview), the
   dashboard, the node shell, add-ons and the YAML of every resource.
6. **Add-ons**: add Helm repositories (admins), then create add-ons that select clusters by label.
7. **Users and roles**: create users and give them role assignments, everywhere or limited to
   connections and namespaces (e.g. operator in `team-a`); custom roles are combined from 14
   permissions on the **Roles** page. Every user can read everything; limits apply to actions.

## Where configuration lives

| What                                                                                                                                                    | Where                                                                                                                                            | When it is set                 | Who changes it                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------- |
| Catalogs and defaults: provider versions, Kubernetes versions, add-on presets (charts, versions), Calico version and checksum, containerd/runc versions | `packages/shared/src/catalog/`, `packages/shared/src/cluster/` (e.g. `addons.ts`, `kubeadm.ts`, `cni.ts`)                                        | At build time, per app version | Developers (later Renovate via a central `versions.yaml`, FP-20) |
| Schemas and types (cluster spec, API requests, CRDs), all as Zod                                                                                        | `packages/shared/src/`                                                                                                                           | At build time                  | Developers                                                       |
| Operation of the backend: app namespace, node shell image, port, sessions, initial admin                                                                | Environment variables, validated in `apps/backend/src/config/config.ts`; set through the Helm values in `deploy/helm/capi-navigator/values.yaml` | At deployment                  | Operators (Helm)                                                 |
| Runtime settings: preset overrides, Helm repositories, connections, credentials, users, roles                                                           | ConfigMaps, custom resources and Secrets in the home cluster                                                                                     | During operation, in the UI    | Users with the matching permission                               |
| Large backend-only artifacts: Calico manifest                                                                                                           | `apps/backend/assets/`                                                                                                                           | At build time                  | Developers                                                       |
| UI texts                                                                                                                                                | `apps/frontend/src/i18n/`                                                                                                                        | At build time                  | Developers                                                       |

Versions and domain defaults live in code because each app version is tested with them; values
that differ per installation are deployment settings; what admins change while the app runs is
stored in the home cluster (the app has no database).

### Environment variables

| Variable                                        | Default                 | Description                                                                        |
| ----------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `PORT`, `HOST`                                  | `3000`, `0.0.0.0`       | Listen address of the backend                                                      |
| `NAVIGATOR_NAMESPACE`                           | `capi-navigator-system` | Namespace of the app's own state in the home cluster                               |
| `STATIC_DIR`                                    | –                       | Serve the built frontend from this directory (set in the image)                    |
| `INITIAL_ADMIN_PASSWORD`                        | –                       | Password of the initial admin; otherwise the Secret `capi-navigator-initial-admin` |
| `SESSION_TTL_HOURS`                             | `8`                     | Absolute session lifetime                                                          |
| `COOKIE_SECURE`                                 | `true`                  | Secure flag of the session cookie                                                  |
| `TRUST_PROXY`                                   | `loopback`              | Express trust proxy setting, needed behind an ingress                              |
| `LOGIN_RATE_LIMIT`, `LOGIN_RATE_WINDOW_MINUTES` | `10`, `15`              | Failed logins per client and user within the window                                |
| `AUDIT_RETENTION_DAYS`                          | `90`                    | Retention of audit events                                                          |
| `NODE_SHELL_IMAGE`                              | `alpine:3.22`           | Image of the node shell pod, e.g. a registry mirror                                |
| `LOG_LEVEL`, `LOG_JSON`                         | `log`, `true`           | Log level; JSON logs by default                                                    |
| `POD_NAME`                                      | host name               | Identity of the replica for leader election                                        |
| `KUBECONFIG`                                    | in-cluster              | Access to the home cluster in local development                                    |

## Technology

| Area              | Technology                                                                                                                                                                              | Why                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Backend           | Node.js 24, [NestJS](https://nestjs.com), [@kubernetes/client-node](https://github.com/kubernetes-client/javascript)                                                                    | Modules per domain, guards for permissions, watches and server-side apply against the Kubernetes API |
| Frontend          | [Vue 3](https://vuejs.org), [Vite](https://vite.dev), [Pinia](https://pinia.vuejs.org), [Vuetify 3](https://vuetifyjs.com), [Monaco Editor](https://microsoft.github.io/monaco-editor/) | Accessible components with light/dark themes; read-only YAML views and the Helm values editor        |
| Shared model      | TypeScript (strict), [Zod](https://zod.dev)                                                                                                                                             | One schema per entity for form validation, API validation, types and the CRDs' OpenAPI schemas       |
| Transformation    | Pure functions in `packages/shared`                                                                                                                                                     | Same spec, byte-identical YAML; every topology and distribution has snapshot tests                   |
| State             | CRDs (`navigator.capi-navigator.io/v1alpha1`), Secrets and ConfigMaps in the home cluster                                                                                               | No database; the backend stays stateless                                                             |
| Live updates      | Kubernetes watches → server-sent events                                                                                                                                                 | Lists and status update without polling                                                              |
| Cluster lifecycle | Cluster API, CAPI Operator, CAPO + ORC, CAPA, RKE2/k0smotron/kubeadm providers, CAAPH                                                                                                   | Upstream only; clusters stay manageable without the app                                              |
| Container         | Multi-stage build on `node:24-bookworm-slim`, non-root                                                                                                                                  | One image serves API and frontend                                                                    |
| Tests             | Vitest (unit, snapshot), Playwright (end-to-end), kind (integration)                                                                                                                    | From pure transformations to the UI against a real management cluster                                |

## Development

### Commands

| What                                                                                                                                  | Command                                    |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Install all workspaces                                                                                                                | `pnpm install`                             |
| Backend and frontend in watch mode                                                                                                    | `pnpm dev`                                 |
| Lint and format check                                                                                                                 | `pnpm lint`                                |
| Type check                                                                                                                            | `pnpm typecheck`                           |
| Unit and snapshot tests                                                                                                               | `pnpm test`                                |
| Backend unit tests with the coverage threshold (70 % lines, as in CI)                                                                 | `pnpm test:coverage`                       |
| Integration tests against kind (own throwaway namespace; opt-in read-only cloud tests with `OPENSTACK_CLOUDS_YAML=…` or `AWS_LIVE_*`) | `pnpm test:int`                            |
| End-to-end tests (first time: `pnpm exec playwright install chromium`; with `E2E_ADMIN_PASSWORD=…`)                                   | `pnpm test:e2e`                            |
| kind cluster as home and management cluster                                                                                           | `pnpm kind:up` / `pnpm kind:down`          |
| Regenerate / install the app's CRDs from the Zod schemas                                                                              | `pnpm crds:generate` / `pnpm crds:install` |
| Container image                                                                                                                       | `docker build -t capi-navigator .`         |

### Repository layout

```
apps/backend/       NestJS backend: modules per domain, Kubernetes access, plugins, tests
apps/frontend/      Vue 3 app: views, components, Pinia stores, i18n
packages/shared/    Zod schemas, catalogs, transformation (cluster spec → CAPI YAML), presets
deploy/helm/        Helm chart incl. CRDs
deploy/crds/        Generated CRDs of the app
deploy/management-cluster/  Access manifests for management clusters (full and minimal)
docs/               Requirements specification, architecture overview, architecture decisions (ADRs)
e2e/                Playwright end-to-end tests
scripts/            kind, development and integration test helpers
```

### Releases

CI ([ci.yaml](.github/workflows/ci.yaml)) runs lint, type check, tests, the Helm chart check,
the integration tests on kind and an image build for every push to `main` and every pull request.

A release is triggered by a version tag ([release.yaml](.github/workflows/release.yaml)):

1. Set `version` and `appVersion` in `deploy/helm/capi-navigator/Chart.yaml` to the new version
   and commit.
2. `git tag v0.2.0 && git push origin v0.2.0`

The workflow checks that the tag matches `Chart.yaml`, pushes the image
`ghcr.io/alirionx/capi-navigator` with the tags `0.2.0`, `0.2` and `latest`, and creates the
GitHub release with `capi-navigator-0.2.0.tgz` and its SHA-256 checksum.

## Contributing

The project is driven by a requirements specification, one feature pack at a time:

- [docs/requirements.md](docs/requirements.md) is the binding specification. Every requirement has
  a stable ID (`FP5-F-09`, `NF-13`, …). Planned work is listed in its outlook section.
- Decisions that refine or deviate from it are recorded as ADRs in [docs/adr/](docs/adr/).
- Reference requirement IDs in commit messages, tests and code comments; use conventional commits,
  e.g. `feat(fp5): generate RKE2ControlPlane from cluster spec (FP5-F-01)`.
- Hard rules: no database; one Zod schema per entity; pure transformations with snapshot tests;
  the cluster spec is the source of truth; template rotation instead of editing templates; preview
  before every change; only upstream resources for workload clusters; secrets never leave the
  backend; permissions enforced in the backend; providers and distributions as plugins. See
  [CLAUDE.md](CLAUDE.md) for the details.
- English everywhere: UI, API messages, logs, documentation and code comments.
- Never commit secrets, `clouds.yaml` files, kubeconfigs or tokens.

Before opening a pull request, run `pnpm lint`, `pnpm typecheck`, `pnpm test` and
`pnpm test:coverage` (backend line coverage at least 70 %), and for UI
changes the end-to-end tests. npm dependencies are kept current by Renovate (`renovate.json`).

## License

No license has been chosen yet.
