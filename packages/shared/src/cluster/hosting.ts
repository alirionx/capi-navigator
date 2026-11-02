import { z } from 'zod';
import { formatIpv4, ipv4RangesCover, parseIpv4, parseIpv4Range } from './cidr.js';
import { HOSTED_CONTROLLER_REQUESTS, HOSTED_ETCD_REQUESTS } from './k0s.js';
import type { ClusterSpec } from './spec.js';

/**
 * Rules between hosted control planes and their hosts (FP-24, ADR-0034): pure functions shared by
 * the backend checks and the wizard.
 */

/** Nodes of a host that take tenant pods: workers, or all nodes of an all-in-one cluster. */
export function schedulableHostNodes(host: ClusterSpec): number {
  return host.topology.mode === 'all-in-one'
    ? host.topology.controlPlane.replicas
    : host.topology.workerPools.reduce((n, p) => n + p.replicas, 0);
}

const cpuMillis = (v: string) => (v.endsWith('m') ? Number(v.slice(0, -1)) : Number(v) * 1000);
const memoryMiB = (v: string) =>
  v.endsWith('Gi') ? Number(v.slice(0, -2)) * 1024 : Number(v.replace(/Mi$/, ''));

/** FP24-F-12: what the control plane of a tenant requests in its host (controller plus etcd). */
export function tenantRequests(replicas: number): { cpuMillis: number; memoryMiB: number } {
  return {
    cpuMillis:
      replicas * (cpuMillis(HOSTED_CONTROLLER_REQUESTS.cpu) + cpuMillis(HOSTED_ETCD_REQUESTS.cpu)),
    memoryMiB:
      replicas *
      (memoryMiB(HOSTED_CONTROLLER_REQUESTS.memory) + memoryMiB(HOSTED_ETCD_REQUESTS.memory)),
  };
}

/** What the backend knows about the host of a tenant. */
export interface HostFacts {
  spec?: ClusterSpec;
  available: boolean;
  deleting: boolean;
  kubeconfig: boolean;
}

/** FP24-F-01, FP24-F-03, FP24-F-06: why a tenant cannot be placed on its host (blockers). */
export function hostedTenantProblems(tenant: ClusterSpec, host: HostFacts | undefined): string[] {
  const name = tenant.topology.hosted?.host;
  if (!name) return [];
  const ref = `${tenant.namespace}/${name}`;
  if (!host) return [`The host cluster ${ref} does not exist.`];
  if (!host.spec) return [`The host cluster ${ref} was not created by the app.`];
  if (!host.spec.controlPlaneHost)
    return [`Cluster ${ref} is not marked as host for hosted control planes.`];
  if (host.deleting) return [`The host cluster ${ref} is being deleted.`];
  const problems: string[] = [];
  if (!host.available) problems.push(`The host cluster ${ref} is not available yet.`);
  if (!host.kubeconfig)
    problems.push(`The kubeconfig Secret of the host cluster ${ref} is missing.`);
  const mine = tenant.infrastructure;
  const theirs = host.spec.infrastructure;
  if (mine.provider !== theirs.provider || mine.credentialRef !== theirs.credentialRef) {
    problems.push(
      `A hosted control plane runs its workers on the host's infrastructure and credential (${theirs.provider}, "${theirs.credentialRef}").`,
    );
  }
  const nodes = schedulableHostNodes(host.spec);
  const replicas = tenant.topology.controlPlane.replicas;
  if (nodes < replicas) {
    problems.push(
      `${replicas} control plane replicas need ${replicas} worker nodes in the host, one per replica; ${ref} has ${nodes}.`,
    );
  }
  if (mine.provider === 'proxmox' && theirs.provider === 'proxmox') {
    const range = theirs.network.loadBalancerAddresses ?? [];
    if (!ipv4RangesCover(range, mine.apiEndpoint)) {
      problems.push(
        `The API address ${mine.apiEndpoint} must be one of the host's LoadBalancer addresses (${range.join(', ')}).`,
      );
    }
  }
  return problems;
}

/** FP24-F-06: the first free addresses of the host's LoadBalancer ranges. */
export function freeAddresses(ranges: string[], used: string[], limit: number): string[] {
  const taken = new Set(used.map(parseIpv4).filter((n): n is number => n !== undefined));
  const out: string[] = [];
  for (const range of ranges) {
    const r = parseIpv4Range(range);
    if (!r) continue;
    for (let n = r.start; n <= r.end && out.length < limit; n++) {
      if (!taken.has(n)) out.push(formatIpv4(n));
    }
  }
  return out;
}

/** FP24-F-11, FP24-F-12: a host and its tenants. */
export const HostViewSchema = z.object({
  tenants: z.array(
    z.object({
      namespace: z.string(),
      name: z.string(),
      replicas: z.int(),
      /** CPU (millicores) and memory (MiB) the tenant's control plane requests. */
      cpuMillis: z.int(),
      memoryMiB: z.int(),
    }),
  ),
  /** Allocatable CPU and memory of the host's schedulable nodes, when the host can be read. */
  allocatable: z.object({ cpuMillis: z.int(), memoryMiB: z.int() }).optional(),
  schedulableNodes: z.int(),
  /** Proxmox VE: the next free LoadBalancer addresses for a tenant (FP24-F-06). */
  freeAddresses: z.array(z.string()).optional(),
  warnings: z.array(z.string()),
});
export type HostView = z.infer<typeof HostViewSchema>;

/** FP24-F-11: where a tenant's control plane runs. */
export const TenantViewSchema = z.object({
  host: z.object({ namespace: z.string(), name: z.string() }),
  service: z
    .object({ name: z.string(), address: z.string().optional(), ports: z.array(z.int()) })
    .optional(),
  pods: z.array(
    z.object({
      name: z.string(),
      component: z.enum(['controller', 'etcd']),
      node: z.string().optional(),
      phase: z.string(),
      ready: z.boolean(),
    }),
  ),
  volumes: z.array(z.object({ name: z.string(), size: z.string().optional(), phase: z.string() })),
  warnings: z.array(z.string()),
});
export type TenantView = z.infer<typeof TenantViewSchema>;
