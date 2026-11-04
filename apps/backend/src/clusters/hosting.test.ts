import { CoreV1Api } from '@kubernetes/client-node';
import {
  ClusterSpecSchema,
  registryContentsView,
  type ClusterSpecInput,
} from '@capi-navigator/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cpuMillis,
  hostAccess,
  hostFacts,
  hostServiceAddresses,
  memoryMiB,
  readHostView,
  readHostedTenantImages,
  readTenantView,
  specOf,
} from './hosting.js';

// FP-24, ADR-0034: reads between hosted control planes and their hosts.
const proxmox = {
  provider: 'proxmox' as const,
  credentialRef: 'homelab',
  sourceNode: 'homeserver',
  image: '7211',
  storage: 'local-zfs',
};
const hostInput: ClusterSpecInput = {
  name: 'host',
  namespace: 'team-a',
  kubernetes: { flavor: 'k0s', version: 'v1.35.9+k0s.0' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'small' },
    workerPools: [{ name: 'default', replicas: 3, machineSize: 'small' }],
  },
  infrastructure: {
    ...proxmox,
    network: {
      nodeCidr: '192.168.10.0/24',
      gateway: '192.168.10.1',
      addresses: ['192.168.10.72-192.168.10.77'],
      loadBalancerAddresses: ['192.168.10.78-192.168.10.80'],
    },
    apiEndpoint: '192.168.10.71',
  },
  controlPlaneHost: true,
};
const tenantInput: ClusterSpecInput = {
  name: 'tenant',
  namespace: 'team-a',
  kubernetes: { flavor: 'k0s', version: 'v1.35.9+k0s.0' },
  topology: {
    mode: 'hosted',
    controlPlane: { replicas: 3, machineSize: 'small' },
    workerPools: [{ name: 'default', replicas: 2, machineSize: 'small' }],
    hosted: { host: 'host' },
  },
  infrastructure: {
    ...proxmox,
    network: {
      nodeCidr: '192.168.10.0/24',
      gateway: '192.168.10.1',
      addresses: ['192.168.10.81-192.168.10.85'],
    },
    apiEndpoint: '192.168.10.78',
  },
};
const host = ClusterSpecSchema.parse(hostInput);
const registry = {
  host: 'registry.example.internal',
  mirrors: [{ upstream: 'quay.io', path: 'proxy-quay-io' }],
  artifactsPath: 'library',
};
const tenant = ClusterSpecSchema.parse(tenantInput);
const clusterObject = (spec: unknown, extra: Record<string, unknown> = {}) => ({
  metadata: {
    name: (spec as { name: string }).name,
    annotations: { 'capi-navigator.io/cluster-spec': JSON.stringify(spec) },
    ...extra,
  },
  status: { conditions: [{ type: 'Available', status: 'True' }] },
});
const kubeconfigSecret = { data: { value: Buffer.from('kubeconfig').toString('base64') } };

/** Management cluster with the host, one tenant and the host's kubeconfig Secret. */
function management(opts: { kubeconfig?: boolean } = {}) {
  const custom = {
    getNamespacedCustomObject: async ({ name }: { name: string }) => {
      if (name !== 'host') throw Object.assign(new Error('not found'), { code: 404 });
      return clusterObject(hostInput);
    },
    listNamespacedCustomObject: async () => ({ items: [clusterObject(tenantInput)] }),
  };
  const core = {
    readNamespacedSecret: async () => {
      if (opts.kubeconfig === false) throw Object.assign(new Error('not found'), { code: 404 });
      return kubeconfigSecret;
    },
  };
  return { makeApiClient: (api: unknown) => (api === CoreV1Api ? core : custom) } as never;
}

/** The host cluster: three workers, a tainted control plane node, Services and the tenant's pods. */
function fakeHost(opts: { down?: boolean; podsDown?: boolean } = {}) {
  const node = (name: string, taint?: boolean) => ({
    metadata: { name },
    spec: taint
      ? { taints: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] }
      : {},
    status: { allocatable: { cpu: '2', memory: '3911528Ki' } },
  });
  const fail = async () => {
    throw new Error('connect ETIMEDOUT');
  };
  return {
    listNode: opts.down
      ? fail
      : async () => ({ items: [node('cp', true), node('w1'), node('w2'), node('w3')] }),
    listServiceForAllNamespaces: async () => ({
      items: [
        {
          metadata: { namespace: 'team-a', name: 'kmc-tenant-lb' },
          spec: { type: 'LoadBalancer' },
          status: { loadBalancer: { ingress: [{ ip: '192.168.10.78' }] } },
        },
        {
          metadata: {
            namespace: 'web',
            name: 'shop',
            annotations: { 'kube-vip.io/loadbalancerIPs': '192.168.10.79' },
          },
          spec: { type: 'LoadBalancer' },
        },
        { metadata: { namespace: 'web', name: 'internal' }, spec: { type: 'ClusterIP' } },
      ],
    }),
    listNamespacedPod: opts.podsDown
      ? fail
      : async () => ({
          items: [
            {
              metadata: {
                name: 'kmc-tenant-etcd-0',
                labels: { app: 'k0smotron', cluster: 'tenant', component: 'etcd' },
              },
              spec: {
                nodeName: 'w1',
                // k0smotron keeps the init image of the version the tenant was created with.
                initContainers: [{ image: 'quay.io/k0sproject/k0s:v1.34.12-k0s.0' }],
                containers: [{ image: 'quay.io/k0sproject/etcd:v3.7.1' }],
              },
              status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
            },
            {
              metadata: {
                name: 'kmc-tenant-0',
                labels: { app: 'k0smotron', cluster: 'tenant', component: 'cluster' },
              },
              spec: {
                nodeName: 'w2',
                containers: [{ image: 'quay.io/k0sproject/k0s:v1.35.9-k0s.0' }],
              },
              status: { phase: 'Pending', conditions: [] },
            },
          ],
        }),
    listNamespacedPersistentVolumeClaim: async () => ({
      items: [
        {
          metadata: { name: 'etcd-data-kmc-tenant-etcd-0' },
          status: { phase: 'Bound', capacity: { storage: '1Gi' } },
        },
        { metadata: { name: 'other' }, status: { phase: 'Bound' } },
      ],
    }),
    readNamespacedService: async () => ({
      metadata: { name: 'kmc-tenant-lb' },
      spec: { ports: [{ port: 6443 }, { port: 8132 }] },
      status: { loadBalancer: { ingress: [{ ip: '192.168.10.78' }] } },
    }),
  };
}

describe('hosts of hosted control planes (FP-24)', () => {
  const original = hostAccess.api;
  afterEach(() => {
    hostAccess.api = original;
  });

  it('parses Kubernetes quantities', () => {
    expect(cpuMillis('2')).toBe(2000);
    expect(cpuMillis('1900m')).toBe(1900);
    expect(memoryMiB('3911528Ki')).toBe(3820);
    expect(memoryMiB('4Gi')).toBe(4096);
    expect(memoryMiB('512Mi')).toBe(512);
    expect(memoryMiB(undefined)).toBe(0);
  });

  it('reads the stored spec only from clusters of the app', () => {
    expect(specOf(clusterObject(hostInput) as never)?.name).toBe('host');
    expect(specOf({ metadata: { name: 'x' } } as never)).toBeUndefined();
    expect(
      specOf({
        metadata: { name: 'x', annotations: { 'capi-navigator.io/cluster-spec': '{' } },
      } as never),
    ).toBeUndefined();
  });

  it('collects the facts about a host (FP24-F-03)', async () => {
    expect(await hostFacts(management(), 'team-a', 'host')).toMatchObject({
      available: true,
      deleting: false,
      kubeconfig: true,
    });
    expect((await hostFacts(management({ kubeconfig: false }), 'team-a', 'host'))?.kubeconfig).toBe(
      false,
    );
    expect(await hostFacts(management(), 'team-a', 'nope')).toBeUndefined();
  });

  it('knows the addresses of LoadBalancer Services in the host, except the tenant own (FP24-F-06)', async () => {
    hostAccess.api = () => fakeHost() as never;
    expect(await hostServiceAddresses('kubeconfig')).toEqual(['192.168.10.78', '192.168.10.79']);
    expect(
      await hostServiceAddresses('kubeconfig', { namespace: 'team-a', tenant: 'tenant' }),
    ).toEqual(['192.168.10.79']);
  });

  it('shows tenants, requests, capacity and free addresses of a host (FP24-F-11, FP24-F-12)', async () => {
    hostAccess.api = () => fakeHost() as never;
    const view = await readHostView(management(), host);
    expect(view.tenants).toEqual([
      { namespace: 'team-a', name: 'tenant', replicas: 3, cpuMillis: 450, memoryMiB: 1920 },
    ]);
    expect(view.schedulableNodes).toBe(3);
    // The tainted control plane node does not count.
    expect(view.allocatable).toEqual({ cpuMillis: 6000, memoryMiB: 11460 });
    expect(view.freeAddresses).toEqual(['192.168.10.80']);
    expect(view.warnings).toEqual([]);
  });

  it('reports a host that does not answer or has no kubeconfig yet', async () => {
    hostAccess.api = () => fakeHost({ down: true }) as never;
    expect((await readHostView(management(), host)).warnings[0]).toContain('does not answer');
    expect((await readHostView(management({ kubeconfig: false }), host)).warnings[0]).toContain(
      'no kubeconfig yet',
    );
  });

  it('reads the images the control planes of its tenants run in a host (FP24-F-14)', async () => {
    hostAccess.api = () => fakeHost() as never;
    expect(await readHostedTenantImages(management(), host)).toEqual({
      tenants: [
        {
          name: 'tenant',
          version: 'v1.35.9+k0s.0',
          running: [
            'quay.io/k0sproject/etcd:v3.7.1',
            'quay.io/k0sproject/k0s:v1.34.12-k0s.0',
            'quay.io/k0sproject/k0s:v1.35.9-k0s.0',
          ],
        },
      ],
      warnings: [],
    });
    const listed = registryContentsView(
      ClusterSpecSchema.parse({ ...hostInput, airGapped: { registry } }),
      {},
      (await readHostedTenantImages(management(), host)).tenants,
    )!.images.filter((i) => i.usedBy === 'Hosted control plane tenant');
    expect(listed.map((i) => i.target)).toEqual([
      'registry.example.internal/proxy-quay-io/k0sproject/k0s:v1.35.9-k0s.0',
      'registry.example.internal/proxy-quay-io/k0sproject/etcd:v3.7.1',
      'registry.example.internal/proxy-quay-io/k0sproject/k0s:v1.34.12-k0s.0',
    ]);
    hostAccess.api = () => fakeHost({ down: true, podsDown: true }) as never;
    const down = await readHostedTenantImages(management(), host);
    expect(down.tenants).toEqual([{ name: 'tenant', version: 'v1.35.9+k0s.0' }]);
    expect(down.warnings[0]).toContain('does not answer');
    expect(
      (await readHostedTenantImages(management({ kubeconfig: false }), host)).warnings[0],
    ).toContain('no kubeconfig yet');
  });

  it('shows where the control plane of a tenant runs (FP24-F-11)', async () => {
    hostAccess.api = () => fakeHost() as never;
    const view = await readTenantView(management(), tenant);
    expect(view.host).toEqual({ namespace: 'team-a', name: 'host' });
    expect(view.service).toEqual({
      name: 'kmc-tenant-lb',
      address: '192.168.10.78',
      ports: [6443, 8132],
    });
    expect(view.pods).toEqual([
      { name: 'kmc-tenant-0', component: 'controller', node: 'w2', phase: 'Pending', ready: false },
      { name: 'kmc-tenant-etcd-0', component: 'etcd', node: 'w1', phase: 'Running', ready: true },
    ]);
    expect(view.volumes).toEqual([
      { name: 'etcd-data-kmc-tenant-etcd-0', size: '1Gi', phase: 'Bound' },
    ]);
    expect((await readTenantView(management({ kubeconfig: false }), tenant)).warnings[0]).toContain(
      'has no kubeconfig',
    );
  });
});
