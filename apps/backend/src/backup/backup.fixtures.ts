import type { V1Secret } from '@kubernetes/client-node';
import type { NavigatorBackupSettingsSpec } from '@capi-navigator/shared';
import type { StoreService } from '../store/store.service.js';

const API = 'navigator.capi-navigator.io/v1alpha1';

/** In-memory stand-in for the parts of StoreService the backup reads (FP-38 tests). */
export function backupStore() {
  const cr = (kind: string, names: string[]) => ({
    items: names.map((name) => ({
      apiVersion: API,
      kind,
      metadata: { name, uid: `uid-${name}`, resourceVersion: '1', namespace: 'test' },
      spec: { name },
      status: { phase: 'Ready' },
    })),
  });
  const list = (kind: string, names: string[]) => ({
    list: async (params: { _continue?: string } = {}) => {
      // Two pages for AuditEvents, to cover paging.
      if (kind === 'AuditEvent' && !params._continue)
        return { ...cr(kind, names.slice(0, 1)), continue: 'next' };
      if (kind === 'AuditEvent') return cr(kind, names.slice(1));
      return cr(kind, names);
    },
  });
  let settings:
    { metadata: { name: string }; spec: NavigatorBackupSettingsSpec; status?: unknown } | undefined;
  const plainSecrets = new Map<string, Record<string, string>>();
  const secret = (name: string, value: string): V1Secret => ({
    metadata: { name, labels: { 'app.kubernetes.io/part-of': 'capi-navigator' } },
    type: 'Opaque',
    data: { value: Buffer.from(value).toString('base64') },
  });
  const store = {
    namespace: 'capi-navigator-system',
    connections: list('ManagementCluster', ['in-cluster', 'aws']),
    connectionCache: {
      get: (name: string) =>
        ['in-cluster', 'aws'].includes(name) ? { metadata: { name }, spec: {} } : undefined,
    },
    helmRepositories: list('HelmRepository', ['bitnami']),
    roles: list('NavigatorRole', ['day2']),
    groups: list('NavigatorGroup', []),
    users: list('NavigatorUser', ['admin', 'zoe']),
    tokens: list('NavigatorToken', ['ci']),
    authSettings: list('NavigatorAuthSettings', ['oidc']),
    blueprints: list('ClusterBlueprint', ['small']),
    auditEvents: list('AuditEvent', ['audit-a', 'audit-b']),
    backupSettings: {
      list: async () => ({
        items: settings ? [{ apiVersion: API, kind: 'NavigatorBackupSettings', ...settings }] : [],
      }),
      get: async () => (settings ? structuredClone(settings) : undefined),
      create: async (meta: { name: string }, spec: NavigatorBackupSettingsSpec) => {
        settings = { metadata: { name: meta.name }, spec };
        return settings;
      },
      replaceSpec: async (_current: unknown, spec: NavigatorBackupSettingsSpec) => {
        settings = { ...settings, metadata: { name: 'default' }, spec };
        return settings;
      },
      patchStatus: async (_name: string, status: Record<string, unknown>) => {
        if (!settings) throw Object.assign(new Error('HTTP 404'), { code: 404 });
        settings = {
          ...settings,
          status: { ...((settings.status as object | undefined) ?? {}), ...status },
        };
        return settings;
      },
    },
    secrets: {
      get: async (name: string) => plainSecrets.get(name),
      put: async (name: string, data: Record<string, string>) => {
        plainSecrets.set(name, { ...data });
      },
      delete: async (name: string) => {
        plainSecrets.delete(name);
      },
      getRaw: async (name: string) =>
        [
          secret('management-cluster-aws-credentials', 'KUBECONFIG-OF-AWS'),
          secret('navigator-user-admin-password', 'HASH-OF-ADMIN'),
          secret('navigator-user-zoe-password', 'HASH-OF-ZOE'),
          secret('helm-repository-bitnami', 'REPO-PASSWORD'),
          secret('capi-navigator-session-key', 'SESSION-KEY'),
          secret('capi-navigator-oidc-client', 'OIDC-CLIENT-SECRET'),
          // Not part of a backup:
          secret('capi-navigator-initial-admin', 'INITIAL-ADMIN-PASSWORD'),
          secret('navigator-user-gone-password', 'ORPHANED-HASH'),
        ].find((x) => x.metadata?.name === name),
    },
    addonPresetOverridesConfigMap: async () => ({
      metadata: { name: 'capi-navigator-addon-presets', resourceVersion: '3' },
      data: { 'overrides.json': '{}' },
    }),
  };
  return {
    store: store as unknown as StoreService,
    settings: () => settings,
    secrets: plainSecrets,
  };
}
