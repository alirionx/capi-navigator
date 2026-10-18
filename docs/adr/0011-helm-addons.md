# ADR-0011: Helm add-ons with the HelmChartProxy as source of truth

- Status: accepted
- Date: 2026-10-18
- Pack: FP-8

## Context

FP-8 rolls out Helm charts via CAAPH. Checking CAAPH v0.6.4 (CRDs and controller code) showed
three constraints the requirements do not mention:

- A `HelmChartProxy` selects clusters **in its own namespace only**.
- `credentials` and `tlsConfig.caSecret` of a `HelmChartProxy` reference Secrets in the
  management cluster. CAAPH passes them to Helm's OCI registry client only; HTTP repositories
  get neither credentials nor the custom CA.
- `reconcileStrategy` is immutable. With `InstallOnce`, deleting the `HelmChartProxy` removes
  the `HelmReleaseProxies` but leaves the Helm releases installed.

The app keeps no database (hard rule 1) and must stay removable (hard rule 7).

## Decision

- The `HelmChartProxy` is the source of truth for an add-on. The form maps 1:1 onto it; the
  only addition is the annotation `capi-navigator.io/helm-repository` naming the repository.
  `HelmChartProxies` that do not fit the form (match expressions) or were not created by the
  app are shown read-only.
- An add-on lives in one namespace. To serve clusters of another namespace, a second add-on is
  created there.
- `HelmRepository` resources (home cluster) hold URL and type. Username, password and CA
  certificate are stored in a Secret of the home cluster and are supported for OCI only. When an
  add-on uses such a repository, the app writes a copy (`capi-navigator-helm-<repo>`, keys
  `config.json` in Docker config format and `ca.crt`) next to the `HelmChartProxy` and refreshes
  it when the repository changes. The copy is removed with the last add-on of the namespace that
  uses it.
- The chart browser runs in the backend: `index.yaml` for HTTP repositories, the OCI
  distribution API (token or basic auth, paged tag list) for registries, and `values.yaml` read
  from the chart archive in memory. Only repositories defined by admins can be read; responses are
  size-limited and credentials are never forwarded to other hosts.
- Changing the reconcile strategy is a blocker in the preview; the delete preview says whether
  releases are uninstalled (`Continuous`) or stay (`InstallOnce`).
- CCM/CSI presets keep their defaults in the code. Admins override version and values; the
  overrides are stored in the ConfigMap `capi-navigator-addon-presets` of the home cluster. New
  clusters use them immediately; existing namespaces are updated only through an explicit rollout
  with preview. Presets cannot be deleted from the add-on page.

## Consequences

- Uninstalling the app leaves working `HelmChartProxies` and Secret copies behind; CAAPH keeps
  reconciling them.
- Private HTTP repositories (basic auth) are not supported until CAAPH supports them; such charts
  have to be pushed to an OCI registry.
- The backend needs network access to the repositories in addition to CAAPH.
