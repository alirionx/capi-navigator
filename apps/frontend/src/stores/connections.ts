import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  ConnectionListSchema,
  ConnectionSchema,
  KubeconfigContextsSchema,
  type Connection,
  type CreateConnectionRequest,
  type KubeconfigContexts,
  type UpdateConnectionRequest,
} from '@capi-navigator/shared';
import { api, apiVoid, ApiError } from '../api/client.js';

const ACTIVE_KEY = 'capi-navigator.activeConnection';

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function writeActive(name: string | null): void {
  try {
    if (name) localStorage.setItem(ACTIVE_KEY, name);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // storage unavailable: the selection is kept for this page view only
  }
}

/** Management cluster connections and the globally active one (FP2-F-05). */
export const useConnectionsStore = defineStore('connections', () => {
  const connections = ref<Connection[]>([]);
  const loading = ref(false);
  const activeName = ref<string | null>(readActive());

  const active = computed(() => connections.value.find((c) => c.name === activeName.value) ?? null);

  function setActive(name: string | null): void {
    activeName.value = name;
    writeActive(name);
  }

  /** Keeps the selection valid: prefer the stored one, else the first reachable connection. */
  function ensureActive(): void {
    if (active.value) return;
    const pick =
      connections.value.find((c) => c.status.phase === 'Reachable') ?? connections.value[0];
    setActive(pick?.name ?? null);
  }

  async function load(): Promise<void> {
    loading.value = true;
    try {
      connections.value = await api('GET', '/api/connections', ConnectionListSchema);
      ensureActive();
    } finally {
      loading.value = false;
    }
  }

  function replace(conn: Connection): void {
    const idx = connections.value.findIndex((c) => c.name === conn.name);
    if (idx >= 0) connections.value.splice(idx, 1, conn);
    else connections.value.push(conn);
    ensureActive();
  }

  async function create(req: CreateConnectionRequest): Promise<Connection> {
    const conn = await api('POST', '/api/connections', ConnectionSchema, req);
    replace(conn);
    return conn;
  }

  async function update(name: string, req: UpdateConnectionRequest): Promise<Connection> {
    const conn = await api(
      'PATCH',
      `/api/connections/${encodeURIComponent(name)}`,
      ConnectionSchema,
      req,
    );
    replace(conn);
    return conn;
  }

  async function test(name: string): Promise<Connection> {
    const conn = await api(
      'POST',
      `/api/connections/${encodeURIComponent(name)}/test`,
      ConnectionSchema,
    );
    replace(conn);
    return conn;
  }

  async function remove(name: string): Promise<void> {
    await apiVoid('DELETE', `/api/connections/${encodeURIComponent(name)}`);
    connections.value = connections.value.filter((c) => c.name !== name);
    if (activeName.value === name) setActive(null);
    ensureActive();
  }

  function contexts(kubeconfig: string): Promise<KubeconfigContexts> {
    return api('POST', '/api/connections/kubeconfig-contexts', KubeconfigContextsSchema, {
      kubeconfig,
    });
  }

  /** FP2-F-07: downloads the manifest that prepares a management cluster. */
  async function downloadAccessManifest(variant: 'full' | 'minimal'): Promise<void> {
    const res = await fetch(`/api/connections/access-manifest?variant=${variant}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
    const url = URL.createObjectURL(new Blob([await res.text()], { type: 'application/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download =
      variant === 'minimal' ? 'capi-navigator-access-minimal.yaml' : 'capi-navigator-access.yaml';
    a.click();
    URL.revokeObjectURL(url);
  }

  return {
    connections,
    loading,
    active,
    activeName,
    setActive,
    load,
    create,
    update,
    test,
    remove,
    contexts,
    downloadAccessManifest,
  };
});
