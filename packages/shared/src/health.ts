import { z } from 'zod';

/** Status of the home cluster as seen by the backend (FP0-F-03). */
export const HomeClusterStatusSchema = z.object({
  reachable: z.boolean(),
  /** Kubernetes git version, e.g. "v1.34.0"; only set when reachable. */
  version: z.string().optional(),
  /** Short, human-readable reason when not reachable. Never contains credentials. */
  message: z.string().optional(),
});
export type HomeClusterStatus = z.infer<typeof HomeClusterStatusSchema>;

/** Response of `GET /api/health` (FP0-F-03). */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  homeCluster: HomeClusterStatusSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** Answer of the liveness and readiness probes (/healthz, /readyz). */
export const ProbeStatusSchema = z.object({ status: z.literal('ok') });
export type ProbeStatus = z.infer<typeof ProbeStatusSchema>;
