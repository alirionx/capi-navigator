import { z } from 'zod';

/**
 * Helm repositories (FP8-F-02, FP8-F-03), stored as `HelmRepository` resources in the home cluster.
 * Credentials and the CA certificate live in a Secret. CAAPH v0.6.4 uses them for OCI registries
 * only (HelmChartProxy `credentials` and `tlsConfig`), so HTTP repositories have neither.
 */
export const HELM_REPOSITORY_TYPES = ['http', 'oci'] as const;
export const HelmRepositoryTypeSchema = z.enum(HELM_REPOSITORY_TYPES);
export type HelmRepositoryType = z.infer<typeof HelmRepositoryTypeSchema>;

export const HelmRepositoryNameSchema = z
  .string()
  .min(2, 'At least 2 characters')
  .max(40, 'At most 40 characters')
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    'Lowercase letters, digits and "-" only; must start and end with a letter or digit',
  );

const HTTP_URL = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/;
const OCI_URL = /^oci:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[a-z0-9._/-]+)?$/;

/** Repository URL without trailing slash; checked against the type. */
const UrlSchema = z
  .string()
  .trim()
  .max(512)
  .transform((u) => u.replace(/\/+$/, ''));

function checkUrl(type: HelmRepositoryType, url: string, ctx: z.RefinementCtx): void {
  if (type === 'http' && !HTTP_URL.test(url)) {
    ctx.addIssue({
      code: 'custom',
      path: ['url'],
      message: 'An http(s):// URL, e.g. https://stefanprodan.github.io/podinfo',
    });
  }
  if (type === 'oci' && !OCI_URL.test(url)) {
    ctx.addIssue({
      code: 'custom',
      path: ['url'],
      message: 'An oci:// URL without the chart name, e.g. oci://ghcr.io/stefanprodan/charts',
    });
  }
}

export const HelmRepositorySpecSchema = z
  .object({
    displayName: z.string().max(80).optional(),
    type: HelmRepositoryTypeSchema,
    url: UrlSchema,
    /** OCI only: skip the server certificate check (CAAPH tlsConfig.insecureSkipTLSVerify). */
    insecureSkipTLSVerify: z.boolean().default(false),
    /** Username and password are stored in the repository Secret (OCI only). */
    hasCredentials: z.boolean().default(false),
    /** A CA certificate (PEM) is stored in the repository Secret (OCI only). */
    hasCaCertificate: z.boolean().default(false),
    /** Incremented on every Secret change, so copies in the management clusters are refreshed. */
    credentialsRevision: z.int().min(0).default(0),
  })
  .superRefine((s, ctx) => checkUrl(s.type, s.url, ctx));
export type HelmRepositorySpec = z.infer<typeof HelmRepositorySpecSchema>;

const PemSchema = z
  .string()
  .trim()
  .max(64 * 1024)
  .regex(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/, 'A PEM certificate');

export const RegistryCredentialsSchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(4096),
});

export const CreateHelmRepositoryRequestSchema = z
  .object({
    name: HelmRepositoryNameSchema,
    displayName: z.string().max(80).optional(),
    type: HelmRepositoryTypeSchema,
    url: UrlSchema,
    insecureSkipTLSVerify: z.boolean().default(false),
    credentials: RegistryCredentialsSchema.optional(),
    caCertificate: PemSchema.optional(),
  })
  .superRefine((r, ctx) => {
    checkUrl(r.type, r.url, ctx);
    if (r.type === 'http' && (r.credentials || r.caCertificate || r.insecureSkipTLSVerify)) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'Credentials and TLS options are supported for OCI registries only (CAAPH)',
      });
    }
  });
export type CreateHelmRepositoryRequest = z.input<typeof CreateHelmRepositoryRequestSchema>;

/** Changes; `null` removes credentials or CA certificate. The type cannot change. */
export const UpdateHelmRepositoryRequestSchema = z.object({
  displayName: z.string().max(80).optional(),
  url: UrlSchema.optional(),
  insecureSkipTLSVerify: z.boolean().optional(),
  credentials: RegistryCredentialsSchema.nullable().optional(),
  caCertificate: PemSchema.nullable().optional(),
});
export type UpdateHelmRepositoryRequest = z.input<typeof UpdateHelmRepositoryRequestSchema>;

/** A repository as the API returns it: never with credentials. */
export const HelmRepositorySchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  type: HelmRepositoryTypeSchema,
  url: z.string(),
  insecureSkipTLSVerify: z.boolean(),
  hasCredentials: z.boolean(),
  hasCaCertificate: z.boolean(),
  createdAt: z.string().optional(),
});
export type HelmRepository = z.infer<typeof HelmRepositorySchema>;

export const HelmRepositoryTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  hint: z.string().optional(),
});
export type HelmRepositoryTestResult = z.infer<typeof HelmRepositoryTestResultSchema>;

/** Chart browser (FP8-F-04). OCI registries cannot list charts; the name is typed in. */
export const ChartSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  latestVersion: z.string().optional(),
  appVersion: z.string().optional(),
  icon: z.string().optional(),
  deprecated: z.boolean().optional(),
});
export type ChartSummary = z.infer<typeof ChartSummarySchema>;

export const ChartVersionSchema = z.object({
  version: z.string(),
  appVersion: z.string().optional(),
  created: z.string().optional(),
});
export type ChartVersion = z.infer<typeof ChartVersionSchema>;

export const ChartValuesSchema = z.object({
  chart: z.string(),
  version: z.string(),
  values: z.string(),
});
export type ChartValues = z.infer<typeof ChartValuesSchema>;

/** Secret of a repository in the home cluster (keys username, password, ca.crt). */
export function helmRepositorySecretName(name: string): string {
  return `helm-repository-${name}`;
}

/** Copy of the repository Secret next to the HelmChartProxies in a management cluster. */
export function helmRepositoryCopyName(name: string): string {
  return `capi-navigator-helm-${name}`;
}

/** Registry host of an OCI repository URL, e.g. ghcr.io or 10.0.0.5:5000. */
export function ociHost(url: string): string {
  return url.replace(/^oci:\/\//, '').split('/')[0]!;
}

/**
 * Helm registry config (docker `config.json` format) for one registry; CAAPH passes it to Helm as
 * the registry config file. Contains the password: only ever written into Secrets.
 */
export function registryConfigJson(url: string, username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  const auth = btoa(String.fromCharCode(...bytes));
  return JSON.stringify({ auths: { [ociHost(url)]: { auth } } });
}
