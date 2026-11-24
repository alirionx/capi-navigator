import { defineStore } from 'pinia';
import {
  AddonPreviewSchema,
  ManagedNamespacesSchema,
  NamespaceTokenResponseSchema,
  type ManagedNamespaceApplyRequest,
  type NamespaceTokenRequest,
} from '@capi-navigator/shared';
import { api, apiVoid } from '../api/client.js';

export interface ClusterKey {
  connection: string;
  namespace: string;
  name: string;
}
const enc = encodeURIComponent;
const base = (c: ClusterKey) =>
  `/api/connections/${enc(c.connection)}/clusters/${enc(c.namespace)}/${enc(c.name)}/namespaces`;
const item = (c: ClusterKey, namespace: string) => `${base(c)}/${enc(namespace)}`;

/** Managed namespaces of workload clusters (FP-36). Holds no tokens (ADR-0040). */
export const useNamespacesStore = defineStore('namespaces', () => ({
  list: (c: ClusterKey) => api('GET', base(c), ManagedNamespacesSchema),
  preview: (c: ClusterKey, req: ManagedNamespaceApplyRequest) =>
    api('POST', `${base(c)}/preview`, AddonPreviewSchema, req),
  apply: (c: ClusterKey, req: ManagedNamespaceApplyRequest) =>
    api('PUT', item(c, req.spec.name), AddonPreviewSchema, req),
  endAccess: (c: ClusterKey, namespace: string) => apiVoid('DELETE', item(c, namespace)),
  deleteNamespace: (c: ClusterKey, namespace: string, confirmName: string) =>
    apiVoid('POST', `${item(c, namespace)}/delete`, { confirmName }),
  issueToken: (c: ClusterKey, namespace: string, account: string, req: NamespaceTokenRequest) =>
    api(
      'POST',
      `${item(c, namespace)}/accounts/${enc(account)}/tokens`,
      NamespaceTokenResponseSchema,
      req,
    ),
  revokeToken: (c: ClusterKey, namespace: string, id: string) =>
    apiVoid('DELETE', `${item(c, namespace)}/tokens/${enc(id)}`),
}));
