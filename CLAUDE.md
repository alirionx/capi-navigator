# CLAUDE.md – CAPI Navigator

This file tells Claude Code how to work in this repository. Read it fully before every session.

## What this project is

CAPI Navigator is a lean web UI for Cluster API (CAPI). It is a showcase and entry point that helps DevOps engineers and SREs understand how Cluster API works, and a practical option for small cluster fleets (up to about 50 workload clusters per management cluster). It is **not** a competitor to Rancher or other commercial platforms.

Everything the app creates for workload clusters is standard upstream Cluster API, so clusters remain manageable with `kubectl`, `clusterctl` and other CAPI-aware tools, even after the app is uninstalled.

## Source of truth

- **Requirements:** `docs/requirements.md` – the full requirements specification (feature packs FP-0 to FP-10, non-functional requirements, decisions). Always follow it.
- **Architecture decisions:** `docs/adr/` – one short ADR per decision that deviates from or refines the requirements.
- If this file and `docs/requirements.md` disagree, `docs/requirements.md` wins. Point out the conflict instead of guessing.

## How to work: one feature pack at a time

1. Find the current feature pack in the status table below. Never start the next pack before the current one is done.
2. Before starting a pack, read in `docs/requirements.md`: section 4 (architecture), section 5 (cluster spec and transformation), and the pack's own section.
3. Make a short plan for the pack and confirm it with the user before writing larger amounts of code.
4. Implement in small, reviewable commits. Write tests alongside the code; for transformations, write the snapshot test first.
5. A pack is done only when all MUST acceptance criteria are met and `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
6. Tick the acceptance criteria in `docs/requirements.md`, update the status table below, and summarize what was done and what was deferred.

### Feature pack status

| Pack | Content | Status |
| --- | --- | --- |
| FP-0 | Project scaffold | done |
| FP-1 | Authentication and authorization (local users) | next |
| FP-2 | Management cluster connections (kubeconfig, service account token) | open |
| FP-3 | CAPI Operator, ORC and provider management | open |
| FP-4 | OpenStack credentials (`clouds.yaml`) | open |
| FP-5 | Create workload clusters: OpenStack + RKE2 | open |
| FP-6 | Cluster lifecycle and visualization | open |
| FP-7 | Live YAML view (read-only) and day-2 operations | open |
| FP-8 | Helm add-ons via CAAPH | open |
| FP-9 | k0s as second Kubernetes distribution | open |
| FP-10 | kubeadm on stock images (experimental) | open |

MVP = FP-0 to FP-5. Recommended order after that: FP-7 before FP-8.

## Architecture in short

```
Browser (Vue 3 SPA)  ──REST + SSE──▶  NestJS backend  ──Kubernetes API──▶  Management cluster
                                       │                                    ├─ cert-manager
                                       │ own state (CRDs, Secrets,          ├─ CAPI Operator
                                       │ ConfigMaps) in the home cluster    └─ Providers: core, RKE2 / k0s / kubeadm,
                                       │                                       CAPO + ORC, CAAPH
                                       │                                              │
                                       ▼                                              ▼
                                   Transformation                           OpenStack (Infomaniak):
                                   cluster spec → CAPI YAML                 workload clusters on stock cloud
                                   (pure functions)                         images, CCM + Cinder CSI via CAAPH
```

- Only the backend talks to Kubernetes. The browser never sees cluster credentials.
- Monorepo with pnpm workspaces: `apps/backend` (NestJS), `apps/frontend` (Vue 3 + Vuetify), `packages/shared` (Zod schemas, types, provider and version catalogs), `deploy/` (CRDs, Helm chart).

## Tech stack

- TypeScript (strict) everywhere. No plain JavaScript files in `src/`.
- Backend: NestJS, Node.js 24 LTS, `@kubernetes/client-node`.
- Frontend: Vue 3 (Composition API, `<script setup>`), Vite, Pinia, Vue Router, Vuetify 3, Monaco Editor (`monaco-yaml`) for read-only YAML views and Helm values.
- Validation: Zod, shared by backend and frontend.
- YAML: `yaml` (npm).
- Tests: Vitest (unit, snapshot), Playwright (E2E), kind (integration).
- Live updates: server-sent events fed by Kubernetes watches and informers.

Do not add new frameworks or large dependencies without asking. The goal is a lean stack.

## Hard rules

These come from the requirements and must not be broken:

1. **No database.** All app state lives in the home cluster as CRDs (API group `navigator.capi-navigator.io/v1alpha1`), Secrets and ConfigMaps. No SQLite, no local files. The backend must stay stateless.
2. **Single source of truth for types.** Define every schema once as Zod in `packages/shared` and derive TypeScript types, form validation, API validation and CRD OpenAPI schemas from it. Never duplicate types in frontend or backend.
3. **Pure transformations.** `transform(spec) → KubernetesObject[]` has no I/O and no cluster access. Same input, byte-identical YAML. Every topology and flavor has a snapshot test.
4. **The cluster spec is the source of truth.** All changes go through forms that update the stored spec (annotation on the CAPI `Cluster`), then regenerate and apply. YAML is read-only in the UI. Changes made outside the app are shown as drift, never silently overwritten.
5. **Template rotation, never in-place template edits.** Any change that affects machines (version, flavor, image, node customization, rebuild) creates new machine and bootstrap templates with new names and switches the references. Never modify an existing template.
6. **Preview before apply.** Every mutating action shows the generated YAML or diff first and applies only after confirmation, via server-side apply with field manager `capi-navigator`.
7. **Stay upstream and removable.** Create only standard upstream resources for workload clusters. Never set owner references or finalizers from app resources on CAPI resources. Use only neutral labels and annotations under `capi-navigator.io/`.
8. **Secrets stay secret.** Credentials (passwords, kubeconfigs, tokens, `clouds.yaml`, registry credentials) live only in Kubernetes Secrets and never appear in logs, API responses or the frontend.
9. **Roles are enforced in the backend.** Viewer, operator and admin are checked by a NestJS guard on every endpoint. Frontend hiding is only cosmetic. Every mutating action writes an `AuditEvent`.
10. **Plugins, not special cases.** Infrastructure providers implement `InfraProviderPlugin`, Kubernetes distributions implement `BootstrapFlavorPlugin` (see section 5 of the requirements). Do not hard-code OpenStack or RKE2 logic into generic modules.

## Verify, don't guess

CRD fields and API versions of Cluster API, the CAPI Operator, CAPO, ORC, the RKE2 provider, k0smotron and CAAPH change between releases. Before generating any of these resources:

- Check the current official documentation or the provider's CRD definitions.
- Never rely on remembered field names.
- Record the provider versions you verified against in the provider and version catalogs in `packages/shared`.

If something in the requirements turns out to be technically wrong for the current provider versions, stop, explain the issue, and propose an ADR instead of working around it silently.

## Commands

Set these up in FP-0 and keep them working:

```bash
pnpm install          # install all workspaces
pnpm dev              # start backend and frontend in watch mode
pnpm lint             # ESLint + Prettier check
pnpm typecheck        # tsc --noEmit for all workspaces
pnpm test             # Vitest (unit + snapshot)
pnpm test:e2e         # Playwright
pnpm kind:up          # local kind cluster as home + management cluster
pnpm crds:install     # install the app's CRDs into the current cluster
```

The backend uses `KUBECONFIG` for the home cluster in local development.

## Conventions

- Code, comments, commit messages, UI strings and docs are in **English**. UI texts go through vue-i18n; the MVP ships English only (no German), further languages may follow later.
- Requirement IDs (e.g. `FP5-F-09`, `NF-13`, `POS-02`) go into commit messages, test names and code comments where a piece of code implements a specific requirement.
- Conventional commits: `feat(fp5): generate RKE2ControlPlane from cluster spec (FP5-F-01)`.
- One NestJS module per domain, one Pinia store per domain.
- Every form field has short help text including its default value, and in learn mode shows which CAPI resource and field it maps to (POS-04).
- Error messages from the Kubernetes API are translated into understandable messages with a hint; the original error stays expandable.

## Safety while working

- Do not create, change or delete resources on a real cloud (Infomaniak) or a real management cluster without asking the user first. Use kind and dry runs (`dryRun=All`) by default.
- Never commit secrets, `clouds.yaml` files, kubeconfigs or tokens. Keep `.gitignore` and test fixtures free of real credentials.
- Node customization runs arbitrary commands as root on nodes. Treat it as security-sensitive in code and UI.

## Definition of done for every pack

- [ ] All MUST acceptance criteria of the pack are met and ticked in `docs/requirements.md`.
- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
- [ ] New transformations have snapshot tests.
- [ ] No hard rule above is violated.
- [ ] Deviations are documented as ADRs in `docs/adr/`.
- [ ] The status table in this file is updated.
