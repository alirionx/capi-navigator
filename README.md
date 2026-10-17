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

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test           # Vitest
pnpm test:e2e       # Playwright (first time: pnpm exec playwright install chromium)
docker build -t capi-navigator .
```
