import { hostname } from 'node:os';
import { PASSWORD_MIN_LENGTH } from '@capi-navigator/shared';
import { SHELL_DEFAULT_IMAGE } from '@capi-navigator/shared';
import { z } from 'zod';

const bool = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((v) => v === 'true');

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
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
