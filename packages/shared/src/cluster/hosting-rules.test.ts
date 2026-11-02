import { describe, expect, it } from 'vitest';
import { applySpecChange, CONTROL_PLANE_GROUP, SpecChangeError } from './changes.js';
import {
  freeAddresses,
  hostedTenantProblems,
  schedulableHostNodes,
  tenantRequests,
  type HostFacts,
} from './hosting.js';
import { ClusterSpecSchema, HOST_LABEL, type ClusterSpecInput } from './spec.js';
import { transform } from './transform.js';

// FP-24, ADR-0034: rules between hosted control planes and their hosts.
const proxmox = (over: Record<string, unknown> = {}) => ({
  provider: 'proxmox' as const,
  credentialRef: 'homelab',
  sourceNode: 'homeserver',
  image: '7211',
  storage: 'local-zfs',
  network: {
    nodeCidr: '192.168.10.0/24',
    gateway: '192.168.10.1',
    addresses: ['192.168.10.72-192.168.10.77'],
    loadBalancerAddresses: ['192.168.10.78-192.168.10.80'],
  },
  apiEndpoint: '192.168.10.71',
  ...over,
});
const hostInput = (workers = 3): ClusterSpecInput => ({
  name: 'host',
  namespace: 'team-a',
  kubernetes: { flavor: 'k0s', version: 'v1.35.9+k0s.0' },
  topology: {
    mode: 'standard',
    controlPlane: { replicas: 1, machineSize: 'small' },
    workerPools: [{ name: 'default', replicas: workers, machineSize: 'small' }],
  },
  infrastructure: proxmox(),
  controlPlaneHost: true,
});
const tenantInput = (replicas: 1 | 3 = 3, apiEndpoint = '192.168.10.78'): ClusterSpecInput => ({
  name: 'tenant',
  namespace: 'team-a',
  kubernetes: { flavor: 'k0s', version: 'v1.35.9+k0s.0' },
  topology: {
    mode: 'hosted',
    controlPlane: { replicas, machineSize: 'small' },
    workerPools: [{ name: 'default', replicas: 2, machineSize: 'small' }],
    hosted: { host: 'host' },
  },
  infrastructure: proxmox({
    network: {
      nodeCidr: '192.168.10.0/24',
      gateway: '192.168.10.1',
      addresses: ['192.168.10.81-192.168.10.85'],
    },
    apiEndpoint,
  }),
});
const facts = (over: Partial<HostFacts> = {}): HostFacts => ({
  spec: ClusterSpecSchema.parse(hostInput()),
  available: true,
  deleting: false,
  kubeconfig: true,
  ...over,
});
const tenant = (replicas: 1 | 3 = 3, endpoint?: string) =>
  ClusterSpecSchema.parse(tenantInput(replicas, endpoint));

describe('hosts of hosted control planes (FP24-F-01)', () => {
  it('labels a host and needs a LoadBalancer and a CSI driver', () => {
    const cluster = transform(ClusterSpecSchema.parse(hostInput()), { credential: {} }).find(
      (o) => o.kind === 'Cluster',
    )!;
    expect(cluster.metadata.labels?.[HOST_LABEL]).toBe('true');
    const issues = (input: ClusterSpecInput) =>
      ClusterSpecSchema.safeParse(input).error?.issues.map((i) => i.message) ?? [];
    expect(
      issues({ ...hostInput(), addons: { cloudControllerManager: true, csiDriver: false } }),
    ).toContain('A host needs the CSI driver for the etcd volumes');
    const noLb = hostInput();
    noLb.infrastructure = proxmox({
      network: {
        nodeCidr: '192.168.10.0/24',
        gateway: '192.168.10.1',
        addresses: ['192.168.10.72'],
      },
    });
    expect(issues(noLb)).toContain(
      'A host needs LoadBalancer addresses for the control planes of its tenants',
    );
    expect(issues({ ...tenantInput(), controlPlaneHost: true })).toContain(
      'A cluster with a hosted control plane cannot be a host',
    );
  });

  it('is marked and unmarked as a day-2 change', () => {
    const plain = ClusterSpecSchema.parse({ ...hostInput(), controlPlaneHost: undefined });
    const marked = applySpecChange(plain, { type: 'controlPlaneHost', enabled: true }, new Date());
    expect(marked.controlPlaneHost).toBe(true);
    const unmarked = applySpecChange(
      marked,
      { type: 'controlPlaneHost', enabled: false },
      new Date(),
    );
    expect(unmarked).not.toHaveProperty('controlPlaneHost');
  });

  it('counts the nodes that take tenant pods', () => {
    expect(schedulableHostNodes(ClusterSpecSchema.parse(hostInput(2)))).toBe(2);
    const aio = ClusterSpecSchema.parse({
      ...hostInput(),
      topology: {
        mode: 'all-in-one',
        controlPlane: { replicas: 3, machineSize: 'small' },
        workerPools: [],
      },
    });
    expect(schedulableHostNodes(aio)).toBe(3);
  });
});

describe('tenants on their host (FP24-F-03, FP24-F-06)', () => {
  it('accepts a tenant that fits its host', () => {
    expect(hostedTenantProblems(tenant(), facts())).toEqual([]);
  });

  it('names what is wrong with the host', () => {
    expect(hostedTenantProblems(tenant(), undefined)).toEqual([
      'The host cluster team-a/host does not exist.',
    ]);
    expect(hostedTenantProblems(tenant(), facts({ spec: undefined }))[0]).toContain(
      'not created by the app',
    );
    const unmarked = ClusterSpecSchema.parse({ ...hostInput(), controlPlaneHost: undefined });
    expect(hostedTenantProblems(tenant(), facts({ spec: unmarked }))[0]).toContain('not marked');
    expect(hostedTenantProblems(tenant(), facts({ deleting: true }))[0]).toContain('being deleted');
    expect(hostedTenantProblems(tenant(), facts({ available: false, kubeconfig: false }))).toEqual([
      'The host cluster team-a/host is not available yet.',
      'The kubeconfig Secret of the host cluster team-a/host is missing.',
    ]);
  });

  it('keeps tenants on the host infrastructure and credential', () => {
    const other = ClusterSpecSchema.parse({
      ...tenantInput(),
      infrastructure: { ...tenantInput().infrastructure, credentialRef: 'other' },
    });
    expect(hostedTenantProblems(other, facts())[0]).toContain(
      "host's infrastructure and credential",
    );
  });

  it('needs a host worker per replica (hard spread, ADR-0034)', () => {
    const small = facts({ spec: ClusterSpecSchema.parse(hostInput(2)) });
    expect(hostedTenantProblems(tenant(3), small)[0]).toContain('need 3 worker nodes');
    expect(hostedTenantProblems(tenant(1), small)).toEqual([]);
  });

  it('takes the Proxmox VE address from the host LoadBalancer range', () => {
    expect(hostedTenantProblems(tenant(3, '192.168.10.90'), facts())[0]).toContain(
      "must be one of the host's LoadBalancer addresses",
    );
    expect(freeAddresses(['192.168.10.78-192.168.10.80'], ['192.168.10.78'], 2)).toEqual([
      '192.168.10.79',
      '192.168.10.80',
    ]);
    expect(freeAddresses(['192.168.10.78'], ['192.168.10.78'], 2)).toEqual([]);
  });

  it('adds up the requests of a control plane (FP24-F-12)', () => {
    expect(tenantRequests(3)).toEqual({ cpuMillis: 450, memoryMiB: 1920 });
  });
});

describe('day-2 changes of hosted tenants (FP24-F-10)', () => {
  it('keeps replicas and refuses control plane machine changes', () => {
    const spec = tenant();
    expect(() =>
      applySpecChange(spec, { type: 'scaleControlPlane', replicas: 1 }, new Date()),
    ).toThrow(SpecChangeError);
    for (const change of [
      { type: 'machine' as const, group: CONTROL_PLANE_GROUP, machineSize: 'large' },
      { type: 'rebuild' as const, group: CONTROL_PLANE_GROUP },
    ]) {
      expect(() => applySpecChange(spec, change, new Date())).toThrow('has no machines');
    }
    expect(
      applySpecChange(spec, { type: 'rebuild', group: 'default' }, new Date()).topology
        .workerPools[0]!.rebuildRequestedAt,
    ).toBeDefined();
  });

  it('lets the workers follow an upgrade', () => {
    const next = applySpecChange(
      tenant(),
      { type: 'upgrade', version: 'v1.36.5+k0s.0' },
      new Date(),
    );
    expect(next.kubernetes).toMatchObject({
      version: 'v1.36.5+k0s.0',
      workerVersion: 'v1.35.9+k0s.0',
    });
  });
});
