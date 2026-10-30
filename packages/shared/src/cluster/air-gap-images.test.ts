import { describe, expect, it } from 'vitest';
import { VERSIONS } from '../versions.generated.js';
import { ADDON_PRESETS } from './addons.js';
import {
  imageCopyCommands,
  imagesInManifests,
  mirroredImage,
  normalizeImage,
  registryContents,
} from './air-gap-images.js';
import { AIR_GAP_IMAGES } from './air-gap-images.generated.js';
import { ClusterSpecSchema } from './spec.js';
import { FLAVOR_PLUGINS, INFRA_PLUGINS } from './transform.js';

const registry = {
  host: 'registry.example.internal',
  mirrors: [
    { upstream: 'docker.io', path: 'proxy-docker-io' },
    { upstream: 'registry.k8s.io', path: 'proxy-k8s-io' },
    { upstream: 'ghcr.io' },
  ],
  artifactsPath: 'library',
};

describe('image names (FP29-F-17)', () => {
  it('makes docker.io and library/ explicit, as containerd does', () => {
    expect(normalizeImage('nginx:1.29')).toBe('docker.io/library/nginx:1.29');
    expect(normalizeImage('rancher/pause:3.10')).toBe('docker.io/rancher/pause:3.10');
    expect(normalizeImage('quay.io/k0sproject/coredns:1.14')).toBe(
      'quay.io/k0sproject/coredns:1.14',
    );
    expect(normalizeImage('localhost:5000/x:1')).toBe('localhost:5000/x:1');
  });

  it('finds the images of rendered manifests', () => {
    const yaml = [
      'spec:',
      '  containers:',
      '    - name: a',
      '      image: "registry.k8s.io/provider-os/openstack-cloud-controller-manager:v1.37.1"',
      '    - image: rancher/x:1 # comment',
      '      name: b',
      '  imagePullPolicy: IfNotPresent',
      "      image: 'registry.k8s.io/provider-os/openstack-cloud-controller-manager:v1.37.1'",
    ].join('\n');
    expect(imagesInManifests(yaml)).toEqual([
      'docker.io/rancher/x:1',
      'registry.k8s.io/provider-os/openstack-cloud-controller-manager:v1.37.1',
    ]);
  });

  it('maps an image to the path of its registry, unmirrored registries to nothing', () => {
    expect(mirroredImage(registry, 'docker.io/rancher/pause:3.10')).toBe(
      'registry.example.internal/proxy-docker-io/rancher/pause:3.10',
    );
    expect(mirroredImage(registry, 'ghcr.io/kube-vip/kube-vip:v1.3.1')).toBe(
      'registry.example.internal/kube-vip/kube-vip:v1.3.1',
    );
    expect(mirroredImage(registry, 'quay.io/k0sproject/pause:3.10')).toBeUndefined();
  });

  it('copies the linux/amd64 image, digests with all platforms', () => {
    expect(
      imageCopyCommands([
        { source: 'docker.io/a/b:1', target: 'r/a/b:1', usedBy: 'x' },
        { source: 'docker.io/a/c@sha256:00', target: 'r/a/c@sha256:00', usedBy: 'x' },
        { source: 'quay.io/a/d:1', usedBy: 'x' },
      ]),
    ).toBe(
      [
        'skopeo copy --override-os linux --override-arch amd64 docker://docker.io/a/b:1 docker://r/a/b:1',
        'skopeo copy --all docker://docker.io/a/c@sha256:00 docker://r/a/c@sha256:00',
      ].join('\n'),
    );
  });
});

describe('generated image lists (FP29-F-17)', () => {
  const lists = AIR_GAP_IMAGES.distributions as Record<string, Record<string, readonly string[]>>;
  const presets = AIR_GAP_IMAGES.presets as Record<string, { version: string }>;

  // v1.33.13+rke2r3 was published without any assets upstream; the generator skips such releases.
  const broken = new Set(['v1.33.13+rke2r3']);
  it.each([
    ...VERSIONS.kubernetes.rke2.versions.map((v) => ['rke2', v.version]),
    ...VERSIONS.kubernetes.k0s.versions.map((v) => ['k0s', v.version]),
    ...VERSIONS.kubernetes.kubeadm.versions.map((v) => ['kubeadm', v.version]),
  ])('%s %s has its images: run pnpm airgap:images', (flavor, version) => {
    if (broken.has(version)) return;
    expect(lists[flavor]?.[version]?.length).toBeGreaterThan(5);
  });

  it.each(ADDON_PRESETS.map((p) => [p.id, p.version]))(
    'preset %s %s has its images: run pnpm airgap:images',
    (id, version) => {
      expect(presets[id]?.version).toBe(version);
    },
  );
});

describe('registry contents of a cluster (FP29-F-17)', () => {
  const spec = (over: object = {}) =>
    ClusterSpecSchema.parse({
      name: 'offline',
      kubernetes: { version: 'v1.35.9+rke2r1' },
      topology: {
        controlPlane: { replicas: 1, machineSize: 'medium' },
        workerPools: [{ name: 'default', replicas: 1, machineSize: 'large' }],
      },
      infrastructure: {
        provider: 'proxmox',
        credentialRef: 'homelab',
        sourceNode: 'pve1',
        image: '7114',
        storage: 'local-zfs',
        network: { nodeCidr: '10.20.0.0/24', gateway: '10.20.0.1', addresses: ['10.20.0.71'] },
        apiEndpoint: '10.20.0.80',
      },
      airGapped: { registry, artifacts: [] },
      ...over,
    });
  const contents = (s: ReturnType<typeof spec>, overrides = {}) =>
    registryContents(
      s,
      FLAVOR_PLUGINS[s.kubernetes.flavor]!,
      INFRA_PLUGINS[s.infrastructure.provider],
      overrides,
    );

  it('lists the artifact, the distribution, kube-vip and the presets of the cluster', () => {
    const c = contents(spec());
    expect(c.artifacts.map((a) => a.artifact.name)).toEqual(['rke2-artifacts']);
    expect(c.unknown).toEqual([]);
    const usedBy = new Set(c.images.map((i) => i.usedBy));
    expect(usedBy).toContain('RKE2 v1.35.9+rke2r1');
    expect(usedBy).toContain('kube-vip (API address)');
    expect([...usedBy].some((u) => u.includes('Proxmox'))).toBe(true);
    expect(
      c.images.find((i) => i.source.startsWith('docker.io/rancher/rke2-runtime'))?.target,
    ).toBe('registry.example.internal/proxy-docker-io/rancher/rke2-runtime:v1.35.9-rke2r1');
  });

  it('names add-ons it does not know, e.g. a preset on another chart version', () => {
    const c = contents(spec(), { 'proxmox-ccm': { version: '9.9.9' } });
    expect(c.unknown).toEqual(['Proxmox VE Cloud Controller Manager 9.9.9']);
  });

  it('kubeadm: images of the version and Calico, no artifacts (ADR-0032)', () => {
    const c = contents(spec({ kubernetes: { flavor: 'kubeadm', version: 'v1.36.5' } }));
    expect(c.artifacts).toEqual([]);
    expect(c.unknown).toEqual([]);
    const sources = c.images.filter((i) => i.usedBy === 'kubeadm v1.36.5').map((i) => i.source);
    expect(sources).toEqual(
      expect.arrayContaining([
        'registry.k8s.io/kube-apiserver:v1.36.5',
        'registry.k8s.io/pause:3.10.2',
        `quay.io/calico/node:${VERSIONS.cni.calico.version}`,
      ]),
    );
    expect(
      c.images.find((i) => i.source === 'registry.k8s.io/kube-apiserver:v1.36.5')?.target,
    ).toBe('registry.example.internal/proxy-k8s-io/kube-apiserver:v1.36.5');
  });

  it('lists both versions during an upgrade', () => {
    const c = contents(
      spec({ kubernetes: { version: 'v1.36.5+rke2r1', workerVersion: 'v1.35.9+rke2r1' } }),
    );
    expect(c.artifacts.map((a) => a.artifact.tag)).toEqual(['v1.36.5-rke2r1', 'v1.35.9-rke2r1']);
  });
});
