import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXMOX_MACHINE_SIZES } from '../credentials.js';
import { renderManifests } from '../operator-manifests.js';
import { VERSIONS } from '../versions.generated.js';
import {
  ADDON_PRESETS,
  PROXMOX_LB_ADDRESSES_ANNOTATION,
  buildAddonPreset,
  presetsFor,
} from './addons.js';
import { applySpecChange, objectsTouchedBy } from './changes.js';
import { formatIpv4, ipv4StartEndRanges, parseIpv4 } from './cidr.js';
import { proxmoxPlugin } from './proxmox.js';
import { ClusterSpecSchema, type ClusterSpec, type ClusterSpecInput } from './spec.js';
import { transform, type TransformContext } from './transform.js';

const ctx: TransformContext = { credential: { machineSizes: DEFAULT_PROXMOX_MACHINE_SIZES } };
const now = new Date('2026-10-24T10:00:00Z');

const LB = ['10.20.0.120-10.20.0.127', '10.20.0.140'];

const pve = (loadBalancerAddresses: string[] | null = LB): ClusterSpecInput => ({
  name: 'pve-lb',
  namespace: 'proxmox',
  kubernetes: { version: 'v1.35.9+rke2r1' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'medium' },
    workerPools: [{ name: 'default', replicas: 2, machineSize: 'medium' }],
  },
  infrastructure: {
    provider: 'proxmox',
    credentialRef: 'homelab',
    sourceNode: 'homeserver',
    image: '7112',
    storage: 'local-zfs',
    network: {
      nodeCidr: '10.20.0.0/24',
      gateway: '10.20.0.1',
      addresses: ['10.20.0.71-10.20.0.88'],
      ...(loadBalancerAddresses ? { loadBalancerAddresses } : {}),
    },
    apiEndpoint: '10.20.0.89',
  },
});
const flavor = (
  base: ClusterSpecInput,
  kubernetes: ClusterSpecInput['kubernetes'],
): ClusterSpecInput => ({ ...base, kubernetes });
const parse = (input: ClusterSpecInput) => ClusterSpecSchema.parse(input);
const render = (input: ClusterSpecInput) => renderManifests(transform(parse(input), ctx));
const find = (spec: ClusterSpec, kind: string) =>
  transform(spec, ctx).find((o) => o.kind === kind)!;

describe('LoadBalancer Services on Proxmox VE: snapshots (FP-32)', () => {
  it('RKE2 standard', () => expect(render(pve())).toMatchSnapshot());
  it('k0s standard', () =>
    expect(render(flavor(pve(), { flavor: 'k0s', version: 'v1.35.8+k0s.1' }))).toMatchSnapshot());
  it('kubeadm standard', () =>
    expect(render(flavor(pve(), { flavor: 'kubeadm', version: 'v1.35.9' }))).toMatchSnapshot());
});

describe('LoadBalancer Services on Proxmox VE (FP32-F-01..06)', () => {
  it('selects the kube-vip presets and hands the range to them; nothing without a range', () => {
    const spec = parse(pve());
    const cluster = find(spec, 'Cluster');
    expect(cluster.metadata.labels).toMatchObject({ 'capi-navigator.io/loadbalancer': 'proxmox' });
    expect(find(spec, 'ProxmoxCluster').metadata.annotations).toMatchObject({
      [PROXMOX_LB_ADDRESSES_ANNOTATION]: '10.20.0.120-10.20.0.127,10.20.0.140-10.20.0.140',
    });
    expect(presetsFor(cluster.metadata.labels ?? {}).map((p) => p.id)).toEqual(
      expect.arrayContaining(['proxmox-kube-vip', 'proxmox-kube-vip-cloud-provider']),
    );

    const without = parse(pve(null));
    const plain = find(without, 'Cluster');
    expect(plain.metadata.labels).not.toHaveProperty(['capi-navigator.io/loadbalancer']);
    expect(find(without, 'ProxmoxCluster').metadata.annotations).not.toHaveProperty([
      PROXMOX_LB_ADDRESSES_ANNOTATION,
    ]);
    expect(presetsFor(plain.metadata.labels ?? {}).map((p) => p.kind)).not.toContain(
      'loadbalancer',
    );
  });

  it('runs kube-vip for Services only, with the image of the API endpoint instance (FP32-F-03)', () => {
    const kubeVip = ADDON_PRESETS.find((p) => p.id === 'proxmox-kube-vip')!;
    const values = kubeVip.valuesTemplate;
    expect(values).toContain(
      `repository: ghcr.io/kube-vip/kube-vip\n  tag: ${VERSIONS.images['kube-vip'].version}\n`,
    );
    for (const env of [
      'cp_enable: "false"',
      'svc_enable: "true"',
      'svc_election: "true"',
      'lb_enable: "false"',
      // The API endpoint instance serves its metrics on :2112 on the same host network.
      'prometheus_server: ":2113"',
    ]) {
      expect(values).toContain(env);
    }
    const proxy = buildAddonPreset(kubeVip, 'proxmox') as unknown as { spec: object };
    expect(proxy.spec).toMatchObject({
      clusterSelector: { matchLabels: { 'capi-navigator.io/loadbalancer': 'proxmox' } },
      repoURL: 'https://kube-vip.github.io/helm-charts',
      chartName: 'kube-vip',
      namespace: 'kube-system',
    });
  });

  it('reads the range per cluster from its ProxmoxCluster (FP32-F-04)', () => {
    const cloudProvider = ADDON_PRESETS.find((p) => p.id === 'proxmox-kube-vip-cloud-provider')!;
    expect(cloudProvider.valuesTemplate).toContain(
      `tag: ${VERSIONS.images['kube-vip-cloud-provider'].version}`,
    );
    expect(cloudProvider.valuesTemplate).toContain(
      `range-global: '{{ index .InfraCluster.metadata.annotations "${PROXMOX_LB_ADDRESSES_ANNOTATION}" }}'`,
    );
  });

  it('checks the range against the network, nodes, gateway and VIP (FP32-F-02)', () => {
    const issues = (loadBalancerAddresses: string[]) =>
      ClusterSpecSchema.safeParse(pve(loadBalancerAddresses)).error?.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`,
      ) ?? [];
    expect(issues(LB)).toEqual([]);
    expect(issues(['10.0.0.1-10.0.0.5', '10.20.0.80-10.20.0.85', '10.20.0.89'])).toEqual([
      'infrastructure.network.loadBalancerAddresses.0: Outside the network 10.20.0.0/24',
      'infrastructure.network.loadBalancerAddresses.1: Must not overlap the node addresses',
      'infrastructure.network.loadBalancerAddresses.2: Must not contain the gateway or the API virtual IP',
    ]);
    expect(issues(['10.20.0.1'])).toEqual([
      'infrastructure.network.loadBalancerAddresses.0: Must not contain the gateway or the API virtual IP',
    ]);
  });

  it('refuses LoadBalancer addresses another cluster uses, and sees theirs (FP32-F-02)', () => {
    const spec = parse(pve());
    const other = (name: string, annotation?: string) => ({
      metadata: {
        name,
        namespace: 'proxmox',
        ...(annotation ? { annotations: { [PROXMOX_LB_ADDRESSES_ANNOTATION]: annotation } } : {}),
      },
      spec: {
        ipv4Config: { addresses: ['10.20.0.150-10.20.0.159'] },
        controlPlaneEndpoint: { host: '10.20.0.160', port: 6443 },
      },
    });
    const conflicts = (others: Record<string, unknown>[]) =>
      proxmoxPlugin.addressConflicts!(spec, spec.infrastructure as never, others);
    expect(conflicts([other('lab2', '10.20.0.161-10.20.0.170')])).toEqual([]);
    expect(conflicts([other('lab3', '10.20.0.100-10.20.0.121')])).toEqual([
      '10.20.0.120-10.20.0.127 overlaps with the addresses of cluster proxmox/lab3; choose addresses no other cluster uses.',
    ]);
  });

  it('adds ranges on a running cluster or removes all, never some (FP32-F-05)', () => {
    const spec = parse(pve());
    const change = (values: Record<string, unknown>) =>
      applySpecChange(spec, { type: 'infrastructure', values } as never, now);
    const touched = (after: ClusterSpec) =>
      [...objectsTouchedBy(transform(spec, ctx), transform(after, ctx))].sort();

    const added = change({ 'network.loadBalancerAddresses': [...LB, '10.20.0.141'] });
    // No template changes: the presets follow the annotation by a Helm upgrade.
    expect(touched(added)).toEqual(['Cluster/pve-lb', 'ProxmoxCluster/pve-lb']);

    expect(() => change({ 'network.loadBalancerAddresses': ['10.20.0.140'] })).toThrow(
      /can only be added, or all removed: 10\.20\.0\.120-10\.20\.0\.127 must stay/,
    );

    const off = change({ 'network.loadBalancerAddresses': null });
    expect(off.infrastructure).not.toHaveProperty('network.loadBalancerAddresses');
    expect(find(off, 'Cluster').metadata.labels).not.toHaveProperty([
      'capi-navigator.io/loadbalancer',
    ]);
    expect(touched(off)).toEqual(['Cluster/pve-lb', 'ProxmoxCluster/pve-lb']);

    // A cluster without a range can switch it on later.
    const later = applySpecChange(
      parse(pve(null)),
      { type: 'infrastructure', values: { 'network.loadBalancerAddresses': LB } } as never,
      now,
    );
    expect(find(later, 'Cluster').metadata.labels).toMatchObject({
      'capi-navigator.io/loadbalancer': 'proxmox',
    });
  });

  it('shows the range in the infrastructure facts (FP32-F-06)', () => {
    const spec = parse(pve());
    expect(proxmoxPlugin.infraFacts(spec.infrastructure as never)).toContainEqual({
      label: 'LoadBalancer addresses',
      value: '10.20.0.120-10.20.0.127, 10.20.0.140',
    });
  });

  it('writes ranges as kube-vip-cloud-provider reads them: always start-end', () => {
    expect(ipv4StartEndRanges(['10.0.0.5', '10.0.0.8-10.0.0.9', '10.0.1.0/30'])).toBe(
      '10.0.0.5-10.0.0.5,10.0.0.8-10.0.0.9,10.0.1.0-10.0.1.3',
    );
    expect(formatIpv4(parseIpv4('255.1.0.254')!)).toBe('255.1.0.254');
  });
});
