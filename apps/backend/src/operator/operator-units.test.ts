import type { KubeConfig, V1Deployment } from '@kubernetes/client-node';
import { catalogEntry } from '@capi-navigator/shared';
import { describe, expect, it, vi } from 'vitest';
import { fetchOrcManifest, OrcManifestError, parseOrcManifest } from './orc-manifest.js';
import { deploymentReady, deploymentVersion, detectPrerequisites } from './prerequisites.js';
import {
  clustersUsing,
  providerPhase,
  toInstalledProvider,
  type ProviderObject,
} from './providers.js';
import { ReleaseFetcher } from './releases.js';

const deployment = (opts: {
  name?: string;
  ns?: string;
  labels?: Record<string, string>;
  image?: string;
  replicas?: number;
  available?: number;
}): V1Deployment => ({
  metadata: { name: opts.name ?? 'd', namespace: opts.ns ?? 'ns', labels: opts.labels ?? {} },
  spec: {
    replicas: opts.replicas ?? 1,
    selector: {},
    template: { spec: { containers: [{ name: 'c', image: opts.image ?? 'x:v1.0.0' }] } },
  },
  status: { availableReplicas: opts.available ?? 1 },
});

describe('prerequisite detection (FP3-F-01, FP3-F-02, FP3-F-04a)', () => {
  it('reads readiness and version', () => {
    expect(deploymentReady(deployment({ replicas: 2, available: 1 }))).toBe(false);
    expect(deploymentReady(deployment({ replicas: 1, available: 1 }))).toBe(true);
    expect(
      deploymentVersion(deployment({ labels: { 'app.kubernetes.io/version': '1.2.3' } })),
    ).toBe('v1.2.3');
    expect(deploymentVersion(deployment({ image: 'repo/op:v0.29.0' }), 'repo/op')).toBe('v0.29.0');
    expect(deploymentVersion(deployment({ image: 'repo/op@sha256:abc' }))).toBeUndefined();
  });

  function fakeKc(opts: { crds: string[]; deployments: V1Deployment[]; orc?: V1Deployment }) {
    const notFound = Object.assign(new Error('nf'), { code: 404 });
    return {
      makeApiClient: (api: { name: string }) =>
        api.name.includes('Apiextensions')
          ? {
              readCustomResourceDefinition: async ({ name }: { name: string }) => {
                if (!opts.crds.includes(name)) throw notFound;
                return {};
              },
            }
          : {
              listDeploymentForAllNamespaces: async () => ({ items: opts.deployments }),
              readNamespacedDeployment: async () => {
                if (!opts.orc) throw notFound;
                return opts.orc;
              },
            },
    } as unknown as KubeConfig;
  }

  it('reports missing components with install instructions (FP3-F-03)', async () => {
    const pre = await detectPrerequisites(fakeKc({ crds: [], deployments: [] }));
    expect(pre.certManager).toEqual({ installed: false, ready: false });
    expect(pre.operator).toEqual({ installed: false, ready: false });
    expect(pre.orc).toEqual({ installed: false, ready: false });
    expect(pre.instructions.certManager).toContain('oci://quay.io/jetstack/charts/cert-manager');
    expect(pre.instructions.operator).toContain('--version 0.29.0');
    expect(pre.instructions.orc).toContain('/v2.6.0/install.yaml');
  });

  it('detects installed and ready components', async () => {
    const cm = (n: string) =>
      deployment({
        ns: 'cert-manager',
        labels: { 'app.kubernetes.io/name': n, 'app.kubernetes.io/version': 'v1.21.2' },
      });
    const pre = await detectPrerequisites(
      fakeKc({
        crds: [
          'certificates.cert-manager.io',
          'coreproviders.operator.cluster.x-k8s.io',
          'servers.openstack.k-orc.cloud',
        ],
        deployments: [
          cm('cert-manager'),
          cm('cainjector'),
          cm('webhook'),
          deployment({
            ns: 'capi-operator-system',
            labels: { 'app.kubernetes.io/name': 'cluster-api-operator' },
            image: 'registry.k8s.io/capi-operator/cluster-api-operator:v0.29.0',
          }),
        ],
        orc: deployment({
          ns: 'orc-system',
          image: 'quay.io/orc/openstack-resource-controller:v2.6.0',
          available: 0,
        }),
      }),
    );
    expect(pre.certManager).toMatchObject({ installed: true, ready: true, version: 'v1.21.2' });
    expect(pre.operator).toMatchObject({ installed: true, ready: true, version: 'v0.29.0' });
    expect(pre.orc).toMatchObject({ installed: true, ready: false, version: 'v2.6.0' });
    expect(pre.orc.message).toMatch(/not available yet/);
  });

  it('flags CRDs without deployment', async () => {
    const pre = await detectPrerequisites(
      fakeKc({ crds: ['coreproviders.operator.cluster.x-k8s.io'], deployments: [] }),
    );
    expect(pre.operator).toMatchObject({ installed: true, ready: false });
    expect(pre.operator.message).toMatch(/deployment is missing/);
  });
});

describe('provider status (FP3-F-08)', () => {
  const provider = (
    status: ProviderObject['status'],
    extra: Partial<ProviderObject> = {},
  ): ProviderObject => ({
    kind: 'InfrastructureProvider',
    metadata: { name: 'openstack', namespace: 'capo-system', generation: 2 },
    spec: { version: 'v0.15.0' },
    status,
    ...extra,
  });
  const ready = [{ type: 'Ready', status: 'True' }];

  it('derives the phase from conditions and versions', () => {
    expect(providerPhase(provider({}))).toBe('Installing');
    expect(
      providerPhase(
        provider({ installedVersion: 'v0.15.0', observedGeneration: 2, conditions: ready }),
      ),
    ).toBe('Ready');
    expect(
      providerPhase(
        provider({ installedVersion: 'v0.15.0', observedGeneration: 1, conditions: ready }),
      ),
    ).toBe('Installing');
    expect(providerPhase(provider({ installedVersion: 'v0.14.8', conditions: ready }))).toBe(
      'Upgrading',
    );
    expect(
      providerPhase(
        provider({
          conditions: [
            { type: 'ProviderInstalled', status: 'False', reason: 'ComponentsFetchError' },
          ],
        }),
      ),
    ).toBe('Failed');
    expect(
      providerPhase(
        provider(
          {},
          { metadata: { name: 'x', namespace: 'y', deletionTimestamp: '2026-01-01T00:00:00Z' } },
        ),
      ),
    ).toBe('Deleting');
  });

  it('maps a provider CR to the API shape with its catalog entry', () => {
    const p = toInstalledProvider(
      provider(
        {
          installedVersion: 'v0.15.0',
          conditions: [{ type: 'Ready', status: 'True', reason: 'x', message: 'ok' }],
        },
        {
          spec: {
            version: 'v0.15.0',
            configSecret: { name: 's' },
            manager: { featureGates: { A: true } },
            fetchConfig: { url: 'https://x' },
          },
        },
      ),
    );
    expect(p).toMatchObject({
      catalogId: 'openstack',
      installedVersion: 'v0.15.0',
      configSecret: { name: 's' },
      featureGates: { A: true },
      fetchConfigUrl: 'https://x',
    });
  });

  it('finds workload clusters that use a provider (FP3-F-12)', async () => {
    const clusters = [
      {
        metadata: { name: 'os', namespace: 'a' },
        spec: {
          infrastructureRef: { kind: 'OpenStackCluster' },
          controlPlaneRef: { kind: 'RKE2ControlPlane' },
        },
      },
      {
        metadata: { name: 'aws', namespace: 'b' },
        spec: {
          infrastructureRef: { kind: 'AWSCluster' },
          controlPlaneRef: { kind: 'KubeadmControlPlane' },
        },
      },
    ];
    const kc = {
      makeApiClient: () => ({ listClusterCustomObject: async () => ({ items: clusters }) }),
    } as unknown as KubeConfig;
    const names = async (id: string) =>
      (await clustersUsing(kc, catalogEntry(id)!)).map((c) => c.name);
    expect(await names('openstack')).toEqual(['os']);
    expect(await names('aws')).toEqual(['aws']);
    expect(await names('rke2-control-plane')).toEqual(['os']);
    expect(await names('kubeadm-bootstrap')).toEqual(['aws']);
    expect(await names('core')).toEqual(['os', 'aws']);
    expect(await names('helm')).toEqual([]);
  });

  it('treats missing CAPI CRDs as "no clusters"', async () => {
    const kc = {
      makeApiClient: () => ({
        listClusterCustomObject: async () => {
          throw Object.assign(new Error('nf'), { code: 404 });
        },
      }),
    } as unknown as KubeConfig;
    expect(await clustersUsing(kc, catalogEntry('core')!)).toEqual([]);
  });
});

describe('release lists (FP3-F-07)', () => {
  const releases = [
    { tag_name: 'v1.2.0', draft: false, prerelease: false },
    { tag_name: 'v1.10.0', draft: false, prerelease: false },
    { tag_name: 'v1.11.0-rc.1', draft: false, prerelease: true },
    { tag_name: 'v1.9.9', draft: true, prerelease: false },
  ];

  it('filters, sorts semantically and caches', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(releases)));
    const fetcher = new ReleaseFetcher(fetchFn as unknown as typeof fetch, () => 0);
    expect(await fetcher.versions('o/r', 'v1.2.0')).toEqual({
      versions: ['v1.10.0', 'v1.2.0'],
      live: true,
    });
    await fetcher.versions('o/r', 'v1.2.0');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await fetcher.versions('o/r', 'v1.3.0')).versions).toEqual([
      'v1.10.0',
      'v1.3.0',
      'v1.2.0',
    ]);
  });

  it('falls back to the catalog version when GitHub is unreachable', async () => {
    const fetcher = new ReleaseFetcher((async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    expect(await fetcher.versions('o/r', 'v1.0.0')).toEqual({ versions: ['v1.0.0'], live: false });
  });
});

describe('ORC manifest (FP3-F-04a)', () => {
  const manifest = `
apiVersion: v1
kind: Namespace
metadata: { name: orc-system }
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: servers.openstack.k-orc.cloud }
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: flavors.openstack.k-orc.cloud }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: orc-controller-manager, namespace: orc-system }
---
`;

  it('adds the clusterctl move label to the ORC CRDs CAPO needs (POS-05)', () => {
    const objects = parseOrcManifest(manifest);
    expect(objects).toHaveLength(4);
    expect(objects[1]!.metadata?.labels).toEqual({ 'clusterctl.cluster.x-k8s.io/move': '' });
    expect(objects[2]!.metadata?.labels).toBeUndefined();
  });

  it('rejects files that are not an ORC manifest', () => {
    expect(() =>
      parseOrcManifest('apiVersion: v1\nkind: Namespace\nmetadata: { name: x }\n'),
    ).toThrow(/does not look like/);
    expect(() => parseOrcManifest('kind: Namespace\n')).toThrow(/without apiVersion/);
  });

  it('downloads only the release asset and reports errors clearly', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.endsWith('/v2.6.0/install.yaml')
        ? new Response(manifest)
        : new Response('', { status: 404 }),
    );
    expect(await fetchOrcManifest('v2.6.0', fetchFn as unknown as typeof fetch)).toHaveLength(4);
    expect(fetchFn.mock.calls[0]![0]).toBe(
      'https://github.com/k-orc/openstack-resource-controller/releases/download/v2.6.0/install.yaml',
    );
    await expect(fetchOrcManifest('v9.9.9', fetchFn as unknown as typeof fetch)).rejects.toThrow(
      OrcManifestError,
    );
    await expect(
      fetchOrcManifest('v2.6.0', (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch),
    ).rejects.toThrow(/not reachable/);
  });
});
