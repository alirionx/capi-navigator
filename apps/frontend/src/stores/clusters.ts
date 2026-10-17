import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  ClusterChangePreviewSchema,
  ClusterListSchema,
  ClusterPreviewSchema,
  ClusterStatusSchema,
  ClusterSummarySchema,
  DeletePreviewSchema,
  DeletionStatusSchema,
  type DeleteRequest,
  type BastionRequest,
  type ClusterChangePreview,
  type ClusterCreateRequest,
  type LabelsRequest,
  type ScaleRequest,
  type ClusterPreview,
  type ClusterStatus,
  type ClusterSummary,
} from '@capi-navigator/shared';
import { api } from '../api/client.js';
import { liveStream } from '../api/live.js';

const base = (connection: string) => `/api/connections/${encodeURIComponent(connection)}/clusters`;

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

  const clusterPath = (connection: string, namespace: string, name: string) =>
    `${base(connection)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;

  /** Spec changes with preview (FP6-F-05, FP6-F-07; hard rules 4 and 6). */
  const scalePreview = (c: string, ns: string, n: string, req: ScaleRequest) =>
    api('POST', `${clusterPath(c, ns, n)}/scale/preview`, ClusterChangePreviewSchema, req);
  const scale = (c: string, ns: string, n: string, req: ScaleRequest) =>
    api('POST', `${clusterPath(c, ns, n)}/scale`, ClusterChangePreviewSchema, req);
  const labelsPreview = (c: string, ns: string, n: string, req: LabelsRequest) =>
    api('POST', `${clusterPath(c, ns, n)}/labels/preview`, ClusterChangePreviewSchema, req);
  const setLabels = (
    c: string,
    ns: string,
    n: string,
    req: LabelsRequest,
  ): Promise<ClusterChangePreview> =>
    api('POST', `${clusterPath(c, ns, n)}/labels`, ClusterChangePreviewSchema, req);

  /** FP5-F-20: bastion host as day-2 change. */
  const bastionPreview = (c: string, ns: string, n: string, req: BastionRequest) =>
    api('POST', `${clusterPath(c, ns, n)}/bastion/preview`, ClusterChangePreviewSchema, req);
  const setBastion = (c: string, ns: string, n: string, req: BastionRequest) =>
    api('POST', `${clusterPath(c, ns, n)}/bastion`, ClusterChangePreviewSchema, req);

  /** FP6-F-06: what a deletion removes, then the confirmed deletion. */
  const deletePreview = (c: string, ns: string, n: string) =>
    api('GET', `${clusterPath(c, ns, n)}/delete-preview`, DeletePreviewSchema);
  const deleteCluster = (c: string, ns: string, n: string, req: DeleteRequest) =>
    api('POST', `${clusterPath(c, ns, n)}/delete`, DeletionStatusSchema, req);

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
    scalePreview,
    scale,
    labelsPreview,
    setLabels,
    deletePreview,
    deleteCluster,
    bastionPreview,
    setBastion,
    watch,
    unwatch,
  };
});
