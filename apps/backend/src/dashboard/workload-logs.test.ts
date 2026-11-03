import { describe, expect, it } from 'vitest';
import { AppsV1Api, BatchV1Api, CoreV1Api, type KubeConfig } from '@kubernetes/client-node';
import {
  defaultContainer,
  orderPods,
  readWorkloadLogs,
  selectorString,
  type LogsRequest,
} from './workload-logs.js';

const pod = (
  name: string,
  opts: { ready?: boolean; restarts?: number; annotation?: string } = {},
) => ({
  metadata: {
    name,
    namespace: 'shop',
    ...(opts.annotation
      ? { annotations: { 'kubectl.kubernetes.io/default-container': opts.annotation } }
      : {}),
  },
  spec: {
    nodeName: 'n1',
    containers: [{ name: 'app' }, { name: 'sidecar' }],
    initContainers: [{ name: 'init' }],
  },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }],
    containerStatuses: [{ restartCount: opts.restarts ?? 0 }],
  },
});

/** A KubeConfig whose API clients are the given fakes; records the log requests. */
function fakeKc(pods: object[], log: (args: Record<string, unknown>) => Promise<string>) {
  const calls: Record<string, unknown>[] = [];
  const listed: string[] = [];
  const clients = new Map<unknown, object>([
    [
      AppsV1Api,
      {
        readNamespacedDeployment: async () => ({
          spec: {
            selector: {
              matchLabels: { app: 'web' },
              matchExpressions: [{ key: 'tier', operator: 'In', values: ['a', 'b'] }],
            },
          },
        }),
      },
    ],
    [BatchV1Api, { readNamespacedJob: async () => ({ spec: { selector: {} } }) }],
    [
      CoreV1Api,
      {
        listNamespacedPod: async ({ labelSelector }: { labelSelector: string }) => {
          listed.push(labelSelector);
          return { items: pods };
        },
        readNamespacedPod: async ({ name }: { name: string }) =>
          pods.find((p) => (p as { metadata: { name: string } }).metadata.name === name),
        readNamespacedPodLog: async (args: Record<string, unknown>) => {
          calls.push(args);
          return log(args);
        },
      },
    ],
  ]);
  const kc = { makeApiClient: (cls: unknown) => clients.get(cls) } as unknown as KubeConfig;
  return { kc, calls, listed };
}

const req = (over: Partial<LogsRequest> = {}): LogsRequest => ({
  kind: 'Deployment',
  workloadNamespace: 'shop',
  workload: 'web',
  tailLines: 500,
  previous: false,
  ...over,
});

describe('workload logs (FP18-F-07)', () => {
  it('turns label selectors into the string of the list APIs', () => {
    expect(
      selectorString({
        matchLabels: { app: 'web' },
        matchExpressions: [
          { key: 'tier', operator: 'In', values: ['a', 'b'] },
          { key: 'env', operator: 'NotIn', values: ['dev'] },
          { key: 'canary', operator: 'Exists' },
          { key: 'legacy', operator: 'DoesNotExist' },
        ],
      }),
    ).toBe('app=web,tier in (a,b),env notin (dev),canary,!legacy');
    expect(selectorString(undefined)).toBe('');
  });

  it('puts not ready pods and those with most restarts first', () => {
    const order = orderPods([
      pod('b'),
      pod('a', { restarts: 3 }),
      pod('c', { ready: false }),
    ] as never);
    expect(order.map((p) => p.name)).toEqual(['c', 'a', 'b']);
    expect(order[0]?.containers).toEqual(['app', 'sidecar', 'init']);
  });

  it('picks the container like kubectl: annotation, else the first', () => {
    expect(defaultContainer(pod('a') as never)).toBe('app');
    expect(defaultContainer(pod('a', { annotation: 'sidecar' }) as never)).toBe('sidecar');
    expect(defaultContainer(pod('a', { annotation: 'gone' }) as never)).toBe('app');
  });

  it('reads the tail of the most interesting pod through the selector', async () => {
    const { kc, calls, listed } = fakeKc(
      [pod('web-1'), pod('web-2', { ready: false })],
      async () => '2026-11-04T08:00:00Z started\n2026-11-04T08:00:01Z ready\n',
    );
    const logs = await readWorkloadLogs(kc, req({ tailLines: 2 }));
    expect(listed).toEqual(['app=web,tier in (a,b)']);
    expect(logs.pod).toBe('web-2');
    expect(logs.container).toBe('app');
    expect(calls[0]).toMatchObject({
      name: 'web-2',
      namespace: 'shop',
      container: 'app',
      tailLines: 2,
      previous: false,
      timestamps: true,
    });
    // As many lines as asked for: older ones may exist.
    expect(logs.truncated).toBe(true);
  });

  it('reads the chosen pod, container and previous container', async () => {
    const { kc, calls } = fakeKc([pod('web-1'), pod('web-2')], async () => 'x\n');
    const logs = await readWorkloadLogs(
      kc,
      req({ pod: 'web-1', container: 'sidecar', previous: true }),
    );
    expect(calls[0]).toMatchObject({ name: 'web-1', container: 'sidecar', previous: true });
    expect(logs).toMatchObject({
      pod: 'web-1',
      container: 'sidecar',
      previous: true,
      truncated: false,
    });
  });

  it('gives hints instead of errors: no pods, pod gone, no previous container', async () => {
    const none = await readWorkloadLogs(fakeKc([], async () => '').kc, req());
    expect(none.hint).toBe('The workload has no pods.');
    const gone = await readWorkloadLogs(
      fakeKc([pod('web-1')], async () => '').kc,
      req({ pod: 'web-9' }),
    );
    expect(gone.hint).toBe('Pod web-9 no longer exists.');
    const noPrevious = await readWorkloadLogs(
      fakeKc([pod('web-1')], async () => {
        throw Object.assign(new Error('bad request'), {
          code: 400,
          body: JSON.stringify({
            message: 'previous terminated container "app" in pod "web-1" not found',
          }),
        });
      }).kc,
      req({ previous: true }),
    );
    expect(noPrevious.hint).toContain('previous terminated container');
    expect(noPrevious.text).toBe('');
  });

  it('never matches all pods of a namespace with an empty selector', async () => {
    const { kc, listed } = fakeKc([pod('other')], async () => '');
    const logs = await readWorkloadLogs(kc, req({ kind: 'Job', workload: 'migrate' }));
    expect(listed).toEqual([]);
    expect(logs.hint).toBe('The workload has no pods.');
  });

  it('reads a single pod directly', async () => {
    const { kc, calls } = fakeKc([pod('crashy', { restarts: 7 })], async () => 'boom\n');
    const logs = await readWorkloadLogs(kc, req({ kind: 'Pod', workload: 'crashy' }));
    expect(logs.pods.map((p) => p.name)).toEqual(['crashy']);
    expect(calls[0]).toMatchObject({ name: 'crashy' });
  });
});
