import {
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  type KubernetesObject,
  type V1Secret,
} from '@kubernetes/client-node';
import {
  ACCOUNTS_NAMESPACE,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  MANAGED_NAMESPACE_LABEL,
  TOKEN_LABEL,
  type ManifestObject,
} from '@capi-navigator/shared';
import { isNotFound } from '../kube/errors.js';

/** What managed namespaces read and write in a workload cluster; replaced in tests (FP-36). */
export interface WorkloadAccess {
  server: string;
  caData?: string;
  /** Live objects of the kinds and namespaces of `expected`, by {@link objectKey}. */
  live(expected: ManifestObject[]): Promise<Map<string, KubernetesObject>>;
  /** Namespaces the app manages, also those left over from removed add-ons. */
  managedNamespaces(): Promise<string[]>;
  namespaceLabels(name: string): Promise<Record<string, string> | undefined>;
  /** The Calico resources of the isolation exist (FP36-F-03a). */
  hasCalico(): Promise<boolean>;
  tokenSecrets(): Promise<V1Secret[]>;
  createTokenSecret(secret: V1Secret): Promise<V1Secret>;
  deleteTokenSecret(name: string): Promise<void>;
  issueToken(
    serviceAccount: string,
    secret: { name: string; uid: string },
    lifetimeSeconds: number,
  ): Promise<{ token: string; expiresAt: string }>;
  deleteNamespace(name: string): Promise<void>;
  deleteTier(name: string): Promise<void>;
}

export const objectKey = (o: {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
}): string => `${o.kind}/${o.metadata?.namespace ?? ''}/${o.metadata?.name}`;

/**
 * The client renames fields that are reserved words in some languages when it reads a kind it
 * knows (`default` of a LimitRange becomes `_default`); back to the names of the API, so the
 * comparison sees no difference (found live).
 */
export function apiFieldNames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(apiFieldNames);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k.replace(/^_(?=[a-z])/, ''), apiFieldNames(v)]),
  );
}

const TIER = { apiVersion: 'crd.projectcalico.org/v1', kind: 'Tier' };
const ignoreNotFound = (err: unknown) => {
  if (!isNotFound(err)) throw err;
};

export function workloadAccess(kubeconfig: string): WorkloadAccess {
  const kc = new KubeConfig();
  kc.loadFromString(kubeconfig);
  const cluster = kc.getCurrentCluster();
  const core = kc.makeApiClient(CoreV1Api);
  const objects = KubernetesObjectApi.makeApiClient(kc);
  const byLabel = `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${MANAGED_NAMESPACE_LABEL}`;
  return {
    server: cluster?.server ?? '',
    ...(cluster?.caData ? { caData: cluster.caData } : {}),
    async live(expected) {
      const found = new Map<string, KubernetesObject>();
      await Promise.all(
        expected.map(async (o) => {
          const key = objectKey(o);
          await objects
            .read({
              apiVersion: o.apiVersion,
              kind: o.kind,
              metadata: { name: o.metadata.name, namespace: o.metadata.namespace },
            })
            .then(
              (live) => found.set(key, apiFieldNames(live) as KubernetesObject),
              ignoreNotFound,
            );
        }),
      );
      return found;
    },
    async managedNamespaces() {
      const { items } = await core.listNamespace({ labelSelector: byLabel });
      return items
        .filter((n) => n.metadata?.labels?.[MANAGED_NAMESPACE_LABEL] === n.metadata?.name)
        .map((n) => n.metadata!.name!);
    },
    async namespaceLabels(name) {
      try {
        return (await core.readNamespace({ name })).metadata?.labels ?? {};
      } catch (err) {
        ignoreNotFound(err);
        return undefined;
      }
    },
    async hasCalico() {
      try {
        await objects.list(TIER.apiVersion, TIER.kind);
        return true;
      } catch (err) {
        // The client reports an unknown kind without a status, a missing API group as 404.
        if (isNotFound(err) || /unrecognized/i.test(String(err))) return false;
        throw err;
      }
    },
    async tokenSecrets() {
      return (
        await core.listNamespacedSecret({
          namespace: ACCOUNTS_NAMESPACE,
          labelSelector: `${TOKEN_LABEL}=true`,
        })
      ).items;
    },
    createTokenSecret: (body) =>
      core.createNamespacedSecret({ namespace: ACCOUNTS_NAMESPACE, body }),
    async deleteTokenSecret(name) {
      await core
        .deleteNamespacedSecret({ namespace: ACCOUNTS_NAMESPACE, name })
        .then(() => undefined, ignoreNotFound);
    },
    async issueToken(serviceAccount, secret, lifetimeSeconds) {
      const res = await core.createNamespacedServiceAccountToken({
        namespace: ACCOUNTS_NAMESPACE,
        name: serviceAccount,
        body: {
          apiVersion: 'authentication.k8s.io/v1',
          kind: 'TokenRequest',
          spec: {
            audiences: [],
            expirationSeconds: lifetimeSeconds,
            boundObjectRef: { apiVersion: 'v1', kind: 'Secret', ...secret },
          },
        },
      });
      return {
        token: res.status!.token!,
        expiresAt: new Date(res.status!.expirationTimestamp!).toISOString(),
      };
    },
    async deleteNamespace(name) {
      await core.deleteNamespace({ name }).then(() => undefined, ignoreNotFound);
    },
    async deleteTier(name) {
      await objects
        .delete({ ...TIER, metadata: { name } } as KubernetesObject)
        .then(() => undefined, ignoreNotFound);
    },
  };
}
