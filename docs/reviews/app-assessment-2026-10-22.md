# CAPI Navigator – Application Assessment

- **Version assessed:** 0.8.1 (commit `d502f61`, 22 October 2026)
- **Scope:** technology stack, maintainability, security, use case, UX of the web UI, licensing
- **Method:** review of the repository (code, Helm chart, Dockerfile, CI workflows, requirements, ADRs), dependency audit (`pnpm audit --prod`), license review of all shipped packages and bundled upstream manifests, inspection of the running app in a local kind environment. No penetration test, no load test, no legal advice.
- **Perspective:** an external reviewer seeing the project for the first time.

## Summary

CAPI Navigator is a small, well-structured TypeScript application that puts a guided web UI on top of upstream Cluster API. Its strongest qualities are architectural discipline (pure transformations, one source of truth for types, no database, everything upstream and removable) and an unusually complete paper trail (1,000-line requirements document, 23 ADRs, architecture overview, maintenance guide). The stack is current and deliberately lean.

The main risks are not in the code quality but in the operating model and the surroundings:

1. **The app is a high-value target by design.** It holds credentials for management clusters and clouds, can open root shells on nodes and hands out cluster-admin kubeconfigs. A compromise of the app or of an operator account is a compromise of the fleet.
2. **Supply-chain hardening is missing** (no signed images, no SBOM, actions pinned by tag, no automated dependency updates).
3. **Single maintainer with heavy AI assistance.** The bus factor is one; parts of the code re-implement protocols (OCI registry auth, Google OAuth JWT flow, OpenStack APIs) that larger projects take from maintained libraries.
4. **Upstream churn.** The app depends on six-plus CAPI providers whose APIs and maturity differ; several known upstream issues are already worked around (ADR-0013, ADR-0022, ADR-0023).

| Area                                | Rating | In one sentence                                                                                                                              |
| ----------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Technology choice                   | ●●●●○  | Modern, mainstream and well matched to the requirements; a few hand-rolled clients.                                                          |
| Maintainability and future-proofing | ●●●○○  | Excellent internal structure and documentation, but one maintainer and a fast-moving upstream.                                               |
| Security                            | ●●●○○  | Solid application security basics; the inherent power of the app and the missing supply-chain controls need attention before production use. |
| Use case                            | ●●●●○  | A real gap between `clusterctl` and large platforms; strongest as a learning tool and for small fleets.                                      |
| UX of the web UI                    | ●●●●○  | Clear, educational wizard with preview-before-apply; some sharp edges in validation and guidance.                                            |

## 1. Technology and libraries

### Stack

| Layer                | Choice                                                                                | Assessment                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Language             | TypeScript 6.0 (strict) everywhere                                                    | Appropriate; one language across backend, frontend and shared code is the main reason the codebase stays coherent. |
| Runtime              | Node.js ≥ 24 (LTS until April 2028)                                                   | Current LTS.                                                                                                       |
| Backend              | NestJS 12.2, Express 5                                                                | Mainstream, well documented; module structure fits the domain split (one module per domain).                       |
| Kubernetes access    | `@kubernetes/client-node` 2.x, informers and watches                                  | The official client; appropriate.                                                                                  |
| Validation and types | Zod 4, shared between backend, frontend and CRD generation                            | A strong choice: one schema produces types, API validation, form rules and CRD OpenAPI schemas (hard rule 2).      |
| Frontend             | Vue 3.5 (Composition API), Vuetify 3.13, Pinia 4, Vue Router 5, vue-i18n 11           | Current and coherent; Vuetify gives a consistent admin-UI look with little custom CSS.                             |
| Editors and terminal | Monaco 0.57 (read-only YAML), xterm.js 6                                              | Standard choices; Monaco is the largest part of the bundle.                                                        |
| Auth                 | Local users (argon2id via `node:crypto`), OIDC via `openid-client` 6, API tokens      | Modern primitives, no home-made crypto for passwords.                                                              |
| Cloud SDKs           | AWS SDK v3 (EC2, IAM, STS); OpenStack and Google Cloud via own HTTP clients           | Mixed: see below.                                                                                                  |
| Tests                | Vitest (unit, snapshot), Playwright (E2E), kind (integration)                         | Current tooling.                                                                                                   |
| Packaging            | Multi-stage Docker image on `node:24-bookworm-slim`, Helm chart, OCI chart on ghcr.io | Standard.                                                                                                          |

**Size:** about 16,000 lines of backend, 15,000 lines of frontend and 7,600 lines of shared TypeScript/Vue, plus 11,000 lines of tests; 199 commits in roughly five days of history.

### Fit to the requirements

The stack matches the functional requirements well:

- **No database, all state in Kubernetes** (CRDs, Secrets, ConfigMaps) suits a tool whose whole job is Kubernetes, and makes the backend stateless and horizontally scalable (the chart supports several replicas; sessions and keys are shared through the cluster).
- **Pure transformation** from a cluster spec to CAPI manifests, with snapshot tests per provider and distribution, is the right core abstraction: it makes generated YAML reviewable and deterministic.
- **Plugin interfaces** for infrastructure providers and Kubernetes distributions are real, not decorative: the third cloud (Google Cloud) was added mostly through a new plugin, and a test enforces that the frontend contains no provider-specific branches.
- **Server-sent events** for live views are a pragmatic choice over WebSockets for one-way updates; WebSockets are used only where needed (node shell).

### Points to watch

- **Hand-rolled clients.** The app implements the OCI distribution auth flow, the Google service-account JWT exchange and parts of the Keystone, Nova and Neutron APIs itself instead of using maintained libraries. This keeps dependencies low but moves protocol edge cases into the project (the Docker Hub redirect and the GHCR 403 behaviour were both found only in practice and fixed in 0.8.1).
- **TypeScript is capped below 6.1** because of the `typescript-eslint` peer range (ADR-0001). The native TypeScript 7 compiler is already released; the project will need a migration plan once the lint tooling supports it.
- **Monaco** is heavy for a read-only YAML viewer; acceptable for an admin tool, but it is the largest frontend dependency and the source of the only current audit findings (DOMPurify, low severity).

## 2. Maintainability and future-proofing

### Strengths

- **Documentation is far above the norm** for a project of this size: a numbered requirements specification with acceptance criteria, 23 ADRs that record why deviations were made, an architecture overview, a maintenance guide and a UI tour.
- **Version pinning as data.** All provider, distribution, add-on and runtime versions live in `versions.yaml`, generated into code, with a `verified` date per entry and a report command that lists newer upstream versions. This is a good answer to the main maintenance burden of a CAPI front end.
- **Test discipline.** Lint, type check, unit and snapshot tests and a backend coverage threshold (70 %, currently 76 %) gate every change; snapshot tests make provider-manifest changes visible in review.
- **Lean dependency tree.** Three runtime dependencies in the shared package, sixteen in the backend, twelve in the frontend.
- **Removability.** Clusters created by the app are plain CAPI and survive the app's removal; this lowers the long-term risk for users considerably.

### Risks

| Risk                          | Detail                                                                                                                                                                                                                                                  | Suggestion                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Bus factor of one             | One maintainer; much of the code was written with an AI coding agent. Knowledge sits in the documents and in one person.                                                                                                                                | Keep the ADR discipline; invite at least one co-maintainer for reviews; add a CONTRIBUTING guide.   |
| Upstream provider churn       | Each provider has its own release cadence and API maturity. Known issues are already worked around: k0smotron control plane replacement (ADR-0013, upstream fix pending), CAPG still on the CAPI v1beta1 contract (removal expected around CAPI v1.16). | Keep the live-test routine per provider release; track the v1beta1 deprecation as a dated risk.     |
| Dependency updates are manual | Renovate is configured but its operating mode was left open; updates happen through the report and by hand.                                                                                                                                             | Decide on automated update pull requests (with the existing three-day minimum release age).         |
| Re-implemented protocols      | See section 1; every protocol change upstream becomes a project task.                                                                                                                                                                                   | Prefer maintained libraries where the security or protocol surface is large (OAuth, registry auth). |
| Frontend bundle growth        | Monaco and xterm dominate.                                                                                                                                                                                                                              | Lazy-load both (they are only needed on specific pages).                                            |

## 3. Security

### What is done well

- **Authentication:** argon2id password hashing (`node:crypto`), constant-time comparisons, HMAC-signed stateless session tokens with server-side revocation (session generation), login rate limiting per client and user, forced password change on first sign-in, optional OIDC with PKCE, state and nonce.
- **Authorization:** every endpoint declares a permission; a guard enforces it per connection and namespace (scoped role assignments). The built-in roles are pinned by a test. Every mutating action writes an audit event.
- **Web hardening:** strict Content Security Policy (`script-src 'self'`; styles allow inline for Vuetify), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`. Cookies are `HttpOnly`, `Secure` by default, `SameSite=Strict` for the session. Mutating requests need a custom header against CSRF; the node shell WebSocket checks the origin.
- **Secrets:** credentials live only in Kubernetes Secrets and are never returned by the API or written to logs (enforced by design and tests).
- **Container:** non-root user (UID 1000), read-only root file system, all capabilities dropped, no privilege escalation.
- **Kubeconfig handling:** exec-based kubeconfigs for connections are rejected, so the app cannot be tricked into running binaries.

### Findings

| #   | Severity           | Finding                                                                                                                                                                                                                                                                                                                                                                    | Recommendation                                                                                                                                                                       |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | High (inherent)    | **Blast radius.** The app's service account and the stored credentials control management clusters, cloud accounts and, through them, every workload cluster. A full-privilege access manifest is the default; a minimal one exists.                                                                                                                                       | Document a threat model; recommend the minimal manifest; restrict network access to the UI (internal only, SSO); consider a separate management cluster per trust zone.              |
| S2  | High (by design)   | **Node shell** creates a privileged pod with `nsenter` into the host: root on any node. It is part of the built-in **operator** role (`nodes.shell`).                                                                                                                                                                                                                      | Remove `nodes.shell` from the default operator role or make the feature opt-in per installation; keep the audit trail; add a session recording or command log if used in production. |
| S3  | Medium (by design) | **Kubeconfig download** gives cluster-admin credentials to every user with `clusters.kubeconfig` (also in the operator role). They are long-lived and not tied to the user.                                                                                                                                                                                                | Offer per-user, short-lived access (e.g. OIDC to workload clusters) as the long-term model; until then, point it out in the UI.                                                      |
| S4  | Medium             | **Server-side requests to user-supplied URLs** (admins only): Helm repository URLs, OIDC issuer, OpenStack `auth_url`, and the `token_uri` inside an uploaded Google service-account key. The backend will call internal addresses, including cloud metadata endpoints, from inside the cluster.                                                                           | Block link-local and metadata addresses by default; validate `token_uri` against Google's hosts; consider an egress NetworkPolicy for the app.                                       |
| S5  | Medium             | **Cloud credentials on nodes.** On Google Cloud the control plane machines run as the credential's service account (often with the Editor role); any pod with host access on those nodes, including all workloads of all-in-one clusters, can obtain its tokens (ADR-0023). On AWS, IMDS hop limit 2 lets pods read user data and instance-profile credentials (ADR-0003). | Recommend a dedicated, minimal service account per cluster in the docs and the wizard; warn for all-in-one clusters on Google Cloud.                                                 |
| S6  | Medium             | **Supply chain.** GitHub Actions are pinned by tag, not by commit SHA; the base image is pinned by tag, not digest; no image signing (cosign), no SBOM or provenance attestation, no container vulnerability scan, no CodeQL or OpenSSF Scorecard.                                                                                                                         | Pin actions by SHA, add `docker/build-push-action` provenance and SBOM, sign images and charts with cosign, add a Trivy or Grype scan and CodeQL to CI.                              |
| S7  | Low                | **Node customization** runs arbitrary commands as root on nodes; anyone with `clusters.change` can use it. Documented and audited.                                                                                                                                                                                                                                         | Keep; consider a separate permission for customization.                                                                                                                              |
| S8  | Low                | **Login rate limiting is in memory per replica** and resets on restart; with three replicas an attacker gets three times the attempts.                                                                                                                                                                                                                                     | Acceptable for the scope; document, or move the counter into the home cluster.                                                                                                       |
| S9  | Low                | **Plain-HTTP mode** (`cookieSecure=false`) exists for tests; the login page does not warn when it is used over HTTP.                                                                                                                                                                                                                                                       | Show a warning when the app is reached over HTTP from a non-localhost origin.                                                                                                        |
| S10 | Low                | **Anonymous requests** to the RKE2 API server on Google Cloud are enabled for load balancer health checks (ADR-0022); RBAC limits them to health and version endpoints.                                                                                                                                                                                                    | Keep documented; revisit if CAPG gains authenticated health checks.                                                                                                                  |
| S11 | Low                | `pnpm audit --prod`: two low-severity DOMPurify advisories through Monaco.                                                                                                                                                                                                                                                                                                 | Update Monaco when a patched DOMPurify is pulled in.                                                                                                                                 |
| S12 | Info               | Kubernetes Secrets are only base64-encoded unless the home cluster encrypts etcd at rest.                                                                                                                                                                                                                                                                                  | State in the installation docs that encryption at rest is expected.                                                                                                                  |

No critical vulnerability was found in the application code itself within the scope of this review. The most important security work is operational (S1–S3) and in the build pipeline (S6).

## 4. Use case

### Problem and positioning

Cluster API is powerful but hard to approach: many providers, CRDs and versions that must fit together. Between `clusterctl` plus hand-written YAML and full platforms such as Rancher, Gardener, Palette or k0rdent, there is little that teaches CAPI while being usable. CAPI Navigator positions itself in that gap: a showcase and entry point that stays strictly upstream, and a practical tool for fleets of up to about 50 clusters per management cluster.

### What makes it credible

- **Everything is plain CAPI** and remains manageable without the app; there is no lock-in.
- **Preview before apply and learn mode** (every field names the CAPI resource and field it maps to) make it a teaching tool, not just a form.
- **Breadth for its size:** three clouds (OpenStack, AWS, Google Cloud), three distributions (RKE2, k0s, kubeadm), day-2 operations, Helm add-ons through CAAPH, role management, OIDC, API tokens, all verified live.

### Limits and competition

- Large organisations will choose a platform with lifecycle features beyond CAPI (fleet-wide policy, backups, multi-tenancy, support). The project says so itself; this is a scoping decision, not a weakness.
- k0rdent and Rancher's Turtles approach CAPI from the platform side; hosted control planes (k0smotron, k3k) are an obvious next step the project has only in its outlook.
- The value depends on keeping up with upstream providers; a stale catalog would quickly make the tool misleading.

**Verdict:** the use case is sensible and clearly scoped. It is strongest as an educational and evaluation tool, and for small teams that want CAPI without a platform. Production use should follow the security recommendations above.

## 5. UX of the web UI

### Cluster wizard

The wizard has eight steps (basics, topology, infrastructure, add-ons, node customization, advanced, preview, create) in a Vuetify stepper.

**Strengths**

- **Sensible defaults:** the first credential, its region, Ubuntu 24.04 and the floating network are preselected; most clusters need only names and machine sizes.
- **Explains itself:** every field has a hint with its default and the CAPI field it maps to. For the stated audience this is the product's main differentiator.
- **Validation from the shared schema,** shown per step only after a step was left, so an empty form does not open full of errors.
- **Preview before create** shows every object as YAML, plus warnings (for example for all-in-one clusters with several nodes, or replaced add-on resource sets) and blockers (missing providers, untested credentials).
- **Provider-neutral forms:** the infrastructure step adapts to the chosen cloud without visible special cases.

**Weaknesses**

| #   | Observation                                                                                                                                                                                                   | Suggestion                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| U1  | Jumping to a later step through the stepper header skips the client-side check; the preview then shows a generic "The input is invalid – correct the marked fields" although no field on that page is marked. | Disable header navigation past the first invalid step, or list the failing fields with links to their steps. |
| U2  | Machine sizes are long flat lists (e.g. OpenStack flavors) with no warning when a size is too small for the distribution; a 1-vCPU control plane was created and hung.                                        | Mark sizes below each distribution's minimum and warn in the preview.                                        |
| U3  | Hints are long and always visible; the "learn mode" is effectively always on. Experienced users scroll through text they no longer need.                                                                      | Offer a compact mode that collapses hints into tooltips.                                                     |
| U4  | Some errors are technically correct but misleading (a missing OCI package reported as refused credentials; a silent failed password change over HTTP). Part of this was fixed in 0.8.1.                       | Continue translating upstream errors into causes and actions; add the HTTP warning (S9).                     |
| U5  | The YAML preview of a large cluster is one long scroll without navigation.                                                                                                                                    | Add an object list with jump links next to the YAML.                                                         |

### Day-2 and other screens

- **Change dialogs** follow the same pattern (form, preview with diff, apply) and detect drift caused outside the app: consistent and safe.
- **Cluster detail** combines a resource tree, machines, events, dashboard, add-ons and node shell; dense but well organised.
- **Credentials** show test results per check with concrete hints (missing API, missing role), which turned out helpful in practice.
- **Accessibility:** about 40 explicit ARIA labels across the frontend; Vuetify covers basic keyboard navigation. No dedicated accessibility review has been done.
- **Internationalisation:** all texts go through vue-i18n, English only so far.

## 6. Licensing

**Finding at the start of the review:** the public repository had no license ("No license has been
chosen yet" in the README). Without a license, others may view and fork the code on GitHub but not
use, change or redistribute it, and no warranty disclaimer applies.

**Resolved during the review** (22 October 2026):

- The project is licensed under the **Apache License 2.0** (`LICENSE`, `NOTICE`), the common choice
  in the Kubernetes ecosystem. It disclaims warranties and limits liability (sections 7 and 8) and
  grants a patent license from contributors. Under German law such exclusions do not cover intent
  and gross negligence; this is the accepted frame for free software.
- **Dependencies:** all 262 shipped packages are under permissive licenses (MIT 191, Apache-2.0 39,
  ISC/BSD/0BSD/Unlicense/Python-2.0, OFL-1.1 for the Inter font, DOMPurify under MPL-2.0 or
  Apache-2.0); no copyleft dependency.
- **Adapted upstream manifests** (Calico, Cloud Provider GCP, PD CSI driver; Apache-2.0) now carry
  their license, a description of the changes (`apps/backend/assets/README.md`) and a
  modification notice in every delivered copy (Apache-2.0 section 4).
- **Third-party notices** are generated at build time from the installed packages, shipped in the
  image and served at `/third-party-notices.txt` (linked in the user menu). The generator doubles
  as a license gate in CI: a dependency with an unknown or non-allow-listed license fails the build.

**Remaining notes:** the container base image contains Debian packages under their own licenses
(including GPL), whose sources Debian provides; images and charts pulled at runtime from upstream
are not redistributed by the project. This changes with air-gapped bundles (outlook FP-29), which
would redistribute RKE2, k0s, containerd and container images and need their own license review.
Product names (Kubernetes, OpenStack, AWS, Google Cloud, Rancher) are used descriptively, without
logos. This section is a technical review, not legal advice.

## 7. Recommendations by priority

1. **Before production use:** threat model and hardening guide (S1); take `nodes.shell` and `clusters.kubeconfig` out of the default operator role or make them opt-in (S2, S3); block metadata and link-local targets for server-side requests (S4).
2. **Build pipeline:** pin actions and base image by digest, add SBOM, provenance, image signing and a vulnerability scan (S6); decide on automated dependency updates.
3. **Credentials on nodes:** recommend and support a dedicated minimal cloud identity per cluster, with a warning for all-in-one clusters (S5).
4. **UX:** prevent the stepper bypass and list failing fields (U1); machine-size minimums (U2); compact hint mode (U3).
5. **Sustainability:** a second maintainer or reviewer; a CONTRIBUTING guide; a plan for TypeScript 7 and for the CAPI v1beta1 contract removal.
