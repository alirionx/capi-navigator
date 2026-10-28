/* eslint-disable @typescript-eslint/no-explicit-any -- manifests are read loosely in this test */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXMOX_MACHINE_SIZES } from '../credentials.js';
import { renderManifests } from '../operator-manifests.js';
import { artifactPushCommands, containerdHostsFiles } from './air-gap.js';
import { k0sPlugin } from './k0s.js';
import { openstackPlugin } from './openstack.js';
import { proxmoxPlugin } from './proxmox.js';
import { rke2Plugin } from './rke2.js';
import { ClusterSpecSchema, type ClusterSpecInput } from './spec.js';
import { transform, type TransformContext } from './transform.js';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBexample\n-----END CERTIFICATE-----';
const registry = {
  host: 'registry.example.internal',
  caCert: CA,
  mirrors: [
    { upstream: 'docker.io', path: 'proxy-docker-io' },
    { upstream: 'registry.k8s.io', path: 'proxy-k8s-io' },
    { upstream: 'ghcr.io', path: 'proxy-ghcr-io' },
    { upstream: 'quay.io' },
  ],
  artifactsPath: 'library',
};
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const RKE2 = 'v1.35.9+rke2r1';
const K0S = 'v1.35.8+k0s.1';
const rke2Pin = (version: string, c: string) => ({
  version,
  repository: 'library/rke2-artifacts',
  files: [
    { name: 'rke2.linux-amd64.tar.gz', digest: digest(c) },
    { name: 'sha256sum-amd64.txt', digest: digest('b') },
    { name: 'install.sh', digest: digest('c') },
  ],
});
const k0sPin = (version: string, c: string) => ({
  version,
  repository: 'library/k0s-amd64',
  files: [{ name: 'k0s', digest: digest(c) }],
});

const proxmox = (over: Partial<ClusterSpecInput> = {}): ClusterSpecInput => ({
  name: 'offline',
  namespace: 'airgap',
  kubernetes: { version: RKE2 },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'medium' },
    workerPools: [{ name: 'default', replicas: 1, machineSize: 'large' }],
  },
  infrastructure: {
    provider: 'proxmox',
    credentialRef: 'homelab',
    sourceNode: 'pve1',
    image: '7114',
    storage: 'local-zfs',
    bootDisk: 'virtio0',
    network: {
      nodeCidr: '10.20.0.0/24',
      gateway: '10.20.0.1',
      addresses: ['10.20.0.71-10.20.0.79'],
      dnsNameservers: ['10.20.0.53'],
    },
    apiEndpoint: '10.20.0.80',
  },
  airGapped: { registry, artifacts: [rke2Pin(RKE2, 'a')] },
  ...over,
});
const openstack = (over: Partial<ClusterSpecInput> = {}): ClusterSpecInput => ({
  name: 'offline-os',
  namespace: 'airgap',
  kubernetes: { version: RKE2 },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'a2-ram4-disk0', rootVolumeSizeGB: 50 },
    workerPools: [{ name: 'default', replicas: 1, machineSize: 'a4-ram8-disk50-perf1' }],
  },
  infrastructure: {
    provider: 'openstack',
    credentialRef: 'internal',
    image: '6f1b2a3c-0d4e-4f5a-8b6c-7d8e9fa0b1c2',
    externalNetwork: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  },
  airGapped: { registry, artifacts: [rke2Pin(RKE2, 'a')] },
  ...over,
});
const k0s = (base: ClusterSpecInput): ClusterSpecInput => ({
  ...base,
  kubernetes: { flavor: 'k0s', version: K0S },
  airGapped: { registry, artifacts: [k0sPin(K0S, 'd')] },
});

const ctx: TransformContext = {
  credential: { cloudName: 'internal', machineSizes: DEFAULT_PROXMOX_MACHINE_SIZES },
};
const objects = (input: ClusterSpecInput) => transform(ClusterSpecSchema.parse(input), ctx);
const render = (input: ClusterSpecInput) => renderManifests(objects(input));
const specOf = (input: ClusterSpecInput, kind: string) =>
  objects(input).find((o) => o.kind === kind) as unknown as { spec: Record<string, any> };

describe('air-gapped transformation snapshots (FP-29 part B)', () => {
  it('RKE2 on Proxmox VE', () => expect(render(proxmox())).toMatchSnapshot());
  it('k0s on Proxmox VE', () => expect(render(k0s(proxmox()))).toMatchSnapshot());
  it('RKE2 on OpenStack', () => expect(render(openstack())).toMatchSnapshot());
  it('k0s on OpenStack', () => expect(render(k0s(openstack()))).toMatchSnapshot());
});

describe('air-gapped nodes (FP29-F-13..F-15)', () => {
  it('RKE2: air-gapped install, mirrors with rewrite, no airGappedChecksum, no online preparation', () => {
    const cp = specOf(proxmox(), 'RKE2ControlPlane').spec;
    expect(cp.agentConfig.airGapped).toBe(true);
    expect(JSON.stringify(cp)).not.toContain('airGappedChecksum');
    expect(cp.privateRegistriesConfig.mirrors).toEqual({
      'docker.io': {
        endpoint: ['https://registry.example.internal'],
        rewrite: { '^(.*)$': 'proxy-docker-io/$1' },
      },
      'registry.k8s.io': {
        endpoint: ['https://registry.example.internal'],
        rewrite: { '^(.*)$': 'proxy-k8s-io/$1' },
      },
      'ghcr.io': {
        endpoint: ['https://registry.example.internal'],
        rewrite: { '^(.*)$': 'proxy-ghcr-io/$1' },
      },
      'quay.io': { endpoint: ['https://registry.example.internal'] },
    });
    const commands: string[] = cp.preRKE2Commands;
    // The CA first, then the download; neither the guest agent nor kernel-modules-extra.
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('update-ca-certificates');
    expect(commands[1]).toBe(
      `python3 /usr/local/bin/capi-navigator-fetch-artifact https://registry.example.internal library/rke2-artifacts ${digest('a')} /opt/rke2-artifacts/rke2.linux-amd64.tar.gz 0644 ${digest('b')} /opt/rke2-artifacts/sha256sum-amd64.txt 0644 ${digest('c')} /opt/install.sh 0755 || exit 1`,
    );
    expect(cp.files.map((f: { path: string }) => f.path)).toEqual([
      '/etc/capi-navigator/registry-ca.crt',
      '/usr/local/bin/capi-navigator-fetch-artifact',
      '/var/lib/rancher/rke2/server/manifests/kube-vip.yaml',
    ]);
  });

  it('k0s: pre-installed binary and one hosts.toml per upstream registry', () => {
    const cp = specOf(k0s(proxmox()), 'K0sControlPlane').spec.k0sConfigSpec;
    expect(cp.preInstalledK0s).toBe(true);
    expect(cp.preK0sCommands[1]).toBe(
      `python3 /usr/local/bin/capi-navigator-fetch-artifact https://registry.example.internal library/k0s-amd64 ${digest('d')} /usr/local/bin/k0s 0755 || exit 1`,
    );
    expect(cp.files.map((f: { path: string }) => f.path)).toContain(
      '/etc/k0s/containerd.d/certs.d/docker.io/hosts.toml',
    );
    expect(containerdHostsFiles(registry, '/d').map((f) => f.content)).toEqual([
      'server = "https://registry-1.docker.io"\n\n[host."https://registry.example.internal/v2/proxy-docker-io"]\n  capabilities = ["pull", "resolve"]\n  override_path = true\n',
      'server = "https://registry.k8s.io"\n\n[host."https://registry.example.internal/v2/proxy-k8s-io"]\n  capabilities = ["pull", "resolve"]\n  override_path = true\n',
      'server = "https://ghcr.io"\n\n[host."https://registry.example.internal/v2/proxy-ghcr-io"]\n  capabilities = ["pull", "resolve"]\n  override_path = true\n',
      'server = "https://quay.io"\n\n[host."https://registry.example.internal/v2"]\n  capabilities = ["pull", "resolve"]\n  override_path = true\n',
    ]);
  });

  it('without a CA no trust store change', () => {
    const spec = proxmox({
      airGapped: { registry: { ...registry, caCert: undefined }, artifacts: [rke2Pin(RKE2, 'a')] },
    });
    const commands: string[] = specOf(spec, 'RKE2ControlPlane').spec.preRKE2Commands;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^python3 /);
  });

  it('workers download the artifact of their own version during an upgrade (FP29-F-16)', () => {
    const next = 'v1.36.1+rke2r1';
    const spec = proxmox({
      kubernetes: { version: next, workerVersion: RKE2 },
      airGapped: { registry, artifacts: [rke2Pin(next, 'e'), rke2Pin(RKE2, 'a')] },
    });
    expect(specOf(spec, 'RKE2ControlPlane').spec.preRKE2Commands[1]).toContain(digest('e'));
    const worker = specOf(spec, 'RKE2ConfigTemplate').spec.template.spec;
    expect(worker.preRKE2Commands[1]).toContain(digest('a'));
  });

  it('refuses a version without a pinned artifact', () => {
    expect(() => objects(proxmox({ airGapped: { registry, artifacts: [] } }))).toThrow(
      `No artifact of ${RKE2} is pinned`,
    );
  });

  it('refuses kubeadm, which installs from packages (FP29-F-11)', () => {
    expect(() =>
      objects(proxmox({ kubernetes: { flavor: 'kubeadm', version: 'v1.35.9' } })),
    ).toThrow('cannot be installed air-gapped');
  });

  it('clusters without the setting keep the online preparation', () => {
    const online = { ...proxmox(), airGapped: undefined };
    const cp = specOf(online, 'RKE2ControlPlane').spec;
    expect(cp.agentConfig.airGapped).toBeUndefined();
    expect(cp.privateRegistriesConfig).toBeUndefined();
    expect(cp.preRKE2Commands[0]).toContain('qemu-guest-agent');
  });
});

describe('DNS of air-gapped nodes', () => {
  it('warns about public resolvers, not about internal ones or online clusters', () => {
    const parsed = (input: ClusterSpecInput) => ClusterSpecSchema.parse(input);
    const pve = parsed(proxmox());
    expect(proxmoxPlugin.warnings!(pve, pve.infrastructure as never)).toEqual([]);
    const pub = parsed(
      proxmox({
        infrastructure: {
          ...(proxmox().infrastructure as object),
          network: { nodeCidr: '10.20.0.0/24', gateway: '10.20.0.1', addresses: ['10.20.0.71'] },
        } as ClusterSpecInput['infrastructure'],
      }),
    );
    expect(proxmoxPlugin.warnings!(pub, pub.infrastructure as never)[0]).toContain(
      'public DNS server(s) 1.1.1.1, 8.8.8.8',
    );
    const os = parsed(openstack());
    expect(openstackPlugin.warnings!(os, os.infrastructure as never)).toHaveLength(1);
    const online = parsed({ ...openstack(), airGapped: undefined });
    expect(openstackPlugin.warnings!(online, online.infrastructure as never)).toEqual([]);
  });
});

describe('artifact push commands (FP29-F-12)', () => {
  it('RKE2: downloads from the release, checks the tarball, pushes the files without a path', () => {
    expect(artifactPushCommands(registry, rke2Plugin.airGap!.artifact(RKE2))).toBe(
      [
        'mkdir -p rke2-artifacts-v1.35.9-rke2r1 && cd rke2-artifacts-v1.35.9-rke2r1',
        "curl -fL -o rke2.linux-amd64.tar.gz 'https://github.com/rancher/rke2/releases/download/v1.35.9%2Brke2r1/rke2.linux-amd64.tar.gz'",
        "curl -fL -o sha256sum-amd64.txt 'https://github.com/rancher/rke2/releases/download/v1.35.9%2Brke2r1/sha256sum-amd64.txt'",
        "curl -fL -o install.sh 'https://get.rke2.io'",
        "grep ' rke2.linux-amd64.tar.gz$' sha256sum-amd64.txt | sha256sum -c -",
        'oras push registry.example.internal/library/rke2-artifacts:v1.35.9-rke2r1 rke2.linux-amd64.tar.gz sha256sum-amd64.txt install.sh',
      ].join('\n'),
    );
  });

  it('k0s: the static binary', () => {
    expect(artifactPushCommands(registry, k0sPlugin.airGap!.artifact(K0S))).toBe(
      [
        'mkdir -p k0s-amd64-v1.35.8-k0s.1 && cd k0s-amd64-v1.35.8-k0s.1',
        "curl -fL -o k0s 'https://github.com/k0sproject/k0s/releases/download/v1.35.8%2Bk0s.1/k0s-v1.35.8%2Bk0s.1-amd64'",
        'oras push registry.example.internal/library/k0s-amd64:v1.35.8-k0s.1 k0s',
      ].join('\n'),
    );
  });
});
