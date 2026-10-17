import { Injectable } from '@nestjs/common';
import {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  NetworkingV1Api,
  VersionApi,
} from '@kubernetes/client-node';
import { DASHBOARD_REFRESH_SECONDS, type Dashboard } from '@capi-navigator/shared';
import {
  catchError,
  exhaustMap,
  finalize,
  from,
  map,
  of,
  share,
  timer,
  type Observable,
} from 'rxjs';
import { ClustersService } from '../clusters/clusters.service.js';
import { kubeStatus } from '../kube/errors.js';
import type { LiveEvent } from '../kube/live-channels.js';
import { buildDashboard, type DashboardRaw, type HttpRoute } from './build-dashboard.js';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Read-only dashboard of a workload cluster (FP-18, ADR-0009). Metrics cannot be watched, so the
 * dashboard is polled every 15 s while somebody looks at it; viewers of the same cluster share
 * one poll. Reads with the cluster's CAPI kubeconfig; never reads Secrets or ConfigMaps.
 */
@Injectable()
export class DashboardService {
  private readonly streams = new Map<string, Observable<LiveEvent<Dashboard>>>();

  constructor(private readonly clusters: ClustersService) {}

  async dashboard(connection: string, namespace: string, name: string): Promise<Dashboard> {
    const kc = new KubeConfig();
    kc.loadFromString(await this.clusters.kubeconfig(connection, namespace, name));
    return buildDashboard(await this.read(kc));
  }

  stream(connection: string, namespace: string, name: string): Observable<LiveEvent<Dashboard>> {
    const key = `${connection}/${namespace}/${name}`;
    let s = this.streams.get(key);
    if (!s) {
      s = timer(0, DASHBOARD_REFRESH_SECONDS * 1000).pipe(
        exhaustMap(() =>
          from(this.dashboard(connection, namespace, name)).pipe(
            map((state): LiveEvent<Dashboard> => ({ type: 'state', state })),
            catchError((err: unknown) =>
              of<LiveEvent<Dashboard>>({ type: 'error', message: errorMessage(err) }),
            ),
          ),
        ),
        finalize(() => this.streams.delete(key)),
        share(),
      );
      this.streams.set(key, s);
    }
    return s;
  }

  private async read(kc: KubeConfig): Promise<DashboardRaw> {
    const core = kc.makeApiClient(CoreV1Api);
    const apps = kc.makeApiClient(AppsV1Api);
    const batch = kc.makeApiClient(BatchV1Api);
    const net = kc.makeApiClient(NetworkingV1Api);
    const custom = kc.makeApiClient(CustomObjectsApi);
    const warnings: string[] = [];
    // Each part is best effort: a missing API or permission becomes a hint, not an error.
    const part = async <T>(label: string, fn: () => Promise<T>, fallback: T, quiet = false) => {
      try {
        return await withTimeout(fn(), REQUEST_TIMEOUT_MS);
      } catch (err) {
        if (!quiet) warnings.push(`${label}: ${errorMessage(err)}`);
        return fallback;
      }
    };
    // Nodes and pods are essential: without them the cluster is not reachable.
    const [nodes, pods] = await Promise.all([
      withTimeout(core.listNode(), REQUEST_TIMEOUT_MS),
      withTimeout(core.listPodForAllNamespaces(), REQUEST_TIMEOUT_MS),
    ]);
    const [
      version,
      namespaces,
      deployments,
      statefulSets,
      daemonSets,
      jobs,
      services,
      ingresses,
      events,
    ] = await Promise.all([
      part(
        'Version',
        async () => (await kc.makeApiClient(VersionApi).getCode()).gitVersion,
        undefined as string | undefined,
      ),
      part('Namespaces', async () => (await core.listNamespace()).items.length, 0),
      part('Deployments', async () => (await apps.listDeploymentForAllNamespaces()).items, []),
      part('StatefulSets', async () => (await apps.listStatefulSetForAllNamespaces()).items, []),
      part('DaemonSets', async () => (await apps.listDaemonSetForAllNamespaces()).items, []),
      part('Jobs', async () => (await batch.listJobForAllNamespaces()).items, []),
      part('Services', async () => (await core.listServiceForAllNamespaces()).items, []),
      part('Ingresses', async () => (await net.listIngressForAllNamespaces()).items, []),
      part('Events', async () => (await core.listEventForAllNamespaces({ limit: 500 })).items, []),
    ]);
    const httpRoutes = await part(
      'HTTPRoutes',
      async () =>
        (
          (await custom.listClusterCustomObject({
            group: 'gateway.networking.k8s.io',
            version: 'v1',
            plural: 'httproutes',
          })) as { items: HttpRoute[] }
        ).items,
      [] as HttpRoute[],
      true, // Gateway API is optional
    );
    let nodeMetrics: DashboardRaw['nodeMetrics'];
    try {
      const res = (await withTimeout(
        custom.listClusterCustomObject({
          group: 'metrics.k8s.io',
          version: 'v1beta1',
          plural: 'nodes',
        }),
        REQUEST_TIMEOUT_MS,
      )) as { items: { metadata: { name: string }; usage: { cpu: string; memory: string } }[] };
      nodeMetrics = res.items.map((i) => ({
        name: i.metadata.name,
        cpu: i.usage.cpu,
        memory: i.usage.memory,
      }));
    } catch (err) {
      warnings.push(
        kubeStatus(err) === 404
          ? 'metrics-server is not installed: usage shows requests and limits only.'
          : `Metrics: ${errorMessage(err)}`,
      );
    }
    return {
      ...(version ? { version } : {}),
      nodes: nodes.items,
      pods: pods.items,
      namespaces,
      deployments,
      statefulSets,
      daemonSets,
      jobs,
      services,
      ingresses,
      httpRoutes,
      events,
      ...(nodeMetrics ? { nodeMetrics } : {}),
      warnings,
    };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('the cluster did not answer in time')), ms),
    ),
  ]);
}

function errorMessage(err: unknown): string {
  const status = kubeStatus(err);
  if (status === 403) return 'missing permissions';
  if (status === 404) return 'not found';
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = String((err as { message: unknown }).message);
    return m.length > 200 ? `${m.slice(0, 200)}…` : m;
  }
  return 'cannot be read';
}
