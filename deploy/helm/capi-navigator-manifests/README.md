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

## Testing a mirror

Any Helm repository the app knows can be the chart source of a connection (add-ons page → Chart of
the manifest add-ons → Change source). For a quick test without a registry, an HTTP repository is
enough: a directory with the chart and an `index.yaml`, served by any web server that the backend
and the management cluster can reach. This is how FP30 acceptance criterion 4 was verified:

```sh
VERSION=x.y.z
mkdir mirror && cd mirror
curl -LO "https://github.com/alirionx/capi-navigator/releases/download/v$VERSION/capi-navigator-manifests-$VERSION.tgz"
helm repo index .          # relative URLs, so the server address does not matter
python3 -m http.server 8080
```

Add `http://<host>:8080` as HTTP repository in the app and set it as chart source; the chart
status shows the version, and the mirror's access log shows CAAPH fetching `index.yaml` and the
chart. Reset the chart source before deleting the repository.
