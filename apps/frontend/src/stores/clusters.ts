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

/**
 * A server-sent event stream with typed `state` events that reconnects after drops (NF-11).
 * `error` events with data are server-side errors; without data the connection dropped.
 */
function liveStream<T>(
  url: string,
  schema: z.ZodType<T>,
  handlers: { state(s: T): void; error(message: string): void; live(on: boolean): void },
): () => void {
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const connect = (attempt: number) => {
    const es = new EventSource(url, { withCredentials: true });
    source = es;
    es.addEventListener('state', (e) => {
      const parsed = z
        .object({ state: schema })
        .safeParse(JSON.parse((e as MessageEvent<string>).data));
      if (parsed.success) {
        handlers.state(parsed.data.state);
        handlers.live(true);
        attempt = 0;
      }
    });
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent<string | undefined>).data;
      if (data) {
        try {
          handlers.error(String((JSON.parse(data) as { message?: unknown }).message));
        } catch {
          handlers.error(data);
        }
        return;
      }
      handlers.live(false);
      es.close();
      if (closed || source !== es) return;
      retry = setTimeout(() => connect(attempt + 1), Math.min(30_000, 1000 * 2 ** (attempt + 1)));
    });
  };
  connect(0);
  return () => {
    closed = true;
    clearTimeout(retry);
    source?.close();
    source = null;
    handlers.live(false);
  };
}

/** Workload clusters of the active management cluster (FP-5, FP-6). */
export const useClustersStore = defineStore('clusters', () => {
  const clusters = ref<ClusterSummary[]>([]);
  const loading = ref(false);
  const listError = ref<string | null>(null);
  const listLive = ref(false);
  const status = ref<ClusterStatus | null>(null);
  const statusError = ref<string | null>(null);
  const live = ref(false);
  let stopList: (() => void) | null = null;
  let stopStatus: (() => void) | null = null;

  async function load(connection: string): Promise<void> {
    loading.value = true;
    try {
      clusters.value = await api('GET', base(connection), ClusterListSchema);
    } finally {
      loading.value = false;
    }
  }

  /** Live cluster list (FP6-F-01). */
  function watchList(connection: string): void {
    unwatchList();
    loading.value = true;
    stopList = liveStream(`${base(connection)}/events`, ClusterListSchema, {
      state: (list) => {
        clusters.value = list;
        listError.value = null;
        loading.value = false;
      },
      error: (message) => {
        listError.value = message;
        loading.value = false;
      },
      live: (on) => (listLive.value = on),
    });
  }

  function unwatchList(): void {
    stopList?.();
    stopList = null;
  }

  const preview = (connection: string, req: ClusterCreateRequest): Promise<ClusterPreview> =>
    api('POST', `${base(connection)}/preview`, ClusterPreviewSchema, req);

  const create = (connection: string, req: ClusterCreateRequest): Promise<ClusterSummary> =>
    api('POST', base(connection), ClusterSummarySchema, req);

  /** Live status of one cluster (US-07, FP6-F-02). */
  function watch(connection: string, namespace: string, name: string): void {
    unwatch();
    stopStatus = liveStream(
      `${base(connection)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/events`,
      ClusterStatusSchema,
      {
        state: (s) => {
          status.value = s;
          statusError.value = null;
        },
        error: (message) => (statusError.value = message),
        live: (on) => (live.value = on),
      },
    );
  }

  function unwatch(): void {
    stopStatus?.();
    stopStatus = null;
  }

  return {
    clusters,
    loading,
    listError,
    listLive,
    status,
    statusError,
    live,
    load,
    watchList,
    unwatchList,
    preview,
    create,
    watch,
    unwatch,
  };
});
