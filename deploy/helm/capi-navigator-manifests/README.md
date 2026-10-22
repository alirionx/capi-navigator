# capi-navigator-manifests

A generic chart that renders the multi-document YAML in `manifests` unchanged. CAPI Navigator uses
it for manifest add-ons (FP-30, ADR-0024): each add-on becomes one `HelmChartProxy` for this chart,
and CAAPH installs one Helm release per matching workload cluster. Helm then owns the objects, so
they are updated and removed with the release.

It is published with every app release to `oci://ghcr.io/alirionx/charts/capi-navigator-manifests`,
with the app version as chart version (the `0.0.0-dev` in `Chart.yaml` is replaced when the
release workflow packages it). Use the version of the installed app. For a mirror:

```sh
VERSION=x.y.z
helm pull oci://ghcr.io/alirionx/charts/capi-navigator-manifests --version "$VERSION"
helm push "capi-navigator-manifests-$VERSION.tgz" oci://registry.example.com/charts
```

Standalone use:

```sh
helm install issuer oci://ghcr.io/alirionx/charts/capi-navigator-manifests --version "$VERSION" \
  --set-file manifests=cluster-issuer.yaml
```
