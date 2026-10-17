import { describe, expect, it } from 'vitest';
import { buildDashboard, type DashboardRaw } from './build-dashboard.js';

const node = (name: string, ready = true) => ({
  metadata: { name, labels: { 'node-role.kubernetes.io/control-plane': 'true' } },
  status: {
    capacity: { cpu: '2', memory: '4Gi', pods: '110' },
    allocatable: { cpu: '2', memory: '4000Mi', pods: '110' },
    conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
  },
});
const container = (cpu: string, mem: string, extra: object = {}) => ({
  name: 'c',
  resources: { requests: { cpu, memory: mem }, limits: { cpu: '1', memory: '1Gi' } },
  ...extra,
});

const raw = (over: Partial<DashboardRaw> = {}): DashboardRaw => ({
  version: 'v1.37.1+rke2r1',
  nodes: [node('n1'), node('n2', false)] as never,
  pods: [
    {
      metadata: { namespace: 'shop', name: 'web' },
      spec: {
        nodeName: 'n1',
        containers: [container('100m', '128Mi'), container('50m', '64Mi')],
        // A larger init container dominates the effective request (scheduler rule).
        initContainers: [container('500m', '32Mi')],
      },
      status: { phase: 'Running', containerStatuses: [{ restartCount: 0 }] },
    },
    {
      metadata: { namespace: 'shop', name: 'crashy' },
      spec: { nodeName: 'n1', containers: [container('10m', '16Mi')] },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            restartCount: 7,
            state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } },
          },
        ],
      },
    },
    {
      metadata: { namespace: 'shop', name: 'stuck' },
      spec: { containers: [container('4', '1Gi')] },
      status: {
        phase: 'Pending',
        conditions: [
          {
            type: 'PodScheduled',
            status: 'False',
            reason: 'Unschedulable',
            message: 'Insufficient cpu',
          },
        ],
      },
    },
    // Completed pods count neither as problems nor towards node requests.
    {
      metadata: { namespace: 'kube-system', name: 'helm-install' },
      spec: { nodeName: 'n1', containers: [container('1', '1Gi')] },
      status: { phase: 'Succeeded' },
    },
  ] as never,
  namespaces: 4,
  deployments: [
    {
      metadata: { namespace: 'shop', name: 'web' },
      spec: { replicas: 2 },
      status: { readyReplicas: 2 },
    },
    { metadata: { namespace: 'shop', name: 'crashy' }, spec: { replicas: 1 }, status: {} },
  ] as never,
  statefulSets: [],
  daemonSets: [
    {
      metadata: { namespace: 'kube-system', name: 'csi' },
      status: { desiredNumberScheduled: 2, numberReady: 1 },
    },
  ] as never,
  jobs: [
    { metadata: { namespace: 'shop', name: 'done' }, spec: {}, status: { succeeded: 1 } },
    { metadata: { namespace: 'shop', name: 'broken' }, spec: {}, status: { failed: 3 } },
  ] as never,
  services: [
    {
      metadata: { namespace: 'shop', name: 'web' },
      spec: { type: 'LoadBalancer', ports: [{ port: 80, nodePort: 31000, protocol: 'TCP' }] },
      status: { loadBalancer: { ingress: [{ ip: '203.0.113.10' }] } },
    },
    { metadata: { namespace: 'shop', name: 'db' }, spec: { type: 'ClusterIP' } },
  ] as never,
  ingresses: [
    {
      metadata: { namespace: 'shop', name: 'web' },
      spec: {
        ingressClassName: 'nginx',
        tls: [{ hosts: ['shop.example.com'] }],
        rules: [
          {
            host: 'shop.example.com',
            http: { paths: [{ backend: { service: { name: 'web', port: { number: 80 } } } }] },
          },
        ],
      },
      status: { loadBalancer: { ingress: [{ hostname: 'lb.example.net' }] } },
    },
  ] as never,
  httpRoutes: [
    {
      metadata: { namespace: 'shop', name: 'api' },
      spec: {
        hostnames: ['api.example.com'],
        parentRefs: [{ name: 'gw' }],
        rules: [{ backendRefs: [{ name: 'api', port: 8080 }] }],
      },
    },
  ],
  events: [
    {
      metadata: { namespace: 'shop' },
      type: 'Warning',
      reason: 'BackOff',
      message: 'Back-off restarting',
      involvedObject: { kind: 'Pod', name: 'crashy' },
      count: 4,
      lastTimestamp: new Date('2026-10-18T10:00:00Z'),
    },
    {
      metadata: { namespace: 'shop' },
      type: 'Normal',
      reason: 'Pulled',
      message: 'ok',
      involvedObject: { kind: 'Pod', name: 'web' },
      lastTimestamp: new Date('2026-10-18T11:00:00Z'),
    },
  ] as never,
  nodeMetrics: [{ name: 'n1', cpu: '250000000n', memory: '1048576Ki' }],
  warnings: [],
  ...over,
});

describe('cluster dashboard (FP-18)', () => {
  it('computes node requests like the scheduler and adds metrics', () => {
    const d = buildDashboard(raw());
    const n1 = d.nodes.find((n) => n.name === 'n1')!;
    // web: max(150m, init 500m) = 500m; crashy: 10m. Succeeded pod excluded.
    expect(n1.cpu).toMatchObject({ allocatable: 2000, requests: 510, usage: 250 });
    expect(n1.memory.requests).toBe((192 + 16) * 1024 ** 2);
    expect(n1.memory.usage).toBe(1024 ** 3);
    expect(n1.pods).toEqual({ count: 2, capacity: 110 });
    expect(d.totals).toMatchObject({
      nodes: 2,
      readyNodes: 1,
      pods: 4,
      podPhases: { Running: 2, Pending: 1, Succeeded: 1 },
    });
    expect(d.metricsAvailable).toBe(true);
  });

  it('lists unhealthy workloads first and only running or failed jobs', () => {
    const d = buildDashboard(raw());
    expect(d.workloads.map((w) => `${w.kind}/${w.name}:${w.status}`)).toEqual([
      'Job/broken:degraded',
      'Deployment/crashy:degraded',
      'DaemonSet/csi:progressing',
      'Deployment/web:ok',
    ]);
  });

  it('finds problem pods with reasons', () => {
    const d = buildDashboard(raw());
    expect(d.problemPods.map((p) => `${p.name}:${p.reason}:${p.restarts}`)).toEqual([
      'crashy:CrashLoopBackOff:7',
      'stuck:Unschedulable:0',
    ]);
    expect(d.problemPods[1]?.message).toBe('Insufficient cpu');
  });

  it('shows external services, ingresses and HTTP routes, newest events first', () => {
    const d = buildDashboard(raw());
    expect(d.services).toEqual([
      {
        namespace: 'shop',
        name: 'web',
        type: 'LoadBalancer',
        external: ['203.0.113.10'],
        ports: ['80:31000/TCP'],
      },
    ]);
    expect(d.totals.services).toEqual({ LoadBalancer: 1, ClusterIP: 1 });
    expect(d.ingresses).toEqual([
      {
        kind: 'Ingress',
        namespace: 'shop',
        name: 'web',
        className: 'nginx',
        hosts: ['shop.example.com'],
        tls: true,
        addresses: ['lb.example.net'],
        backends: ['web:80'],
      },
      {
        kind: 'HTTPRoute',
        namespace: 'shop',
        name: 'api',
        className: 'gw',
        hosts: ['api.example.com'],
        tls: false,
        addresses: [],
        backends: ['api:8080'],
      },
    ]);
    expect(d.events.map((e) => e.reason)).toEqual(['Pulled', 'BackOff']);
  });

  it('works without metrics-server', () => {
    const d = buildDashboard(
      raw({ nodeMetrics: undefined, warnings: ['metrics-server is not installed'] }),
    );
    expect(d.metricsAvailable).toBe(false);
    expect(d.nodes[0]?.cpu.usage).toBeUndefined();
    expect(d.warnings).toHaveLength(1);
  });
});
