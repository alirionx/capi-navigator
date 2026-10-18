import type {
  AuditEventSpec,
  HelmRepositorySpec,
  ManagementClusterSpec,
  ManagementClusterStatus,
  NavigatorResource,
  NavigatorUserSpec,
} from '@capi-navigator/shared';
import type { StoreService } from '../store/store.service.js';

const err = (code: number) => Object.assign(new Error(`HTTP ${code}`), { code });

/** In-memory stand-in for StoreService in unit tests. */
export function createFakeStore() {
  let rv = 1;
  const users = new Map<string, NavigatorResource<NavigatorUserSpec>>();
  const secrets = new Map<string, Record<string, string>>();
  const auditEvents: NavigatorResource<AuditEventSpec>[] = [];
  const connections = new Map<
    string,
    NavigatorResource<ManagementClusterSpec, ManagementClusterStatus>
  >();

  const helmRepositories = new Map<string, NavigatorResource<HelmRepositorySpec>>();

  let presetOverrides: Record<string, { version?: string; valuesTemplate?: string }> = {};

  const store = {
    namespace: 'test',
    addonPresetOverrides: async () => structuredClone(presetOverrides),
    putAddonPresetOverrides: async (o: typeof presetOverrides) => {
      presetOverrides = structuredClone(o);
    },
    ready: true,
    users: {
      create: async (meta: { name: string }, spec: NavigatorUserSpec) => {
        if (users.has(meta.name)) throw err(409);
        const obj = {
          apiVersion: 'navigator.capi-navigator.io/v1alpha1',
          kind: 'NavigatorUser',
          metadata: { name: meta.name, resourceVersion: String(rv++) },
          spec,
        };
        users.set(meta.name, obj);
        return structuredClone(obj);
      },
      patchSpec: async (
        name: string,
        spec: Partial<NavigatorUserSpec>,
        resourceVersion?: string,
      ) => {
        const current = users.get(name);
        if (!current) throw err(404);
        if (resourceVersion && current.metadata.resourceVersion !== resourceVersion) throw err(409);
        const updated = {
          ...current,
          metadata: { ...current.metadata, resourceVersion: String(rv++) },
          spec: { ...current.spec, ...spec },
        };
        users.set(name, updated);
        return structuredClone(updated);
      },
      delete: async (name: string) => {
        if (!users.delete(name)) throw err(404);
      },
    },
    userCache: {
      get: (name: string) => structuredClone(users.get(name)),
      list: () => [...users.values()].map((u) => structuredClone(u)),
      upsert: () => undefined,
      remove: () => undefined,
      isSynced: true,
    },
    secrets: {
      get: async (name: string) => secrets.get(name),
      create: async (name: string, data: Record<string, string>) => {
        if (secrets.has(name)) throw err(409);
        secrets.set(name, data);
      },
      put: async (name: string, data: Record<string, string>) => {
        secrets.set(name, data);
      },
      delete: async (name: string) => {
        secrets.delete(name);
      },
    },
    connections: {
      create: async (meta: { name: string }, spec: ManagementClusterSpec) => {
        if (connections.has(meta.name)) throw err(409);
        const obj = {
          apiVersion: 'navigator.capi-navigator.io/v1alpha1',
          kind: 'ManagementCluster',
          metadata: { name: meta.name, resourceVersion: String(rv++) },
          spec,
        };
        connections.set(meta.name, obj);
        return structuredClone(obj);
      },
      patchSpec: async (name: string, spec: Record<string, unknown>) => {
        const current = connections.get(name);
        if (!current) throw err(404);
        const merged: Record<string, unknown> = { ...current.spec };
        for (const [k, v] of Object.entries(spec)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        const updated = {
          ...current,
          metadata: { ...current.metadata, resourceVersion: String(rv++) },
          spec: merged as ManagementClusterSpec,
        };
        connections.set(name, updated);
        return structuredClone(updated);
      },
      patchStatus: async (name: string, status: Record<string, unknown>) => {
        const current = connections.get(name);
        if (!current) throw err(404);
        const merged = Object.fromEntries(
          Object.entries({ ...current.status, ...status }).filter(([, v]) => v !== null),
        ) as ManagementClusterStatus;
        const updated = {
          ...current,
          metadata: { ...current.metadata, resourceVersion: String(rv++) },
          status: merged,
        };
        connections.set(name, updated);
        return structuredClone(updated);
      },
      delete: async (name: string) => {
        if (!connections.delete(name)) throw err(404);
      },
    },
    connectionCache: {
      get: (name: string) => structuredClone(connections.get(name)),
      list: () => [...connections.values()].map((c) => structuredClone(c)),
      upsert: () => undefined,
      remove: () => undefined,
      isSynced: true,
    },
    helmRepositories: {
      create: async (meta: { name: string }, spec: HelmRepositorySpec) => {
        if (helmRepositories.has(meta.name)) throw err(409);
        const obj = {
          apiVersion: 'navigator.capi-navigator.io/v1alpha1',
          kind: 'HelmRepository',
          metadata: { name: meta.name, resourceVersion: String(rv++) },
          spec,
        };
        helmRepositories.set(meta.name, obj);
        return structuredClone(obj);
      },
      patchSpec: async (name: string, spec: Partial<HelmRepositorySpec>) => {
        const current = helmRepositories.get(name);
        if (!current) throw err(404);
        const updated = {
          ...current,
          metadata: { ...current.metadata, resourceVersion: String(rv++) },
          spec: { ...current.spec, ...spec },
        };
        helmRepositories.set(name, updated);
        return structuredClone(updated);
      },
      delete: async (name: string) => {
        if (!helmRepositories.delete(name)) throw err(404);
      },
    },
    helmRepositoryCache: {
      get: (name: string) => structuredClone(helmRepositories.get(name)),
      list: () => [...helmRepositories.values()].map((c) => structuredClone(c)),
      upsert: () => undefined,
      remove: () => undefined,
      isSynced: true,
    },
    auditEvents: {
      create: async (_meta: unknown, spec: AuditEventSpec) => {
        const obj = {
          apiVersion: 'navigator.capi-navigator.io/v1alpha1',
          kind: 'AuditEvent',
          metadata: { name: `audit-${auditEvents.length}` },
          spec,
        };
        auditEvents.push(obj);
        return obj;
      },
      list: async () => ({ items: [...auditEvents] }),
      delete: async (name: string) => {
        const idx = auditEvents.findIndex((e) => e.metadata.name === name);
        if (idx < 0) throw err(404);
        auditEvents.splice(idx, 1);
      },
    },
  };

  return {
    store: store as unknown as StoreService,
    users,
    secrets,
    auditEvents,
    connections,
    helmRepositories,
  };
}
