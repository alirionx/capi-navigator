import type { CoreV1Event, KubeConfig, V1Pod } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { asServiceAccount, buildNamespaceDashboard, readNamespace } from './namespace-dashboard.js';

const pod = (name: string, namespace = 'team-a', over: Partial<V1Pod> = {}): V1Pod => ({
  metadata: { name, namespace },
  spec: { nodeName: 'worker-1', containers: [{ name: 'c' }] },
  status: {
    phase: 'Running',
    hostIP: '10.0.0.7',
    containerStatuses: [{ name: 'c', ready: true, restartCount: 0, image: '', imageID: '' }],
  },
  ...over,
});
const event = (reason: string, message: string, namespace = 'team-a'): CoreV1Event => ({
  metadata: { name: reason, namespace },
  involvedObject: { kind: 'Pod', name: 'web' },
  reason,
  message,
  type: 'Warning',
});
const raw = {
  pods: [
    pod('web'),
    pod('crash', 'team-a', {
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'c',
            ready: false,
            restartCount: 7,
            image: '',
            imageID: '',
            state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off on worker-1' } },
          },
        ],
      },
    }),
    pod('foreign-pod', 'team-b'),
  ],
  deployments: [
    {
      metadata: { name: 'web', namespace: 'team-a' },
      spec: { replicas: 2 },
      status: { readyReplicas: 1 },
    },
    { metadata: { name: 'foreign-web', namespace: 'team-b' } },
  ] as never[],
  statefulSets: [],
  daemonSets: [],
  jobs: [],
  events: [
    event('Scheduled', 'Successfully assigned team-a/web to worker-1'),
    event('Unhealthy', 'Readiness probe on worker-1 (10.0.0.7) failed'),
    event('Foreign', 'secret of team-b', 'team-b'),
  ],
};

describe('dashboard of one namespace (FP37-F-08)', () => {
  it('shows workloads, pods with problems first, and events', () => {
    expect(buildNamespaceDashboard(raw, 'team-a', new Date('2026-11-25T00:00:00Z'))).toEqual({
      generatedAt: '2026-11-25T00:00:00.000Z',
      workloads: [{ kind: 'Deployment', name: 'web', desired: 2, ready: 1, status: 'progressing' }],
      pods: [
        {
          name: 'crash',
          phase: 'Running',
          ready: 0,
          containers: 1,
          restarts: 7,
          reason: 'CrashLoopBackOff',
          message: 'back-off on (node)',
        },
        { name: 'web', phase: 'Running', ready: 1, containers: 1, restarts: 0 },
      ],
      events: [
        {
          type: 'Warning',
          reason: 'Unhealthy',
          message: 'Readiness probe on (node) ((node)) failed',
          object: { kind: 'Pod', name: 'web' },
          count: 1,
        },
      ],
    });
  });

  it('contains nothing of another namespace and no node (acceptance FP-37)', () => {
    const text = JSON.stringify(buildNamespaceDashboard(raw, 'team-a'));
    expect(text).not.toMatch(/foreign|team-b|worker-1|10\.0\.0\.7/);
  });

  it('reads with namespaced requests only', async () => {
    const calls: string[] = [];
    const client = new Proxy(
      {},
      {
        get: (_t, method: string) => async (args: { namespace?: string }) => {
          calls.push(`${method} ${args?.namespace}`);
          return { items: [] };
        },
      },
    );
    await readNamespace({ makeApiClient: () => client } as unknown as KubeConfig, 'team-a');
    expect(calls).toHaveLength(6);
    for (const c of calls) expect(c).toMatch(/^listNamespaced\w+ team-a$/);
  });

  it('acts as the service account and keeps the original kubeconfig user', () => {
    const kc = asServiceAccount(
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'Config',
        clusters: [{ name: 'c', cluster: { server: 'https://x' } }],
        users: [
          { name: 'admin', user: { token: 't' } },
          { name: 'other', user: {} },
        ],
        contexts: [{ name: 'x', context: { cluster: 'c', user: 'admin' } }],
        'current-context': 'x',
      }),
      'team-a.ci',
    );
    expect(kc.getCurrentUser()).toMatchObject({
      name: 'admin',
      token: 't',
      impersonateUser: 'system:serviceaccount:capi-navigator-accounts:team-a.ci',
    });
    expect(kc.users.find((u) => u.name === 'other')?.impersonateUser).toBeUndefined();
  });
});
