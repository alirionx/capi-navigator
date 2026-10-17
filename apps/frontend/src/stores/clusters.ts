import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  ClusterListSchema,
  ClusterPreviewSchema,
  ClusterStatusSchema,
  ClusterSummarySchema,
  type ClusterCreateRequest,
  type ClusterPreview,
  type ClusterStatus,
  type ClusterSummary,
} from '@capi-navigator/shared';
import { z } from 'zod';
import { api } from '../api/client.js';

const base = (connection: string) => `/api/connections/${encodeURIComponent(connection)}/clusters`;

/** Workload clusters of the active management cluster (FP-5; FP-6 extends it). */
export const useClustersStore = defineStore('clusters', () => {
  const clusters = ref<ClusterSummary[]>([]);
  const loading = ref(false);
  const status = ref<ClusterStatus | null>(null);
  const statusError = ref<string | null>(null);
  const live = ref(false);
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;

  async function load(connection: string): Promise<void> {
    loading.value = true;
    try {
      clusters.value = await api('GET', base(connection), ClusterListSchema);
    } finally {
      loading.value = false;
    }
  }

  const preview = (connection: string, req: ClusterCreateRequest): Promise<ClusterPreview> =>
    api('POST', `${base(connection)}/preview`, ClusterPreviewSchema, req);

  const create = (connection: string, req: ClusterCreateRequest): Promise<ClusterSummary> =>
    api('POST', base(connection), ClusterSummarySchema, req);

  function unwatch(): void {
    clearTimeout(retry);
    source?.close();
    source = null;
    live.value = false;
  }

  /** Live status via SSE (US-07); reconnects after drops (NF-11). */
  function watch(connection: string, namespace: string, name: string, attempt = 0): void {
    unwatch();
    const es = new EventSource(
      `${base(connection)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/events`,
      {
        withCredentials: true,
      },
    );
    source = es;
    es.addEventListener('state', (e) => {
      const parsed = z
        .object({ state: ClusterStatusSchema })
        .safeParse(JSON.parse((e as MessageEvent<string>).data));
      if (parsed.success) {
        status.value = parsed.data.state;
        statusError.value = null;
        live.value = true;
      }
    });
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent<string | undefined>).data;
      if (data) {
        try {
          statusError.value = String((JSON.parse(data) as { message?: unknown }).message);
        } catch {
          statusError.value = data;
        }
        return;
      }
      live.value = false;
      es.close();
      if (source !== es) return;
      retry = setTimeout(
        () => watch(connection, namespace, name, attempt + 1),
        Math.min(30_000, 1000 * 2 ** (attempt + 1)),
      );
    });
  }

  return { clusters, loading, status, statusError, live, load, preview, create, watch, unwatch };
});
