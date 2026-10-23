# CLAUDE.md – CAPI Navigator

This file tells Claude Code how to work in this repository. Read it fully before every session.

## What this project is

CAPI Navigator is a lean web UI for Cluster API (CAPI). It is a showcase and entry point that helps DevOps engineers and SREs understand how Cluster API works, and a practical option for small cluster fleets (up to about 50 workload clusters per management cluster). It is **not** a competitor to Rancher or other commercial platforms.

Everything the app creates for workload clusters is standard upstream Cluster API, so clusters remain manageable with `kubectl`, `clusterctl` and other CAPI-aware tools, even after the app is uninstalled.

## Source of truth

- **Requirements:** `docs/requirements.md` – the full requirements specification (feature packs FP-0 to FP-10 plus the optional packs FP-14, FP-17 to FP-20, FP-22, FP-23, FP-25, FP-26, FP-30 and FP-31, outlook FP-11 to FP-21, FP-24 and FP-27 to FP-29, non-functional requirements, decisions). Always follow it.
- **Architecture overview:** `docs/architecture.md` – how the parts work together (explanatory; keep it current when flows change).
- **Architecture decisions:** `docs/adr/` – one short ADR per decision that deviates from or refines the requirements.
- If this file and `docs/requirements.md` disagree, `docs/requirements.md` wins. Point out the conflict instead of guessing.

## How to work: one feature pack at a time

1. Find the current feature pack in the status table below. Never start the next pack before the current one is done.
2. Before starting a pack, read in `docs/requirements.md`: section 4 (architecture), section 5 (cluster spec and transformation), and the pack's own section.
3. Make a short plan for the pack and confirm it with the user before writing larger amounts of code.
4. Implement in small, reviewable commits. Write tests alongside the code; for transformations, write the snapshot test first.
5. A pack is done only when all MUST acceptance criteria are met and `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:coverage` pass.
6. Tick the acceptance criteria in `docs/requirements.md`, update the status table below, and summarize what was done and what was deferred.

### Feature pack status

| Pack | Content | Status |
| --- | --- | --- |
| FP-0 | Project scaffold | done |
| FP-1 | Authentication and authorization (local users) | done |
| FP-2 | Management cluster connections (kubeconfig, service account token) | done |
| FP-3 | CAPI Operator, ORC and provider management | done |
| FP-4 | Provider credentials: OpenStack (`clouds.yaml`) and AWS (`AWSClusterStaticIdentity`) | done |
| FP-5 | Create workload clusters: OpenStack and AWS + RKE2 | done |
| FP-6 | Cluster lifecycle and visualization | done |
| FP-7 | Live YAML view (read-only) and day-2 operations | done |
| FP-8 | Helm add-ons via CAAPH | done |
| FP-9 | k0s as second Kubernetes distribution | done (control plane rebuild for one node only with k0smotron v2.3.0, ADR-0013) |
| FP-10 | kubeadm on stock images (experimental) | done |
| FP-19 | Role management: custom roles, scoped role assignments (optional) | done |
| FP-20 | Version maintenance: versions.yaml and update report (optional) | done |
| FP-22 | API tokens for technical users (optional) | done |
| FP-23 | OpenAPI description and Swagger UI (optional) | done |
| FP-14 | Sign-in with an OpenID Connect provider (optional) | done |
| FP-25 | Google Cloud as third infrastructure provider (optional) | done |
| FP-26 | All-in-one clusters with three or five nodes (optional) | done |
| FP-17 | Node shell via privileged pod (pulled forward) | done |
| FP-18 | Read-only cluster dashboard (pulled forward) | done |
| FP-30 | Manifest add-ons through CAAPH (optional) | done |
| FP-31 | Proxmox VE as infrastructure provider (optional) | in progress |

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
9. **Permissions are enforced in the backend.** Every endpoint declares a permission (`@Requires`, FP-19); a NestJS guard checks it against the user's role assignments in the scope of the request. The built-in roles viewer, operator and admin keep their FP-1 access (pinned by a test). Frontend hiding is only cosmetic. Every mutating action writes an `AuditEvent`.
10. **Plugins, not special cases.** Infrastructure providers implement `InfraProviderPlugin`, Kubernetes distributions implement `BootstrapFlavorPlugin` (see section 5 of the requirements). Do not hard-code OpenStack or RKE2 logic into generic modules.

## Verify, don't guess

CRD fields and API versions of Cluster API, the CAPI Operator, CAPO, ORC, the RKE2 provider, k0smotron and CAAPH change between releases. Before generating any of these resources:

- Check the current official documentation or the provider's CRD definitions.
- Never rely on remembered field names.
- Record the versions you verified against in `versions.yaml` (with `verified` date and notes), never as a second copy in code; see `docs/maintenance.md`.

If something in the requirements turns out to be technically wrong for the current provider versions, stop, explain the issue, and propose an ADR instead of working around it silently.

## Commands

Set these up in FP-0 and keep them working:

```bash
pnpm install          # install all workspaces
pnpm dev              # start backend and frontend in watch mode
pnpm lint             # ESLint + Prettier check
pnpm typecheck        # tsc --noEmit for all workspaces
pnpm test             # Vitest (unit + snapshot)
pnpm test:coverage    # backend unit tests with the 70 % line coverage threshold (NF-15), as in CI
pnpm test:int         # Vitest integration tests against the kind cluster; opt-in read-only cloud tests
                      # with OPENSTACK_CLOUDS_YAML=… or AWS_LIVE_ACCESS_KEY_ID/…SECRET_ACCESS_KEY/…REGION
pnpm test:e2e         # Playwright
pnpm docs:screenshots # screenshots for docs/ui-tour.md against the running app (read-only)
pnpm kind:up          # local kind cluster as home + management cluster
pnpm dex:up           # Dex with test users as OIDC provider in kind; configures the app's sign-in (FP-14)
pnpm crds:generate    # regenerate deploy/crds from the Zod schemas in packages/shared
pnpm openapi:generate # regenerate docs/api/openapi.json from the routes and Zod schemas (FP-23)
pnpm versions:generate   # regenerate the pinned versions from versions.yaml (FP-20)
pnpm templates:generate  # regenerate the node script templates (kubeadm install script)
pnpm versions:report     # newer versions of versions.yaml, Actions and Docker → docs/versions-report.md
pnpm crds:install     # install the app's CRDs into the current cluster
pnpm secrets:scan     # gitleaks (Docker) over the Git history and the working tree; run before pushing
pnpm notices:generate # third-party notices and license gate (scripts/third-party-notices.mjs)
```

The backend uses `KUBECONFIG` for the home cluster in local development.

## Conventions

- Code, comments, commit messages, UI strings and docs are in **English**. UI texts go through vue-i18n; the MVP ships English only (no German), further languages may follow later.
- Requirement IDs (e.g. `FP5-F-09`, `NF-13`, `POS-02`) go into commit messages, test names and code comments where a piece of code implements a specific requirement.
- Every endpoint carries `@Api({ summary, response })` (FP-23); run `pnpm openapi:generate` after API changes.
- Conventional commits: `feat(fp5): generate RKE2ControlPlane from cluster spec (FP5-F-01)`.
- One NestJS module per domain, one Pinia store per domain.
- Every form field has short help text including its default value, and in learn mode shows which CAPI resource and field it maps to (POS-04).
- Error messages from the Kubernetes API are translated into understandable messages with a hint; the original error stays expandable.

## Safety while working

- Do not create, change or delete resources on a real cloud (Infomaniak, AWS) or a real management cluster without asking the user first. This includes using the locally configured AWS CLI credentials. Use kind and dry runs (`dryRun=All`) by default.
- Integration tests on kind must never remove what they did not install themselves (the user may have installed providers via the UI).
- Never commit secrets, `clouds.yaml` files, kubeconfigs or tokens. Keep `.gitignore` and test fixtures free of real credentials.
- Node customization runs arbitrary commands as root on nodes. Treat it as security-sensitive in code and UI.

## Definition of done for every pack

- [ ] All MUST acceptance criteria of the pack are met and ticked in `docs/requirements.md`.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:coverage` pass (backend line coverage ≥ 70 %, NF-15).
- [ ] New transformations have snapshot tests.
- [ ] No hard rule above is violated.
- [ ] Deviations are documented as ADRs in `docs/adr/`.
- [ ] The status table in this file is updated.
