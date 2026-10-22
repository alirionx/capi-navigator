# ADR-0024: Manifest add-ons through CAAPH with a generic chart of the project

- Status: accepted
- Date: 2026-10-22
- Pack: FP-30
- Refines: FP-8 (Helm add-ons), [ADR-0023](0023-gcp-ccm-and-csi-as-manifests.md) (manifests by ClusterResourceSet)

## Context

Helm add-ons (FP-8) cover software, but not the few objects that complete it per cluster: a
cert-manager `ClusterIssuer`, a Gateway API `Gateway`, a default `NetworkPolicy`. Users want to
keep such manifests in the app and assign them to clusters by label, with status and removal like
Helm add-ons, and without a GitOps tool.

Options considered:

1. **ClusterResourceSet** (core CAPI, already used for Calico and the Google Cloud add-ons). Applied
   once per cluster (`ApplyOnce`) or re-applied (`Reconcile`), but objects are never removed from a
   workload cluster when the selector stops matching or the set is deleted, there is no status per
   object, and the content lives in ConfigMaps (Secrets for anything sensitive).
2. **CAAPH with a generic chart of the project.** A small chart renders the manifests passed in its
   values; one `HelmChartProxy` per manifest add-on. Helm owns the objects: removal, upgrade and
   status per cluster come from CAAPH, as for Helm add-ons.
3. **A chart served by the app.** No registry needed, but the management cluster must reach the
   app, which is not given (the app may run outside the management cluster), and the backend would
   have to serve a Helm repository.
4. **A third-party "raw" chart** (e.g. from a community repository). No own artifact, but a
   dependency on a foreign project's release cadence and supply chain for every cluster.

## Decision

- **Option 2.** The chart `capi-navigator-manifests` lives in `deploy/` and renders a YAML string
  from its values unchanged. The release workflow publishes it next to the app chart to
  `oci://ghcr.io/<owner>/charts/`, with the app version as chart version, so app and chart move
  together.
- **One add-on, one proxy, one release per cluster.** Each manifest add-on is a named set of objects
  for one logical unit and becomes one `HelmChartProxy`; CAAPH creates one Helm release per matching
  cluster. There is no "manifest chart per cluster": objects are grouped by purpose, not by cluster.
- **Templating by CAAPH.** Manifests go into `valuesTemplate`, so CAAPH's Go templates
  (`{{ .Cluster.metadata.name }}`) work without a templating engine in the app.
- **Chart source per connection.** Default is ghcr.io; admins may set another OCI source per
  management cluster connection (air-gapped mirrors, FP-29). The app checks that the needed chart
  version exists there and shows the `helm pull` / `helm push` commands for mirroring.
- **No Secrets in the first step.** Values end up in plain text in the `HelmChartProxy` and the Helm
  release Secret history, so `kind: Secret` is refused (hard rule 8).

## Consequences

- Manifest add-ons behave like Helm add-ons: same permission (`addons.manage`), audit, preview,
  status and removal; the UI and the backend reuse the FP-8 code paths.
- The project ships and maintains a second artifact; a release without the chart breaks new
  manifest add-ons, which the version check reports.
- Workload clusters (through CAAPH in the management cluster) need access to ghcr.io or the
  configured mirror; this is the same requirement as for Helm add-ons.
- Helm refuses an object already owned by another release, so the app warns about objects listed in
  more than one add-on with overlapping selectors.
- The connection CRD gets an optional field: upgrades must apply the CRDs first (the Helm chart
  does).
- Ordering between add-ons (e.g. issuer after cert-manager CRDs) is not managed; CAAPH retries until
  the CRDs exist.
- ClusterResourceSets stay for what the app itself must deliver before the cluster is ready (CNI,
  Google Cloud CCM and CSI, ADR-0023).
