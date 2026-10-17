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
