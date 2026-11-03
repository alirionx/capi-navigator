import {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  type V1LabelSelector,
  type V1Pod,
} from '@kubernetes/client-node';
import type { LogPod, WorkloadLogs } from '@capi-navigator/shared';
import { kubeMessage, kubeStatus } from '../kube/errors.js';

/** At most this much text per request, like a long `kubectl logs --tail`. */
export const LOG_LIMIT_BYTES = 2 * 1024 * 1024;

/** A label selector as the string the list APIs take (matchLabels and matchExpressions). */
export function selectorString(sel: V1LabelSelector | undefined): string {
  const parts = Object.entries(sel?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const e of sel?.matchExpressions ?? []) {
    const values = (e.values ?? []).join(',');
    if (e.operator === 'In') parts.push(`${e.key} in (${values})`);
    else if (e.operator === 'NotIn') parts.push(`${e.key} notin (${values})`);
    else if (e.operator === 'Exists') parts.push(e.key);
    else if (e.operator === 'DoesNotExist') parts.push(`!${e.key}`);
  }
  return parts.join(',');
}

const podReady = (p: V1Pod) =>
  !!p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');

function toLogPod(p: V1Pod): LogPod {
  const statuses = [
    ...(p.status?.initContainerStatuses ?? []),
    ...(p.status?.containerStatuses ?? []),
  ];
  return {
    name: p.metadata?.name ?? '',
    phase: p.status?.phase ?? 'Unknown',
    ready: podReady(p),
    restarts: statuses.reduce((n, s) => n + (s.restartCount ?? 0), 0),
    ...(p.spec?.nodeName ? { node: p.spec.nodeName } : {}),
    containers: [
      ...(p.spec?.containers ?? []).map((c) => c.name),
      ...(p.spec?.initContainers ?? []).map((c) => c.name),
    ],
  };
}

/** The most interesting pods first: not ready, then most restarts, then by name. */
export function orderPods(pods: V1Pod[]): LogPod[] {
  return pods
    .map(toLogPod)
    .sort(
      (a, b) =>
        Number(a.ready) - Number(b.ready) ||
        b.restarts - a.restarts ||
        a.name.localeCompare(b.name),
    );
}

/** The container `kubectl logs` would pick: the default-container annotation, else the first. */
export function defaultContainer(pod: V1Pod): string | undefined {
  const annotated = pod.metadata?.annotations?.['kubectl.kubernetes.io/default-container'];
  const names = (pod.spec?.containers ?? []).map((c) => c.name);
  return annotated && names.includes(annotated) ? annotated : names[0];
}

export interface LogsRequest {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'Pod';
  workloadNamespace: string;
  workload: string;
  pod?: string;
  container?: string;
  tailLines: number;
  previous: boolean;
}

/** Pods of a workload, read through its selector (a Pod stands for itself). */
async function podsOf(kc: KubeConfig, req: LogsRequest): Promise<V1Pod[]> {
  const core = kc.makeApiClient(CoreV1Api);
  const namespace = req.workloadNamespace;
  const name = req.workload;
  if (req.kind === 'Pod') return [await core.readNamespacedPod({ namespace, name })];
  const apps = kc.makeApiClient(AppsV1Api);
  const selector =
    req.kind === 'Deployment'
      ? (await apps.readNamespacedDeployment({ namespace, name })).spec?.selector
      : req.kind === 'StatefulSet'
        ? (await apps.readNamespacedStatefulSet({ namespace, name })).spec?.selector
        : req.kind === 'DaemonSet'
          ? (await apps.readNamespacedDaemonSet({ namespace, name })).spec?.selector
          : (await kc.makeApiClient(BatchV1Api).readNamespacedJob({ namespace, name })).spec
              ?.selector;
  const labelSelector = selectorString(selector);
  // An empty selector would match every pod of the namespace.
  if (!labelSelector) return [];
  return (await core.listNamespacedPod({ namespace, labelSelector })).items;
}

/**
 * Logs of one container of a workload (FP18-F-07, ADR-0036). Read-only, with the cluster's
 * kubeconfig; the text passes through to the caller and is never logged or cached.
 */
export async function readWorkloadLogs(kc: KubeConfig, req: LogsRequest): Promise<WorkloadLogs> {
  const raw = await podsOf(kc, req);
  const pods = orderPods(raw);
  const base = { pods, previous: req.previous, text: '', truncated: false };
  if (!pods.length) return { ...base, hint: 'The workload has no pods.' };
  const pod = req.pod ? raw.find((p) => p.metadata?.name === req.pod) : undefined;
  if (req.pod && !pod) return { ...base, hint: `Pod ${req.pod} no longer exists.` };
  const chosen = pod ?? raw.find((p) => p.metadata?.name === pods[0]!.name)!;
  const podName = chosen.metadata?.name ?? '';
  const all = toLogPod(chosen).containers;
  const container =
    req.container && all.includes(req.container) ? req.container : defaultContainer(chosen);
  if (!container) return { ...base, pod: podName, hint: 'The pod has no containers.' };
  let text: string;
  try {
    text = await kc.makeApiClient(CoreV1Api).readNamespacedPodLog({
      namespace: req.workloadNamespace,
      name: podName,
      container,
      tailLines: req.tailLines,
      previous: req.previous,
      timestamps: true,
      limitBytes: LOG_LIMIT_BYTES,
    });
  } catch (err) {
    // No previous container, or the container waits to start: a hint, not an error.
    if (kubeStatus(err) !== 400) throw err;
    return { ...base, pod: podName, container, hint: kubeMessage(err) ?? 'No logs available.' };
  }
  const lines = text ? text.split('\n').filter((l, i, a) => l || i < a.length - 1).length : 0;
  return {
    ...base,
    pod: podName,
    container,
    text,
    truncated: lines >= req.tailLines || text.length >= LOG_LIMIT_BYTES,
    ...(text
      ? {}
      : { hint: req.previous ? 'The previous container wrote nothing.' : 'No output yet.' }),
  };
}
