import { z } from 'zod';

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
  LOG_JSON: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
