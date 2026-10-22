import { buildManifestHelmChartProxy, ManifestAddonSpecSchema } from '@capi-navigator/shared';
import { describe, expect, it } from 'vitest';
import { buildAddonStatuses } from './addons.service.js';

const hcp = (name: string, extra: Record<string, unknown> = {}) => ({
  metadata: {
    name,
    namespace: 'team-a',
    labels: { 'capi-navigator.io/managed-by': 'capi-navigator' },
    annotations: { 'capi-navigator.io/helm-repository': 'podinfo' },
  },
  spec: {
    clusterSelector: { matchLabels: { 'addon/podinfo': 'true' } },
    repoURL: 'https://stefanprodan.github.io/podinfo',
    chartName: 'podinfo',
    version: '6.15.0',
    releaseName: 'podinfo',
    namespace: 'podinfo',
    valuesTemplate: '',
    reconcileStrategy: 'Continuous',
    options: { wait: true, timeout: '10m0s', install: { createNamespace: true } },
    ...extra,
  },
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
});
const cluster = (name: string, labels: Record<string, string>, namespace = 'team-a') => ({
  metadata: { name, namespace, labels },
});
const hrp = (cluster: string, status: string) => ({
  metadata: {
    name: `podinfo-${cluster}-x1`,
    namespace: 'team-a',
    labels: {
      'helmreleaseproxy.addons.cluster.x-k8s.io/helmchartproxy-name': 'podinfo',
      'cluster.x-k8s.io/cluster-name': cluster,
    },
  },
  spec: {
    clusterRef: { name: cluster },
    releaseName: 'podinfo',
    namespace: 'podinfo',
    version: '6.15.0',
  },
  status: {
    revision: 2,
    status,
    conditions: [{ type: 'Ready', status: status === 'deployed' ? 'True' : 'False' }],
  },
});

describe('add-on status (FP8-F-11)', () => {
  it('lists releases per cluster and matches clusters by label in the same namespace', () => {
    const [row] = buildAddonStatuses(
      [hcp('podinfo')],
      [hrp('b', 'pending-install'), hrp('a', 'deployed')],
      [
        cluster('a', { 'addon/podinfo': 'true' }),
        cluster('b', { 'addon/podinfo': 'true' }),
        cluster('c', {}),
        cluster('d', { 'addon/podinfo': 'true' }, 'team-b'),
      ],
    );
    expect(row!.matchingClusters).toEqual(['a', 'b']);
    expect(row!.releases.map((r) => [r.cluster, r.status, r.revision, r.ready])).toEqual([
      ['a', 'deployed', 2, true],
      ['b', 'pending-install', 2, false],
    ]);
    expect(row!.spec?.chartName).toBe('podinfo');
    expect(row!.managed).toBe(true);
    expect(row!.ready).toBe(true);
  });

  it('shows presets and foreign HelmChartProxies without a form model', () => {
    const preset = hcp('capi-navigator-openstack-ccm');
    preset.metadata.labels['capi-navigator.io/preset' as 'capi-navigator.io/managed-by'] =
      'openstack-ccm';
    const foreign = hcp('external', {
      clusterSelector: { matchExpressions: [{ key: 'x', operator: 'Exists' }] },
    });
    foreign.metadata.labels = {} as typeof foreign.metadata.labels;
    const rows = buildAddonStatuses([preset, foreign], [], []);
    expect(rows.find((r) => r.name === 'capi-navigator-openstack-ccm')).toMatchObject({
      presetId: 'openstack-ccm',
    });
    expect(rows.find((r) => r.name === 'capi-navigator-openstack-ccm')!.spec).toBeUndefined();
    expect(rows.find((r) => r.name === 'external')).toMatchObject({ managed: false });
    expect(rows.find((r) => r.name === 'external')!.spec).toBeUndefined();
  });

  it('marks manifest add-ons and returns their form model (FP30-F-04)', () => {
    const spec = ManifestAddonSpecSchema.parse({
      name: 'issuer',
      namespace: 'team-a',
      manifests: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n',
      clusterSelector: { 'addon/issuer': 'true' },
    });
    const manifests = buildManifestHelmChartProxy(spec, { version: '0.9.0' });
    const [helm, row] = buildAddonStatuses(
      [hcp('a-podinfo'), manifests as unknown as ReturnType<typeof hcp>],
      [],
      [cluster('a', { 'addon/issuer': 'true' })],
    );
    expect(helm).toMatchObject({ type: 'helm', name: 'a-podinfo' });
    expect(row).toMatchObject({ type: 'manifests', matchingClusters: ['a'], manifestSpec: spec });
    expect(row!.spec).toBeUndefined();
  });
});
