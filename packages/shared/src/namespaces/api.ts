import { stringify } from 'yaml';
import { z } from 'zod';
import { ManagedNamespaceSpecSchema, NAMESPACE_ROLES } from './managed-namespace.js';

/** API of the managed namespaces of one workload cluster (FP-36). */

/** FP36-F-08: limits of the app; 10 minutes is also the lower limit of the TokenRequest API. */
export const TOKEN_LIFETIME_SECONDS = { min: 600, max: 7 * 86_400, default: 7 * 86_400 } as const;

/** Labels and annotations of the Secret a token is bound to (FP36-F-09, ADR-0040). */
export const TOKEN_LABEL = 'capi-navigator.io/namespace-token';
export const TOKEN_ACCOUNT_ANNOTATION = 'capi-navigator.io/account';
export const TOKEN_CREATOR_ANNOTATION = 'capi-navigator.io/created-by';
export const TOKEN_EXPIRY_ANNOTATION = 'capi-navigator.io/expires-at';

/** An issued token, from its Secret; the token itself is never kept. */
export const NamespaceTokenSchema = z.object({
  id: z.string(),
  account: z.string(),
  createdBy: z.string().optional(),
  createdAt: z.string().optional(),
  expiresAt: z.string().optional(),
  expired: z.boolean(),
});
export type NamespaceToken = z.infer<typeof NamespaceTokenSchema>;

/** A generated object that is missing or was changed in the cluster (FP36-F-06). */
export const NamespaceDriftSchema = z.object({
  kind: z.string(),
  name: z.string(),
  missing: z.boolean(),
  fields: z.array(z.string()),
});
export type NamespaceDrift = z.infer<typeof NamespaceDriftSchema>;

export const ManagedNamespaceViewSchema = z.object({
  name: z.string(),
  /** Form model; unset for a namespace left over from a removed add-on (FP36-F-04). */
  spec: ManagedNamespaceSpecSchema.optional(),
  /** HelmChartProxy and its release on this cluster. */
  addon: z
    .object({ name: z.string(), ready: z.boolean(), message: z.string().optional() })
    .optional(),
  /** The namespace exists in the cluster. */
  exists: z.boolean(),
  leftOver: z.boolean(),
  /** Being deleted; nothing can be done with it until it is gone. */
  terminating: z.boolean(),
  drift: z.array(NamespaceDriftSchema),
  quota: z.array(z.object({ resource: z.string(), used: z.string(), hard: z.string() })),
  accounts: z.array(
    z.object({ name: z.string(), role: z.enum(NAMESPACE_ROLES), exists: z.boolean() }),
  ),
  tokens: z.array(NamespaceTokenSchema),
});
export type ManagedNamespaceView = z.infer<typeof ManagedNamespaceViewSchema>;

export const ManagedNamespacesSchema = z.object({
  /** Why the cluster cannot have managed namespaces (FP36-F-03a, F-14). */
  unsupported: z.string().optional(),
  /** The cluster could not be read; the namespaces come from the add-ons only. */
  unreachable: z.string().optional(),
  namespaces: z.array(ManagedNamespaceViewSchema),
});
export type ManagedNamespaces = z.infer<typeof ManagedNamespacesSchema>;

export const ManagedNamespaceApplyRequestSchema = z.object({
  spec: ManagedNamespaceSpecSchema,
  /** Take over fields of the HelmChartProxy changed outside the app (hard rule 4). */
  takeOver: z.boolean().default(false),
});
export type ManagedNamespaceApplyRequest = z.input<typeof ManagedNamespaceApplyRequestSchema>;

export const ManagedNamespaceDeleteRequestSchema = z.object({
  /** The name of the namespace, typed by the user (FP36-F-05). */
  confirmName: z.string(),
});

export const NamespaceTokenRequestSchema = z.object({
  lifetimeSeconds: z
    .int()
    .min(TOKEN_LIFETIME_SECONDS.min, 'At least 10 minutes')
    .max(TOKEN_LIFETIME_SECONDS.max, 'At most 7 days')
    .default(TOKEN_LIFETIME_SECONDS.default),
  format: z.enum(['token', 'kubeconfig']).default('kubeconfig'),
});
export type NamespaceTokenRequest = z.input<typeof NamespaceTokenRequestSchema>;

/** The only response that ever contains the token (FP36-F-10). */
export const NamespaceTokenResponseSchema = z.object({
  id: z.string(),
  format: z.enum(['token', 'kubeconfig']),
  content: z.string(),
  expiresAt: z.string(),
  fileName: z.string(),
});
export type NamespaceTokenResponse = z.infer<typeof NamespaceTokenResponseSchema>;

/** Pure: kubeconfig of a service account with the managed namespace as default (FP36-F-10). */
export function namespaceKubeconfig(args: {
  cluster: string;
  server: string;
  caData?: string;
  namespace: string;
  account: string;
  token: string;
}): string {
  const context = `${args.cluster}-${args.namespace}`;
  return stringify(
    {
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [
        {
          name: args.cluster,
          cluster: {
            server: args.server,
            ...(args.caData ? { 'certificate-authority-data': args.caData } : {}),
          },
        },
      ],
      users: [{ name: args.account, user: { token: args.token } }],
      contexts: [
        {
          name: context,
          context: { cluster: args.cluster, user: args.account, namespace: args.namespace },
        },
      ],
      'current-context': context,
    },
    { lineWidth: 0 },
  );
}
