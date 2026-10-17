# CAPI Navigator

A lean web UI for [Cluster API](https://cluster-api.sigs.k8s.io/). See
[docs/requirements.md](docs/requirements.md) for the full specification.

## Prerequisites

Node.js 24 (`.nvmrc`), pnpm via corepack (`corepack enable`), Docker, kind, kubectl, Helm.

## Local development

```bash
pnpm install
pnpm kind:up        # kind cluster "capi-navigator" + cert-manager + CAPI Operator
                    # (--bare: cluster only, without cert-manager and operator)
pnpm dev            # backend on :3000, frontend on http://localhost:5173
```

The scripts always use `.kube/kind-capi-navigator.yaml` and ignore any `KUBECONFIG` set in your
shell, so a real cluster is never touched by accident. `pnpm kind:down` deletes the cluster.

### First sign-in

On first start the backend creates the user `admin` (you must change the password at first
sign-in). Either set `INITIAL_ADMIN_PASSWORD` in `.env.local` (see `.env.example`) before the first
start, or read the generated password:

```bash
kubectl --kubeconfig .kube/kind-capi-navigator.yaml -n capi-navigator-system \
  get secret capi-navigator-initial-admin -o jsonpath='{.data.password}' | base64 -d
```

### Connect a management cluster

Under **Connections**, add the kind cluster as **Home cluster** (uses the backend's own access) or
upload `.kube/kind-capi-navigator.yaml` as **Kubeconfig**. For other clusters, apply the access
manifest there (`deploy/management-cluster/capi-navigator-access.yaml`, also downloadable in the
UI) and connect with its service account **Token**. Kubeconfigs with exec plugins or file
references are rejected for security reasons.

### Install providers

Under **Providers** (for the management cluster selected in the app bar) the app shows whether
cert-manager, the CAPI Operator and ORC are ready, with install commands if not. Install ORC and
then the providers from the catalog: every install or upgrade shows the generated YAML first and
is applied only after confirmation. Status updates arrive live.

### Add cloud credentials

Under **Credentials**, add OpenStack credentials (upload the `clouds.yaml` of an application
credential) or AWS credentials (access key of a dedicated IAM user). They are stored once on the
management cluster as Secret plus `OpenStackClusterIdentity` / `AWSClusterStaticIdentity`
(ADR-0002), tested, and used for the selection lists of the cluster wizard. For AWS, the test
checks the CAPA IAM prerequisites and shows the `clusterawsadm` command if they are missing.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test           # Vitest unit and snapshot tests
pnpm test:int       # integration tests against the kind cluster (own throwaway namespace)
pnpm test:e2e       # Playwright (first time: pnpm exec playwright install chromium);
                    # the login flow runs with E2E_ADMIN_PASSWORD=<admin password>
docker build -t capi-navigator .
```
