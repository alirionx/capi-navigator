import { defineStore } from 'pinia';
import {
  MyNamespacesSchema,
  NamespaceTokenResponseSchema,
  type MyNamespace,
  type NamespaceTokenRequest,
} from '@capi-navigator/shared';
import { api, apiVoid } from '../api/client.js';

const BASE = '/api/my/namespaces';
const item = (n: MyNamespace) =>
  [
    BASE,
    ...[n.connection, n.clusterNamespace, n.cluster, n.namespace].map(encodeURIComponent),
  ].join('/');

/** The namespaces assigned to the signed-in person (FP-37). Holds no tokens (ADR-0040). */
export const useMyNamespacesStore = defineStore('my-namespaces', () => ({
  list: () => api('GET', BASE, MyNamespacesSchema),
  issueToken: (n: MyNamespace, account: string, req: NamespaceTokenRequest) =>
    api(
      'POST',
      `${item(n)}/accounts/${encodeURIComponent(account)}/tokens`,
      NamespaceTokenResponseSchema,
      req,
    ),
  revokeToken: (n: MyNamespace, id: string) =>
    apiVoid('DELETE', `${item(n)}/tokens/${encodeURIComponent(id)}`),
}));
