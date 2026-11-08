import { describe, expect, it, vi } from 'vitest';
import { FetchError } from '../helm/fetch.js';
import { mirrorWarnings, splitImage } from './air-gap-mirrors.js';

const registry = {
  host: 'registry.example.internal',
  mirrors: [
    { upstream: 'docker.io', path: 'proxy-docker-io' },
    { upstream: 'registry.k8s.io', path: 'proxy-k8s-io' },
    { upstream: 'ghcr.io', path: 'proxy-ghcr-io' },
  ],
  artifactsPath: 'library',
};
const img = (source: string, target?: string) => ({
  source,
  ...(target ? { target } : {}),
  usedBy: 'test',
});
const images = [
  img(
    'docker.io/rancher/hardened-coredns:v1.14.7',
    'registry.example.internal/proxy-docker-io/rancher/hardened-coredns:v1.14.7',
  ),
  img(
    'docker.io/rancher/klipper-lb:v0.4.17',
    'registry.example.internal/proxy-docker-io/rancher/klipper-lb:v0.4.17',
  ),
  img('registry.k8s.io/pause:3.10.1', 'registry.example.internal/proxy-k8s-io/pause:3.10.1'),
  img(
    'ghcr.io/kube-vip/kube-vip:v1.3.1',
    'registry.example.internal/proxy-ghcr-io/kube-vip/kube-vip:v1.3.1',
  ),
  img('quay.io/unmirrored/image:v1'),
];

describe('mirrorWarnings (FP29-F-21)', () => {
  it('probes one image per used upstream, anonymously, and is quiet when all answer', async () => {
    const ociImageManifest = vi.fn().mockResolvedValue(undefined);
    expect(await mirrorWarnings(registry, images, { ociImageManifest })).toEqual([]);
    expect(ociImageManifest.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['proxy-docker-io/rancher/hardened-coredns', 'v1.14.7'],
      ['proxy-k8s-io/pause', '3.10.1'],
      ['proxy-ghcr-io/kube-vip/kube-vip', 'v1.3.1'],
    ]);
    // No credentials: the nodes pull anonymously.
    expect(ociImageManifest.mock.calls[0]![0]).toEqual({
      type: 'oci',
      url: 'oci://registry.example.internal',
    });
  });

  it('warns about a mirror that refuses anonymous pulls, naming its path', async () => {
    const ociImageManifest = vi.fn((_r: unknown, repository: string) =>
      repository.startsWith('proxy-k8s-io/')
        ? Promise.reject(new FetchError('refused', 401))
        : Promise.resolve(),
    );
    const warnings = await mirrorWarnings(registry, images, { ociImageManifest });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'refuses anonymous pulls of registry.example.internal/proxy-k8s-io/pause:3.10.1 (HTTP 401)',
    );
    expect(warnings[0]).toContain('registry.example.internal/proxy-k8s-io/ public');
  });

  it('warns about a missing image and counts the others of its upstream', async () => {
    const ociImageManifest = vi.fn((_r: unknown, repository: string) =>
      repository.startsWith('proxy-docker-io/')
        ? Promise.reject(new FetchError('not found', 404))
        : Promise.resolve(),
    );
    const [w] = await mirrorWarnings(registry, images, { ociImageManifest });
    expect(w).toContain(
      'proxy-docker-io/rancher/hardened-coredns:v1.14.7 is not in the internal registry',
    );
    expect(w).toContain('and 1 more image(s) from docker.io');
  });

  it('gives a single hint when the app cannot reach the registry', async () => {
    const ociImageManifest = vi
      .fn()
      .mockRejectedValue(new FetchError('Timeout contacting registry'));
    const warnings = await mirrorWarnings(registry, images, { ociImageManifest });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('could not check the mirrors');
    expect(warnings[0]).toContain('Timeout contacting registry');
  });

  it('passes the registry CA on', async () => {
    const ociImageManifest = vi.fn().mockResolvedValue(undefined);
    const caCert = '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----';
    await mirrorWarnings({ ...registry, caCert }, images.slice(0, 1), { ociImageManifest });
    expect(ociImageManifest.mock.calls[0]![0]).toMatchObject({ ca: caCert });
  });
});

describe('splitImage', () => {
  it('splits tags, digests and ports', () => {
    expect(splitImage('reg:5000/a/b:v1')).toEqual({ repository: 'a/b', reference: 'v1' });
    expect(splitImage('reg/a/b@sha256:abc')).toEqual({
      repository: 'a/b',
      reference: 'sha256:abc',
    });
    expect(splitImage('reg/a/b')).toEqual({ repository: 'a/b', reference: 'latest' });
  });
});
