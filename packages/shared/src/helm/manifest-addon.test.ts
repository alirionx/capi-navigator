import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import type { AddonRepositoryRef } from './addon.js';
import {
  buildManifestHelmChartProxy,
  checkManifests,
  MANIFEST_EXAMPLES,
  manifestAddonSpecFromHelmChartProxy,
  ManifestAddonSpecSchema,
  manifestsFromValuesTemplate,
  manifestValuesTemplate,
  selectorsCanOverlap,
} from './manifest-addon.js';

const ISSUER = `apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: info
data:
  cluster: {{ .Cluster.metadata.name }}
  indented: |
      deeper
`;

const spec = () =>
  ManifestAddonSpecSchema.parse({
    name: 'issuer',
    namespace: 'capi-test',
    manifests: ISSUER,
    clusterSelector: { 'addon/issuer': 'true' },
  });

const mirror: AddonRepositoryRef = {
  name: 'mirror',
  type: 'oci',
  url: 'oci://registry.example.com/charts',
  insecureSkipTLSVerify: false,
  hasCredentials: true,
  hasCaCertificate: false,
};

describe('Manifest add-ons (FP-30)', () => {
  it('builds a HelmChartProxy for the generic chart from ghcr.io (FP30-F-01, FP30-F-04)', () => {
    expect(stringify(buildManifestHelmChartProxy(spec(), { version: '0.9.0' }))).toMatchSnapshot();
  });

  it('uses a Helm repository of the app as chart source, with its credentials (FP30-F-02)', () => {
    const hcp = buildManifestHelmChartProxy(spec(), { repository: mirror, version: '0.9.0' });
    expect(hcp.metadata.annotations).toEqual({ 'capi-navigator.io/helm-repository': 'mirror' });
    expect(hcp.spec).toMatchObject({
      repoURL: 'oci://registry.example.com/charts',
      chartName: 'capi-navigator-manifests',
      credentials: { secret: { name: 'capi-navigator-helm-mirror' } },
    });
  });

  it('keeps the manifests unchanged in the values, templates included (FP30-F-07)', () => {
    const values = manifestValuesTemplate(ISSUER);
    // The values are YAML once CAAPH has rendered the templates.
    const rendered = values.replace('{{ .Cluster.metadata.name }}', 'demo');
    expect((parse(rendered) as { manifests: string }).manifests).toBe(
      ISSUER.replace('{{ .Cluster.metadata.name }}', 'demo'),
    );
    expect(manifestsFromValuesTemplate(values)).toBe(ISSUER);
    expect(manifestsFromValuesTemplate('manifests: x\n')).toBeUndefined();
  });

  it('reads the form model back from the HelmChartProxy', () => {
    const s = spec();
    const hcp = buildManifestHelmChartProxy(s, { version: '0.9.0' });
    expect(manifestAddonSpecFromHelmChartProxy(hcp)).toEqual(s);
    const edited = { ...hcp, spec: { ...(hcp.spec as object), valuesTemplate: 'manifests: []' } };
    expect(manifestAddonSpecFromHelmChartProxy(edited)).toBeUndefined();
    const helm = { ...hcp, metadata: { ...hcp.metadata, labels: {} } };
    expect(manifestAddonSpecFromHelmChartProxy(helm)).toBeUndefined();
  });

  it('normalizes line endings and trailing blank lines', () => {
    const s = ManifestAddonSpecSchema.parse({
      ...spec(),
      manifests: ISSUER.replace(/\n/g, '\r\n') + '\r\n\r\n',
    });
    expect(s.manifests).toBe(ISSUER);
  });

  it('lists the objects, with templated names and control lines (FP30-F-05)', () => {
    const { objects, errors } = checkManifests(`{{- if .Cluster.metadata.labels.env }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: "{{ .Cluster.metadata.name }}-a"
  namespace: demo
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Cluster.metadata.name }}-b
{{- end }}
`);
    expect(errors).toEqual([]);
    expect(objects.map((o) => o.kind)).toEqual(['ConfigMap', 'ConfigMap']);
    expect(objects[0]!.namespace).toBe('demo');
  });

  it('refuses invalid YAML, incomplete objects and duplicates (FP30-F-05)', () => {
    expect(checkManifests('a: [').errors[0]).toMatch(/^Document 1: /);
    expect(checkManifests('- a\n- b\n').errors).toEqual(['Document 1: not a Kubernetes object']);
    expect(checkManifests('kind: ConfigMap\nmetadata:\n  name: a\n').errors).toEqual([
      'Document 1: apiVersion and kind are required',
    ]);
    expect(checkManifests('apiVersion: v1\nkind: ConfigMap\nmetadata: {}\n').errors[0]).toMatch(
      /metadata.name is required/,
    );
    const cm = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n';
    expect(checkManifests(`${cm}---\n${cm.replace('v1', 'v1')}`).errors).toEqual([
      'Document 2: ConfigMap a is listed twice',
    ]);
    // Same name in another namespace or of another kind is a different object.
    expect(
      checkManifests(`${cm}---\n${cm}  namespace: b\n---\n${cm.replace('ConfigMap', 'Service')}`)
        .errors,
    ).toEqual([]);
    expect(checkManifests('---\n# only a comment\n').errors).toEqual([
      'At least one object is required',
    ]);
    expect(checkManifests('apiVersion: v1\nkind: List\nmetadata:\n  name: x\n').errors[0]).toMatch(
      /List is not supported/,
    );
  });

  it('refuses Secrets (FP30-F-06)', () => {
    const r = ManifestAddonSpecSchema.safeParse({
      ...spec(),
      manifests: 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: token\nstringData:\n  a: b\n',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/^Document 1: Secret token is not allowed/);
  });

  it('limits the name to a Helm release name', () => {
    const r = ManifestAddonSpecSchema.safeParse({ ...spec(), name: 'a'.repeat(54) });
    expect(r.success).toBe(false);
  });

  it('detects selectors that can match the same cluster (FP30-F-08)', () => {
    expect(selectorsCanOverlap({ a: '1' }, { b: '2' })).toBe(true);
    expect(selectorsCanOverlap({ a: '1', b: '2' }, { a: '1' })).toBe(true);
    expect(selectorsCanOverlap({ a: '1' }, { a: '2' })).toBe(false);
  });

  it('ships valid examples (FP30-F-07)', () => {
    for (const e of MANIFEST_EXAMPLES) {
      expect(checkManifests(e.manifests).errors, e.id).toEqual([]);
    }
  });
});
