import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ADDON_PRESETS, buildAddonPreset, effectivePreset, presetsFor } from '../cluster/addons.js';
import {
  addonSpecFromHelmChartProxy,
  AddonSpecSchema,
  buildHelmChartProxy,
  buildRepositorySecretCopy,
  matchesSelector,
  type AddonRepositoryRef,
} from './addon.js';
import {
  CreateHelmRepositoryRequestSchema,
  HelmRepositorySpecSchema,
  registryConfigJson,
} from './repository.js';

const spec = () =>
  AddonSpecSchema.parse({
    name: 'podinfo',
    namespace: 'capi-test',
    repository: 'podinfo',
    chartName: 'podinfo',
    version: '6.9.2',
    releaseNamespace: 'podinfo',
    valuesTemplate: 'ui:\n  message: "Hello from {{ .Cluster.metadata.name }}"\n',
    clusterSelector: { 'addon/podinfo': 'true' },
  });

const http: AddonRepositoryRef = {
  name: 'podinfo',
  type: 'http',
  url: 'https://stefanprodan.github.io/podinfo',
  insecureSkipTLSVerify: false,
  hasCredentials: false,
  hasCaCertificate: false,
};
const privateOci: AddonRepositoryRef = {
  name: 'private',
  type: 'oci',
  url: 'oci://172.18.0.9:5000/charts',
  insecureSkipTLSVerify: false,
  hasCredentials: true,
  hasCaCertificate: true,
};

describe('Helm add-ons (FP-8)', () => {
  it('builds a HelmChartProxy from an HTTP repository (FP8-F-05)', () => {
    expect(stringify(buildHelmChartProxy(spec(), http))).toMatchSnapshot();
  });

  it('builds a HelmChartProxy with OCI credentials and CA (FP8-F-03)', () => {
    const s = AddonSpecSchema.parse({
      ...spec(),
      repository: 'private',
      reconcileStrategy: 'InstallOnce',
    });
    expect(stringify(buildHelmChartProxy(s, privateOci))).toMatchSnapshot();
  });

  it('is pure: same input, byte-identical YAML (hard rule 3)', () => {
    expect(stringify(buildHelmChartProxy(spec(), http))).toBe(
      stringify(buildHelmChartProxy(spec(), http)),
    );
  });

  it('reads the form model back from a HelmChartProxy', () => {
    const hcp = buildHelmChartProxy(spec(), http) as Parameters<
      typeof addonSpecFromHelmChartProxy
    >[0];
    expect(addonSpecFromHelmChartProxy(hcp)).toEqual({ ...spec(), releaseName: 'podinfo' });
    // matchExpressions do not fit the form: read-only.
    const withExpr = structuredClone(hcp);
    (withExpr.spec!.clusterSelector as Record<string, unknown>).matchExpressions = [
      { key: 'a', operator: 'Exists' },
    ];
    expect(addonSpecFromHelmChartProxy(withExpr)).toBeUndefined();
  });

  it('rejects an empty cluster selector and reserved names (FP8-F-07)', () => {
    expect(AddonSpecSchema.safeParse({ ...spec(), clusterSelector: {} }).success).toBe(false);
    expect(
      AddonSpecSchema.safeParse({ ...spec(), name: 'capi-navigator-openstack-ccm' }).success,
    ).toBe(false);
  });

  it('matches clusters by all selector labels', () => {
    expect(
      matchesSelector({ 'addon/podinfo': 'true', env: 'x' }, { 'addon/podinfo': 'true' }),
    ).toBe(true);
    expect(matchesSelector({ env: 'x' }, { 'addon/podinfo': 'true' })).toBe(false);
    expect(matchesSelector({ env: 'x' }, {})).toBe(false);
  });

  it('writes the registry config in docker config.json format', () => {
    const json = JSON.parse(registryConfigJson('oci://172.18.0.9:5000/charts', 'u', 'p'));
    expect(json).toEqual({ auths: { '172.18.0.9:5000': { auth: btoa('u:p') } } });
    const secret = buildRepositorySecretCopy('private', 'capi-test', {
      configJson: 'x',
      caCrt: 'y',
    });
    expect(secret.metadata.name).toBe('capi-navigator-helm-private');
    expect(Object.keys(secret.stringData as object)).toEqual(['config.json', 'ca.crt']);
  });
});

describe('Helm repositories (FP8-F-02)', () => {
  it('checks the URL against the type', () => {
    const ok = (type: string, url: string) =>
      HelmRepositorySpecSchema.safeParse({ type, url }).success;
    expect(ok('http', 'https://stefanprodan.github.io/podinfo/')).toBe(true);
    expect(ok('oci', 'oci://ghcr.io/stefanprodan/charts')).toBe(true);
    expect(ok('oci', 'https://ghcr.io/stefanprodan/charts')).toBe(false);
    expect(ok('http', 'oci://ghcr.io/x')).toBe(false);
    expect(HelmRepositorySpecSchema.parse({ type: 'http', url: 'https://x.io/a/' }).url).toBe(
      'https://x.io/a',
    );
  });

  it('allows credentials and CA for OCI only (CAAPH)', () => {
    const base = { name: 'repo', url: 'https://x.io', type: 'http' };
    expect(
      CreateHelmRepositoryRequestSchema.safeParse({
        ...base,
        credentials: { username: 'u', password: 'p' },
      }).success,
    ).toBe(false);
    expect(
      CreateHelmRepositoryRequestSchema.safeParse({
        ...base,
        type: 'oci',
        url: 'oci://x.io/charts',
        credentials: { username: 'u', password: 'p' },
      }).success,
    ).toBe(true);
  });
});

describe('editable presets (FP8-F-14)', () => {
  it('applies overrides to version and values', () => {
    const ccm = ADDON_PRESETS.find((p) => p.id === 'openstack-ccm')!;
    const e = effectivePreset(ccm, { 'openstack-ccm': { version: '2.38.0' } });
    expect(e.version).toBe('2.38.0');
    expect(e.valuesTemplate).toBe(ccm.valuesTemplate);
    const [preset] = presetsFor(
      { 'capi-navigator.io/ccm': 'openstack' },
      { 'openstack-ccm': { valuesTemplate: 'a: 1\n' } },
    );
    expect(buildAddonPreset(preset!, 'ns').spec).toMatchObject({
      version: ccm.version,
      valuesTemplate: 'a: 1\n',
    });
  });
});

describe('kured reboot daemon preset (FP-9, ADR-0013)', () => {
  it('is selected by its own label, independent of the cloud', async () => {
    const { transform } = await import('../cluster/transform.js');
    const { ClusterSpecSchema } = await import('../cluster/spec.js');
    const spec = ClusterSpecSchema.parse({
      name: 'demo',
      kubernetes: { flavor: 'k0s', version: 'v1.35.8+k0s.1' },
      addons: { cloudControllerManager: false, csiDriver: false, rebootDaemon: true },
      topology: {
        mode: 'all-in-one',
        controlPlane: { replicas: 1, machineSize: 't3.large' },
        workerPools: [],
      },
      infrastructure: {
        provider: 'aws',
        credentialRef: 'aws-dev',
        region: 'eu-central-1',
        image: 'ami-0e27250725fa51794',
      },
    });
    const cluster = transform(spec, { credential: {} }).find((o) => o.kind === 'Cluster')!;
    expect(cluster.metadata.labels?.['capi-navigator.io/reboot']).toBe('kured');
    const presets = presetsFor(cluster.metadata.labels ?? {});
    expect(presets.map((p) => p.id)).toEqual(['kured']);
    expect(stringify(buildAddonPreset(presets[0]!, 'default'))).toMatchSnapshot();
  });
});

describe('Calico via ClusterResourceSet (FP10-F-04, ADR-0014)', () => {
  const official = [
    'kind: DaemonSet',
    '            - name: CALICO_IPV4POOL_VXLAN',
    '              value: "CrossSubnet"',
    '            - name: CALICO_IPV6POOL_VXLAN',
    '              value: "CrossSubnet"',
    '',
  ].join('\n');

  it('forces VXLAN for all pod traffic and names objects by version and content', async () => {
    const { buildCalicoResourceSet } = await import('../cluster/cni.js');
    const [cm, crs] = buildCalicoResourceSet('team-a', official);
    const content = (cm!.data as Record<string, string>)['calico.yaml']!;
    expect(content).not.toContain('CrossSubnet');
    expect(content.match(/value: "Always"/g)).toHaveLength(2);
    expect(cm!.metadata.name).toMatch(/^capi-navigator-calico-v3-33-0-[0-9a-f]{6}$/);
    expect(cm!.metadata.labels?.['cluster.x-k8s.io/cluster-name']).toBeUndefined();
    expect(crs!.spec).toEqual({
      clusterSelector: { matchLabels: { 'capi-navigator.io/cni': 'calico' } },
      resources: [{ kind: 'ConfigMap', name: cm!.metadata.name }],
      strategy: 'ApplyOnce',
    });
    expect(presetsFor({ 'capi-navigator.io/cni': 'calico' })).toEqual([]);
  });

  it('fails when the manifest layout changed', async () => {
    const { buildCalicoResourceSet } = await import('../cluster/cni.js');
    expect(() => buildCalicoResourceSet('team-a', 'kind: DaemonSet\n')).toThrow(
      /CALICO_IPV4POOL_VXLAN not found/,
    );
  });
});
