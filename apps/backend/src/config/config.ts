import { hostname } from 'node:os';
import { PASSWORD_MIN_LENGTH } from '@capi-navigator/shared';
import { SHELL_DEFAULT_IMAGE } from '@capi-navigator/shared';
import { z } from 'zod';

const bool = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((v) => v === 'true');

/** Optional setting; an empty value (e.g. from an unset Helm value) counts as not set. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

/**
 * Backend configuration, taken exclusively from environment variables (12-factor, section 4).
 * The settings ConfigMap follows in later packs.
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Namespace in the home cluster that holds the app's own state. */
  NAVIGATOR_NAMESPACE: z.string().default('capi-navigator-system'),
  /** Directory with the built frontend; served statically when set (single image, section 4). */
  STATIC_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
  /** Set to "false" for human-readable logs in local development; JSON by default (NF-18). */
  LOG_JSON: bool('true'),
  /** Identity of this replica, used for leader election (defaults to the pod hostname). */
  POD_NAME: z.string().default(hostname()),

  /** FP1-F-02: password of the initial admin; alternatively the Secret capi-navigator-initial-admin. */
  INITIAL_ADMIN_PASSWORD: z.string().min(PASSWORD_MIN_LENGTH).optional(),
  /** FP1-F-03: absolute session lifetime. */
  SESSION_TTL_HOURS: z.coerce.number().positive().default(8),
  /** FP1-F-03: Secure cookie flag. Browsers accept Secure cookies on http://localhost. */
  COOKIE_SECURE: bool('true'),
  /** Express "trust proxy" setting, needed behind an ingress for correct client IPs. */
  TRUST_PROXY: z.string().default('loopback'),
  /** FP23-F-06: serve /api/openapi.json and Swagger UI under /api/docs. */
  API_DOCS_ENABLED: bool('true'),
  /** NF-04: failed login attempts per client and username within the window. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_WINDOW_MINUTES: z.coerce.number().positive().default(15),
  /** Section 4, State storage: AuditEvent retention. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  /** Image of the node shell pod (FP-17); e.g. a registry mirror in air-gapped setups. */
  NODE_SHELL_IMAGE: z.string().min(1).default(SHELL_DEFAULT_IMAGE),

  /** Public base URL of the app, e.g. https://capi.example.com (FP14-F-03). */
  PUBLIC_URL: optional(z.url({ protocol: /^https?$/ })),
  /** FP14-F-01: OpenID Connect sign-in; enabled when the issuer is set. */
  OIDC_ISSUER_URL: optional(z.url({ protocol: /^https?$/ })),
  OIDC_CLIENT_ID: optional(z.string()),
  /** From a Kubernetes Secret; never logged. */
  OIDC_CLIENT_SECRET: optional(z.string()),
  /** Space-separated; e.g. add "groups" for Dex. */
  OIDC_SCOPES: z.string().default('openid profile email'),
  /** Claim with the person's groups; may be a URL-like name (Auth0 namespaced claims). */
  OIDC_GROUPS_CLAIM: z.string().min(1).default('groups'),
  /** Claim with the display name; falls back to email, then the subject. */
  OIDC_USERNAME_CLAIM: z.string().min(1).default('preferred_username'),
  OIDC_BUTTON_LABEL: z.string().min(1).default('Sign in with OIDC'),
  /** FP14-F-05: role for people without a mapped group; empty refuses them. */
  OIDC_DEFAULT_ROLE: z.string().default('viewer'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(result.error)}`);
  }
  const config = result.data;
  if (config.OIDC_ISSUER_URL) {
    // FP14-F-03: the redirect URI comes from PUBLIC_URL, never from request headers.
    const missing = (['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'PUBLIC_URL'] as const).filter(
      (key) => !config[key],
    );
    if (missing.length) {
      throw new Error(
        `Invalid configuration: OIDC_ISSUER_URL is set, so ${missing.join(', ')} must be set too`,
      );
    }
  }
  return config;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
