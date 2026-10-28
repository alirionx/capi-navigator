import type { ClusterSpec } from '@capi-navigator/shared';
import { ClusterSpecSchema } from '@capi-navigator/shared';
import { describe, expect, it, vi } from 'vitest';
import { FetchError } from '../helm/fetch.js';
import { pinArtifacts } from './air-gap-artifacts.js';

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const registry = {
  host: 'registry.example.internal',
  mirrors: [{ upstream: 'docker.io', path: 'proxy-docker-io' }],
  artifactsPath: 'library',
};
const spec = (kubernetes: object, artifacts: object[] = []): ClusterSpec =>
  ClusterSpecSchema.parse({
    name: 'offline',
    kubernetes,
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
    airGapped: { registry, artifacts },
  });
const rke2Layers = (c: string) => [
  {
    mediaType: 'application/vnd.oci.image.layer.v1.tar',
    digest: digest(c),
    title: 'rke2.linux-amd64.tar.gz',
  },
  {
    mediaType: 'application/vnd.oci.image.layer.v1.tar',
    digest: digest('b'),
    title: 'sha256sum-amd64.txt',
  },
  { mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: digest('c'), title: 'install.sh' },
];

describe('pinArtifacts (FP29-F-12, FP29-F-16)', () => {
  it('pins the layer digests of the version by file name', async () => {
    const source = { ociLayers: vi.fn().mockResolvedValue(rke2Layers('a')) };
    const res = await pinArtifacts(spec({ version: 'v1.35.9+rke2r1' }), source);
    expect(res.ready).toBe(true);
    expect(source.ociLayers).toHaveBeenCalledWith(
      { type: 'oci', url: 'oci://registry.example.internal' },
      'library/rke2-artifacts',
      'v1.35.9-rke2r1',
    );
    expect(res.spec.airGapped!.artifacts).toEqual([
      {
        version: 'v1.35.9+rke2r1',
        repository: 'library/rke2-artifacts',
        files: [
          { name: 'rke2.linux-amd64.tar.gz', digest: digest('a') },
          { name: 'sha256sum-amd64.txt', digest: digest('b') },
          { name: 'install.sh', digest: digest('c') },
        ],
      },
    ]);
  });

  it('keeps existing pins, adds the new version and drops versions no longer used', async () => {
    const old = {
      version: 'v1.35.9+rke2r1',
      repository: 'library/rke2-artifacts',
      files: [{ name: 'x', digest: digest('0') }],
    };
    const stale = { ...old, version: 'v1.34.1+rke2r1' };
    const source = { ociLayers: vi.fn().mockResolvedValue(rke2Layers('e')) };
    const res = await pinArtifacts(
      spec({ version: 'v1.36.1+rke2r1', workerVersion: 'v1.35.9+rke2r1' }, [stale, old]),
      source,
    );
    expect(source.ociLayers).toHaveBeenCalledTimes(1);
    expect(res.spec.airGapped!.artifacts.map((a) => a.version)).toEqual([
      'v1.36.1+rke2r1',
      'v1.35.9+rke2r1',
    ]);
    expect(res.spec.airGapped!.artifacts[1]).toEqual(old);
  });

  it('a missing artifact is a blocker with the push commands', async () => {
    const source = { ociLayers: vi.fn().mockRejectedValue(new FetchError('Not found', 404)) };
    const res = await pinArtifacts(spec({ flavor: 'k0s', version: 'v1.35.8+k0s.1' }), source);
    expect(res.ready).toBe(false);
    expect(res.blockers).toEqual([
      'Artifact registry.example.internal/library/k0s-amd64:v1.35.8-k0s.1 is missing in the internal registry; push it with the commands shown.',
    ]);
    expect(res.missing[0]!.commands).toContain(
      'oras push registry.example.internal/library/k0s-amd64:v1.35.8-k0s.1 k0s',
    );
  });

  it('takes the single layer of a one-file artifact pushed under another name', async () => {
    const source = {
      ociLayers: vi
        .fn()
        .mockResolvedValue([
          { mediaType: 'x', digest: digest('d'), title: 'k0s-v1.35.8+k0s.1-amd64' },
        ]),
    };
    const res = await pinArtifacts(spec({ flavor: 'k0s', version: 'v1.35.8+k0s.1' }), source);
    expect(res.spec.airGapped!.artifacts[0]!.files).toEqual([{ name: 'k0s', digest: digest('d') }]);
  });

  it('names missing files, an unreachable registry and kubeadm', async () => {
    const partial = { ociLayers: vi.fn().mockResolvedValue(rke2Layers('a').slice(0, 2)) };
    expect(
      (await pinArtifacts(spec({ version: 'v1.35.9+rke2r1' }), partial)).blockers[0],
    ).toContain('lacks install.sh');
    const down = { ociLayers: vi.fn().mockRejectedValue(new FetchError('connect ECONNREFUSED')) };
    expect((await pinArtifacts(spec({ version: 'v1.35.9+rke2r1' }), down)).blockers[0]).toContain(
      'could not be read: connect ECONNREFUSED',
    );
    const kubeadm = await pinArtifacts(spec({ flavor: 'kubeadm', version: 'v1.35.9' }), partial);
    expect(kubeadm.ready).toBe(false);
    expect(kubeadm.blockers[0]).toContain('cannot be installed air-gapped');
  });
});
