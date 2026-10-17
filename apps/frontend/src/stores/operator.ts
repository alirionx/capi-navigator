import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  ManifestPreviewSchema,
  OperatorStateSchema,
  ProviderUsageSchema,
  ReleaseListSchema,
  type InstalledProvider,
  type ManifestPreview,
  type OperatorState,
  type ProviderInstallRequest,
  type ProviderUpdateRequest,
  type ProviderUsage,
  type ReleaseList,
} from '@capi-navigator/shared';
import { z } from 'zod';
import { api, apiVoid } from '../api/client.js';

const base = (connection: string) => `/api/connections/${encodeURIComponent(connection)}/operator`;
const providerPath = (
  connection: string,
  p: Pick<InstalledProvider, 'kind' | 'namespace' | 'name'>,
) =>
  `${base(connection)}/providers/${p.kind}/${encodeURIComponent(p.namespace)}/${encodeURIComponent(p.name)}`;

/** CAPI Operator state of the active management cluster, updated live via SSE (FP3-F-13). */
export const useOperatorStore = defineStore('operator', () => {
  const connection = ref<string | null>(null);
  const state = ref<OperatorState | null>(null);
  const error = ref<string | null>(null);
  const live = ref(false);
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  function disconnect(): void {
    clearTimeout(retry);
    source?.close();
    source = null;
    live.value = false;
  }

  /** Opens the event stream for a connection; reconnects with backoff (NF-11). */
  function connect(name: string): void {
    if (connection.value !== name) {
      state.value = null;
      error.value = null;
    }
    disconnect();
    connection.value = name;
    const es = new EventSource(`${base(name)}/events`, { withCredentials: true });
    source = es;
    es.addEventListener('state', (e) => {
      const parsed = z
        .object({ state: OperatorStateSchema })
        .safeParse(JSON.parse((e as MessageEvent<string>).data));
      if (parsed.success) {
        state.value = parsed.data.state;
        error.value = null;
        live.value = true;
        attempts = 0;
      }
    });
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent<string | undefined>).data;
      if (data) {
        // Error event sent by the backend (e.g. cluster unreachable).
        try {
          error.value = String((JSON.parse(data) as { message?: unknown }).message);
        } catch {
          error.value = data;
        }
        return;
      }
      // Connection dropped: the browser would retry blindly; retry with backoff instead.
      live.value = false;
      es.close();
      if (source !== es) return;
      attempts += 1;
      retry = setTimeout(
        () => connection.value && connect(connection.value),
        Math.min(30_000, 1000 * 2 ** attempts),
      );
    });
  }

  async function refresh(): Promise<void> {
    if (!connection.value) return;
    state.value = await api('GET', base(connection.value), OperatorStateSchema);
  }

  const releases = (catalogId: string): Promise<ReleaseList> =>
    api('GET', `${base(connection.value!)}/releases/${catalogId}`, ReleaseListSchema);

  const orcReleases = (): Promise<ReleaseList> =>
    api('GET', `${base(connection.value!)}/releases/orc`, ReleaseListSchema);

  const previewOrc = (version: string): Promise<ManifestPreview> =>
    api('POST', `${base(connection.value!)}/orc/preview`, ManifestPreviewSchema, { version });

  const installOrc = (version: string): Promise<ManifestPreview> =>
    api('POST', `${base(connection.value!)}/orc`, ManifestPreviewSchema, { version });

  const previewInstall = (req: ProviderInstallRequest): Promise<ManifestPreview> =>
    api('POST', `${base(connection.value!)}/providers/preview`, ManifestPreviewSchema, req);

  const install = (req: ProviderInstallRequest): Promise<ManifestPreview> =>
    api('POST', `${base(connection.value!)}/providers`, ManifestPreviewSchema, req);

  const previewUpdate = (
    p: InstalledProvider,
    req: ProviderUpdateRequest,
  ): Promise<ManifestPreview> =>
    api('PUT', `${providerPath(connection.value!, p)}/preview`, ManifestPreviewSchema, req);

  const update = (p: InstalledProvider, req: ProviderUpdateRequest): Promise<ManifestPreview> =>
    api('PUT', providerPath(connection.value!, p), ManifestPreviewSchema, req);

  const usage = (p: InstalledProvider): Promise<ProviderUsage> =>
    api('GET', `${providerPath(connection.value!, p)}/usage`, ProviderUsageSchema);

  const variableNames = async (p: InstalledProvider): Promise<string[]> =>
    (
      await api(
        'GET',
        `${providerPath(connection.value!, p)}/variables`,
        z.object({ names: z.array(z.string()) }),
      )
    ).names;

  const remove = (p: InstalledProvider, force: boolean): Promise<void> =>
    apiVoid('DELETE', `${providerPath(connection.value!, p)}${force ? '?force=true' : ''}`);

  return {
    connection,
    state,
    error,
    live,
    connect,
    disconnect,
    refresh,
    releases,
    orcReleases,
    previewOrc,
    installOrc,
    previewInstall,
    install,
    previewUpdate,
    update,
    usage,
    variableNames,
    remove,
  };
});
