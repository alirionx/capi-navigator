import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXMOX_MACHINE_SIZES } from '../credentials.js';
import { renderManifests } from '../operator-manifests.js';
import { proxmoxPlugin } from './proxmox.js';
import { ClusterSpecSchema, type ClusterSpecInput } from './spec.js';
import { transform, type TransformContext } from './transform.js';

const ctx: TransformContext = { credential: { machineSizes: DEFAULT_PROXMOX_MACHINE_SIZES } };

const pve = (over: Partial<ClusterSpecInput> = {}): ClusterSpecInput => ({
  name: 'pve',
  namespace: 'proxmox',
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 3, machineSize: 'medium' },
    workerPools: [{ name: 'default', replicas: 2, machineSize: 'large', rootVolumeSizeGB: 80 }],
  },
  infrastructure: {
    provider: 'proxmox',
    credentialRef: 'homelab',
    sourceNode: 'homeserver',
    image: '7112',
    storage: 'local-zfs',
    bootDisk: 'virtio0',
    network: {
      nodeCidr: '192.168.10.0/24',
      gateway: '192.168.10.1',
      addresses: ['192.168.10.71-192.168.10.88'],
    },
    apiEndpoint: '192.168.10.89',
  },
  ...over,
});
const allInOne = (base: ClusterSpecInput): ClusterSpecInput => ({
  ...base,
  name: `${base.name}-aio`,
  topology: {
    mode: 'all-in-one',
    controlPlane: { replicas: 1, machineSize: 'medium' },
    workerPools: [],
  },
});
const k0s = (base: ClusterSpecInput): ClusterSpecInput => ({
  ...base,
  kubernetes: { flavor: 'k0s', version: 'v1.35.8+k0s.1' },
});
const kubeadm = (base: ClusterSpecInput): ClusterSpecInput => ({
  ...base,
  kubernetes: { flavor: 'kubeadm', version: 'v1.35.9' },
});
const render = (input: ClusterSpecInput) =>
  renderManifests(transform(ClusterSpecSchema.parse(input), ctx));

describe('Proxmox VE transformation snapshots (FP31-F-06, FP31-F-07)', () => {
  it('RKE2 standard', () => expect(render(pve())).toMatchSnapshot());
  it('RKE2 all-in-one', () => expect(render(allInOne(pve()))).toMatchSnapshot());
  it('k0s standard', () => expect(render(k0s(pve()))).toMatchSnapshot());
  it('k0s all-in-one', () => expect(render(allInOne(k0s(pve())))).toMatchSnapshot());
  it('kubeadm standard', () => expect(render(kubeadm(pve()))).toMatchSnapshot());
  it('kubeadm all-in-one', () => expect(render(allInOne(kubeadm(pve())))).toMatchSnapshot());
});

describe('Proxmox VE rules (FP31-F-06..10)', () => {
  const objects = (input: ClusterSpecInput) => transform(ClusterSpecSchema.parse(input), ctx);
  const find = (input: ClusterSpecInput, kind: string) =>
    objects(input).filter((o) => o.kind === kind) as unknown as {
      metadata: { name: string; annotations?: Record<string, string> };
      spec: Record<string, unknown>;
    }[];

  it('sizes come from the credential, the root disk is grown, a copy of the Secret is used', () => {
    const [cluster] = find(pve(), 'ProxmoxCluster');
    expect(cluster!.metadata.annotations).toEqual({ 'capi-navigator.io/credential': 'homelab' });
    expect(cluster!.spec).toMatchObject({
      controlPlaneEndpoint: { host: '192.168.10.89', port: 6443 },
      ipv4Config: {
        addresses: ['192.168.10.71-192.168.10.88'],
        prefix: 24,
        gateway: '192.168.10.1',
      },
      allowedNodes: ['homeserver'],
      schedulerHints: { memoryAdjustment: 0 },
      credentialsRef: { name: 'pve-proxmox-credentials', namespace: 'proxmox' },
    });
    const templates = find(pve(), 'ProxmoxMachineTemplate').map(
      (t) => (t.spec as { template: { spec: Record<string, unknown> } }).template.spec,
    );
    expect(templates.map((t) => [t.numCores, t.memoryMiB, t.disks])).toEqual([
      [4, 8192, { bootVolume: { disk: 'virtio0', sizeGb: 40 } }],
      [8, 16384, { bootVolume: { disk: 'virtio0', sizeGb: 80 } }],
    ]);
  });

  it('a changed size in the credential creates new machine templates (hard rule 5)', () => {
    const names = (sizes: typeof DEFAULT_PROXMOX_MACHINE_SIZES) =>
      transform(ClusterSpecSchema.parse(pve()), { credential: { machineSizes: sizes } })
        .filter((o) => o.kind === 'ProxmoxMachineTemplate')
        .map((o) => o.metadata.name);
    const bigger = DEFAULT_PROXMOX_MACHINE_SIZES.map((s) =>
      s.name === 'medium' ? { ...s, memoryMiB: 12288 } : s,
    );
    expect(names(bigger)[0]).not.toBe(names(DEFAULT_PROXMOX_MACHINE_SIZES)[0]);
    expect(names(bigger)[1]).toBe(names(DEFAULT_PROXMOX_MACHINE_SIZES)[1]);
  });

  it('refuses sizes the credential does not know', () => {
    const spec = ClusterSpecSchema.parse(pve());
    expect(proxmoxPlugin.validate!(spec, spec.infrastructure as never, ctx)).toEqual([]);
    const other = ClusterSpecSchema.parse({
      ...pve(),
      topology: { ...pve().topology, controlPlane: { replicas: 1, machineSize: 'huge' } },
    });
    expect(proxmoxPlugin.validate!(other, other.infrastructure as never, ctx)[0]).toMatch(
      /Machine size huge is not defined/,
    );
  });

  it('checks the VIP, the gateway and the node addresses against the network (FP31-F-08)', () => {
    const issues = (infra: Record<string, unknown>) =>
      ClusterSpecSchema.safeParse(
        pve({
          infrastructure: { ...(pve().infrastructure as object), ...infra } as never,
        }),
      ).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];
    expect(issues({})).toEqual([]);
    expect(issues({ apiEndpoint: '192.168.10.80' })).toEqual([
      'infrastructure.apiEndpoint: Must not be one of the node addresses',
    ]);
    expect(issues({ apiEndpoint: '10.0.0.5' })).toEqual([
      'infrastructure.apiEndpoint: Must be in the network 192.168.10.0/24',
    ]);
    expect(
      issues({
        network: {
          nodeCidr: '192.168.10.0/24',
          gateway: '192.168.11.1',
          addresses: ['192.168.10.1-192.168.10.20', '10.1.1.1'],
        },
      }),
    ).toEqual([
      'infrastructure.network.gateway: Outside the network 192.168.10.0/24',
      'infrastructure.network.addresses.1: Outside the network 192.168.10.0/24',
    ]);
    expect(
      issues({
        network: {
          nodeCidr: '192.168.10.0/24',
          gateway: '192.168.10.1',
          addresses: ['192.168.10.1-192.168.10.20'],
        },
      }),
    ).toEqual(['infrastructure.network.addresses: Must not contain the gateway']);
  });

  it('kube-vip per distribution, always with the node admin kubeconfig (FP31-F-07)', () => {
    // In-cluster credentials kept a leader with a dead API server holding the VIP (live test).
    const rke2 = JSON.stringify(find(allInOne(pve()), 'RKE2ControlPlane')[0]!.spec);
    expect(rke2).toContain('/var/lib/rancher/rke2/server/manifests/kube-vip.yaml');
    expect(rke2).toContain('path: /etc/rancher/rke2/rke2.yaml');
    expect(rke2).not.toContain('serviceAccountName');
    expect(rke2).toContain('"tlsSan":["192.168.10.89"]');
    const k = JSON.stringify(find(allInOne(k0s(pve())), 'K0sControlPlane')[0]!.spec);
    expect(k).toContain('/var/lib/k0s/manifests/kube-vip/kube-vip.yaml');
    expect(k).toContain('path: /var/lib/k0s/pki/admin.conf');
    expect(k).not.toContain('serviceAccountName');
    const kadm = JSON.stringify(find(kubeadm(pve()), 'KubeadmControlPlane')[0]!.spec);
    expect(kadm).toContain('/etc/kubernetes/manifests/kube-vip.yaml');
    expect(kadm).toContain('super-admin.conf');
  });

  it('k0s kubelets report the node address for the CCM (FP31-F-11, live test)', () => {
    const nodeIp =
      "--kubelet-extra-args=--node-ip=$(ip -4 -o route get 192.168.10.1 | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p')";
    const [cp] = find(k0s(pve()), 'K0sControlPlane');
    expect((cp!.spec as { k0sConfigSpec: { args: string[] } }).k0sConfigSpec.args).toContain(
      nodeIp,
    );
    const [worker] = find(k0s(pve()), 'K0sWorkerConfigTemplate');
    expect(JSON.stringify(worker!.spec)).toContain(JSON.stringify(nodeIp).slice(1, -1));
    // Without the CCM the kubelet keeps its own address handling.
    const noCcm = k0s(pve({ addons: { cloudControllerManager: false, csiDriver: false } }));
    expect(JSON.stringify(objects(noCcm))).not.toContain('--node-ip');
  });

  it('refuses node addresses and VIPs another cluster uses (FP31-F-08)', () => {
    const spec = ClusterSpecSchema.parse(pve());
    const other = (name: string, addresses: string[], host: string) => ({
      metadata: { name, namespace: 'proxmox' },
      spec: { ipv4Config: { addresses }, controlPlaneEndpoint: { host, port: 6443 } },
    });
    const conflicts = (others: Record<string, unknown>[]) =>
      proxmoxPlugin.addressConflicts!(spec, spec.infrastructure as never, others);
    // The cluster itself and clusters elsewhere in the network are fine.
    expect(
      conflicts([
        other('pve', ['192.168.10.71-192.168.10.88'], '192.168.10.89'),
        other('lab2', ['192.168.10.90-192.168.10.99'], '192.168.10.100'),
      ]),
    ).toEqual([]);
    expect(conflicts([other('lab3', ['192.168.10.85-192.168.10.95'], '192.168.10.89')])).toEqual([
      '192.168.10.71-192.168.10.88, 192.168.10.89 overlap with the addresses of cluster proxmox/lab3; choose addresses no other cluster uses.',
    ]);
  });
});
