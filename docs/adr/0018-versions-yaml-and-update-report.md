# ADR-0018: versions.yaml and an update report instead of update bots

- Status: accepted
- Date: 2026-10-19
- Pack: FP-20

## Context

The app pins about 36 versions: CAPI providers, cert-manager, the CAPI Operator, ORC, Kubernetes
versions per distribution, the charts of the add-on presets, containerd, runc, Calico and the node
shell image. They are spread over eight files, some in two or three copies, and nothing tells the
maintainers that newer versions exist.

Update bots (Renovate, Dependabot) open pull requests on a schedule. That only helps when someone
reviews them regularly; this app is maintained by one person as a showcase, without a DevOps team.
Blindly merged provider updates are risky (see the k0smotron findings of FP-9, ADR-0013). The
Mend-hosted Renovate app also needs a personal sign-up, which conflicts with the "as code"
principle of the project.

## Decision

- **One file, `versions.yaml`**, at the repository root holds every pinned version with its source
  (GitHub releases, Helm repository, container registry) and short notes. It contains versions
  only; behaviour (values templates, scripts, network rules) stays in code under snapshot tests.
- **Generated, not read at runtime.** A Zod schema validates the file; `pnpm versions:generate`
  turns it into a typed module in `packages/shared` that the code imports. An app version stays
  reproducible, and a test fails when the module is outdated. All other copies disappear.
- **Couplings as tests**: versions released together (CAPI core and kubeadm, RKE2 bootstrap and
  control plane, the k0smotron providers, ORC per CAPO minor) are checked by tests.
- **Renovate as a lookup tool, not as a bot.** `pnpm versions:report` runs Renovate in a pinned
  container with `--platform=local` on a read-only mount of the repository. A custom manager in
  `renovate.json` teaches it `versions.yaml`; npm, Docker and GitHub Actions it knows anyway. A
  script turns Renovate's report into `docs/versions-report.md`. The maintainers run it by hand
  (e.g. before a release) and commit the result. No schedule, no pull requests, no stored token:
  the local `gh` login is passed for GitHub lookups during the run only.
- Updating stays a deliberate, manual step documented in `docs/maintenance.md`.

## Consequences

- One place to look and to change; the report shows how current the project is.
- Nobody is notified automatically; the report is only as fresh as its last run.
- Turning on Renovate pull requests later only needs a scheduled workflow and a token, because
  `renovate.json` already knows `versions.yaml`.
