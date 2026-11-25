import {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  type CoreV1Event,
  type V1DaemonSet,
  type V1Deployment,
  type V1Job,
  type V1Pod,
  type V1StatefulSet,
} from '@kubernetes/client-node';
import { ACCOUNTS_NAMESPACE, type NamespaceDashboard } from '@capi-navigator/shared';
import { buildDashboard } from '../dashboard/build-dashboard.js';

/** What is read for the dashboard of one namespace; nothing cluster-wide (FP37-F-08). */
export interface NamespaceRaw {
  pods: V1Pod[];
  deployments: V1Deployment[];
  statefulSets: V1StatefulSet[];
  daemonSets: V1DaemonSet[];
  jobs: V1Job[];
  events: CoreV1Event[];
}

/** The admin kubeconfig, acting as the service account of the person: Kubernetes sets the limits. */
export function asServiceAccount(kubeconfig: string, serviceAccount: string): KubeConfig {
  const source = new KubeConfig();
  source.loadFromString(kubeconfig);
  const context = source.getContextObject(source.getCurrentContext())!;
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: source.clusters,
    users: source.users.map((u) =>
      u.name === context.user
        ? {
            ...u,
            impersonateUser: `system:serviceaccount:${ACCOUNTS_NAMESPACE}:${serviceAccount}`,
          }
        : u,
    ),
    contexts: source.contexts,
    currentContext: source.currentContext,
  });
  return kc;
}

/** Namespaced requests only. */
export async function readNamespace(kc: KubeConfig, namespace: string): Promise<NamespaceRaw> {
  const core = kc.makeApiClient(CoreV1Api);
  const apps = kc.makeApiClient(AppsV1Api);
  const batch = kc.makeApiClient(BatchV1Api);
  const [pods, deployments, statefulSets, daemonSets, jobs, events] = await Promise.all([
    core.listNamespacedPod({ namespace }),
    apps.listNamespacedDeployment({ namespace }),
    apps.listNamespacedStatefulSet({ namespace }),
    apps.listNamespacedDaemonSet({ namespace }),
    batch.listNamespacedJob({ namespace }),
    core.listNamespacedEvent({ namespace, limit: 500 }),
  ]);
  return {
    pods: pods.items,
    deployments: deployments.items,
    statefulSets: statefulSets.items,
    daemonSets: daemonSets.items,
    jobs: jobs.items,
    events: events.items,
  };
}

/**
 * Pure: the dashboard of one namespace. Objects of another one are dropped, and the names of nodes
 * are taken out of messages.
 */
export function buildNamespaceDashboard(
  raw: NamespaceRaw,
  namespace: string,
  now = new Date(),
): NamespaceDashboard {
  const here = <T extends { metadata?: { namespace?: string } }>(items: T[]) =>
    items.filter((o) => o.metadata?.namespace === namespace);
  const pods = here(raw.pods);
  const nodes = [
    ...new Set(
      pods.flatMap((p) => [p.spec?.nodeName, p.status?.hostIP, ...hostIPs(p)]).filter((n) => !!n),
    ),
  ].sort((a, b) => b!.length - a!.length) as string[];
  const clean = (text: string) => nodes.reduce((t, n) => t.split(n).join('(node)'), text);
  const all = buildDashboard(
    {
      pods,
      deployments: here(raw.deployments),
      statefulSets: here(raw.statefulSets),
      daemonSets: here(raw.daemonSets),
      jobs: here(raw.jobs),
      // "Scheduled" only says which node a pod runs on.
      events: here(raw.events).filter((e) => e.reason !== 'Scheduled'),
      nodes: [],
      namespaces: 1,
      services: [],
      ingresses: [],
      httpRoutes: [],
      warnings: [],
    },
    now,
  );
  const problems = new Map(all.problemPods.map((p) => [p.name, p]));
  return {
    generatedAt: all.generatedAt,
    workloads: all.workloads.map(({ kind, name, desired, ready, status }) => ({
      kind,
      name,
      desired,
      ready,
      status,
    })),
    pods: pods
      .map((p) => {
        const name = p.metadata?.name ?? '';
        const problem = problems.get(name);
        const statuses = p.status?.containerStatuses ?? [];
        return {
          name,
          phase: p.status?.phase ?? 'Unknown',
          ready: statuses.filter((s) => s.ready).length,
          containers: p.spec?.containers.length ?? statuses.length,
          restarts: statuses.reduce((n, s) => n + (s.restartCount ?? 0), 0),
          ...(problem ? { reason: problem.reason } : {}),
          ...(problem?.message ? { message: clean(problem.message) } : {}),
          ...(p.metadata?.creationTimestamp
            ? { createdAt: new Date(p.metadata.creationTimestamp).toISOString() }
            : {}),
        };
      })
      .sort((a, b) => Number(!!b.reason) - Number(!!a.reason) || a.name.localeCompare(b.name)),
    events: all.events.map(({ type, reason, message, object, count, lastSeen }) => ({
      type,
      reason,
      message: clean(message),
      object,
      count,
      ...(lastSeen ? { lastSeen } : {}),
    })),
  };
}

const hostIPs = (p: V1Pod) => (p.status?.hostIPs ?? []).map((h) => h.ip);
