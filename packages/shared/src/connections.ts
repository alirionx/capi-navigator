import { z } from 'zod';
import { HelmRepositoryNameSchema } from './helm/repository.js';

/** DNS label, so the name can be used in Kubernetes object names. */
export const ConnectionNameSchema = z
  .string()
  .min(2, 'At least 2 characters')
  .max(40, 'At most 40 characters')
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    'Lowercase letters, digits and "-" only; must start and end with a letter or digit',
  );

export const AUTH_TYPES = ['kubeconfig', 'token', 'in-cluster'] as const;
export const AuthTypeSchema = z.enum(AUTH_TYPES);
export type AuthType = z.infer<typeof AuthTypeSchema>;

const DisplayNameSchema = z.string().trim().max(80, 'At most 80 characters');

/** Upper bound for pasted or uploaded kubeconfigs and certificates. */
const MAX_DOCUMENT = 256 * 1024;

const PemSchema = z
  .string()
  .trim()
  .max(MAX_DOCUMENT)
  .refine((v) => v === '' || /-----BEGIN CERTIFICATE-----/.test(v), {
    message: 'Must be a PEM certificate (-----BEGIN CERTIFICATE-----)',
  });

/** Proxy URL without credentials: the outbound proxy is assumed to need no authentication. */
const ProxyUrlSchema = z
  .url({ protocol: /^https?$/, message: 'Must be an http:// or https:// URL' })
  .max(2048)
  .refine((v) => !new URL(v).username && !new URL(v).password, {
    message: 'Proxies with a user name or password are not supported',
  });

/**
 * FP-29: outbound proxy of a management cluster for provider controllers that need the internet
 * (Helm repositories, cloud APIs). Not secret: no credentials; the CA certificate is public.
 */
export const OutboundProxySchema = z.object({
  httpsProxy: ProxyUrlSchema,
  /** Default: the HTTPS proxy. */
  httpProxy: ProxyUrlSchema.optional(),
  /**
   * Comma-separated hosts, `.domain` suffixes, IPs and CIDRs (Go syntax) reached directly, e.g.
   * the networks of the workload clusters' API endpoints. The app adds the in-cluster entries.
   */
  noProxy: z
    .string()
    .trim()
    .max(4096, 'At most 4096 characters')
    .regex(/^[^\s]*$/, 'Comma-separated, without spaces')
    .optional(),
  /** CA certificate of a proxy that inspects TLS (PEM); added to the system trust store. */
  caCert: PemSchema.optional(),
});
export type OutboundProxy = z.infer<typeof OutboundProxySchema>;

/** Registry host with an optional port, without scheme, e.g. registry.example.com:5000. */
const RegistryHostSchema = z
  .string()
  .trim()
  .max(253)
  .regex(
    /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?(:\d{1,5})?$/,
    'A host name with an optional port, without https://',
  );

/** Repository path in OCI distribution syntax, e.g. proxy-docker-io or mirror/k8s. */
const RepositoryPathSchema = z
  .string()
  .trim()
  .max(255)
  .regex(
    /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/,
    'Lowercase path segments separated by "/", e.g. mirror/docker-io',
  );

/** Upstream registries every internal registry should mirror (FP29-F-10). */
export const DEFAULT_MIRRORED_REGISTRIES = ['docker.io', 'registry.k8s.io', 'ghcr.io', 'quay.io'];

/**
 * FP29-F-10: internal OCI registry that nodes without internet pull from. Images keep their names
 * through the mirror configuration of the container runtime; the binaries of the distributions are
 * OCI artifacts below `artifactsPath`. No credentials: nodes pull anonymously.
 */
export const InternalRegistrySchema = z.object({
  host: RegistryHostSchema,
  /** CA certificate of the registry (PEM); added to the nodes' trust store. */
  caCert: PemSchema.optional(),
  /** Path per upstream registry, e.g. docker.io → proxy-docker-io; unset: unchanged names. */
  mirrors: z
    .array(z.object({ upstream: RegistryHostSchema, path: RepositoryPathSchema.optional() }))
    .min(1, 'At least one upstream registry')
    .max(20)
    .refine((m) => new Set(m.map((e) => e.upstream)).size === m.length, {
      message: 'Each upstream registry only once',
    }),
  /** Repository path of the distributions' binaries, e.g. library → library/rke2-artifacts. */
  artifactsPath: RepositoryPathSchema,
});
export type InternalRegistry = z.infer<typeof InternalRegistrySchema>;

/** FP2-F-01: credentials of a connection, by auth type. */
export const ConnectionCredentialsSchema = z.discriminatedUnion('authType', [
  z.object({
    authType: z.literal('kubeconfig'),
    kubeconfig: z.string().min(1, 'Required').max(MAX_DOCUMENT, 'At most 256 KiB'),
    /** Context to use; default: the current-context of the kubeconfig. */
    context: z.string().max(253).optional(),
  }),
  z.object({
    authType: z.literal('token'),
    server: z
      .url({ protocol: /^https$/, message: 'Must be an https:// URL of the API server' })
      .max(2048),
    token: z
      .string()
      .trim()
      .min(1, 'Required')
      .max(16 * 1024),
    /** CA certificate of the API server (PEM); empty: system trust store. */
    caCert: PemSchema.optional(),
  }),
  /** FP2-F-03: the home cluster itself, using the backend's own service account. */
  z.object({ authType: z.literal('in-cluster') }),
]);
export type ConnectionCredentials = z.infer<typeof ConnectionCredentialsSchema>;

export const CreateConnectionRequestSchema = z.object({
  name: ConnectionNameSchema,
  displayName: DisplayNameSchema.optional(),
  credentials: ConnectionCredentialsSchema,
});
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequestSchema>;

export const UpdateConnectionRequestSchema = z
  .object({
    displayName: DisplayNameSchema.optional(),
    /** New credentials; omit to keep the stored ones. */
    credentials: ConnectionCredentialsSchema.optional(),
    /** Helm repository serving the manifest add-on chart (FP30-F-02); `null`: the default. */
    manifestChartRepository: HelmRepositoryNameSchema.nullable().optional(),
    /** Outbound proxy for provider controllers (FP-29); `null`: none. */
    outboundProxy: OutboundProxySchema.nullable().optional(),
    /** Internal registry for air-gapped workload clusters (FP29-F-10); `null`: none. */
    internalRegistry: InternalRegistrySchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.displayName !== undefined ||
      v.credentials !== undefined ||
      v.manifestChartRepository !== undefined ||
      v.outboundProxy !== undefined ||
      v.internalRegistry !== undefined,
    { message: 'Nothing to update' },
  );
export type UpdateConnectionRequest = z.infer<typeof UpdateConnectionRequestSchema>;

/** Request to list the contexts of a kubeconfig before saving it (no credentials returned). */
export const KubeconfigContextsRequestSchema = z.object({
  kubeconfig: z.string().min(1).max(MAX_DOCUMENT),
});
export const KubeconfigContextsSchema = z.object({
  currentContext: z.string().optional(),
  contexts: z.array(z.object({ name: z.string(), cluster: z.string(), server: z.string() })),
});
export type KubeconfigContexts = z.infer<typeof KubeconfigContextsSchema>;

/** One permission checked via SelfSubjectAccessReview (FP2-F-04). */
export const PermissionCheckSchema = z.object({
  group: z.string(),
  resource: z.string(),
  verb: z.string(),
  allowed: z.boolean(),
  /** "required" for daily work, "install" only for installing ORC and providers (FP-3). */
  level: z.enum(['required', 'install']),
  purpose: z.string(),
});
export type PermissionCheck = z.infer<typeof PermissionCheckSchema>;

export const CONNECTION_PHASES = ['Unknown', 'Reachable', 'Unreachable', 'Unauthorized'] as const;

/** Result of the last connection test (FP2-F-04), stored in the resource status. */
export const ManagementClusterStatusSchema = z.object({
  phase: z.enum(CONNECTION_PHASES).default('Unknown'),
  kubernetesVersion: z.string().optional(),
  lastCheckedAt: z.string().optional(),
  /** Understandable message and hint for problems (FP2-F-06). */
  message: z.string().optional(),
  hint: z.string().optional(),
  /** Original error, shown expandable. Never contains credentials. */
  details: z.string().optional(),
  permissions: z.array(PermissionCheckSchema).optional(),
});
export type ManagementClusterStatus = z.infer<typeof ManagementClusterStatusSchema>;

/** A connection as returned by the API. Never contains credentials (FP2-F-02). */
export const ConnectionSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  authType: AuthTypeSchema,
  server: z.string().optional(),
  context: z.string().optional(),
  /** FP30-F-02; unset: the chart on ghcr.io. */
  manifestChartRepository: z.string().optional(),
  /** FP-29; unset: provider controllers reach the internet directly. */
  outboundProxy: OutboundProxySchema.optional(),
  /** FP-29; unset: workload clusters cannot be created air-gapped. */
  internalRegistry: InternalRegistrySchema.optional(),
  createdAt: z.string().optional(),
  status: ManagementClusterStatusSchema,
});
export type Connection = z.infer<typeof ConnectionSchema>;
export const ConnectionListSchema = z.array(ConnectionSchema);
