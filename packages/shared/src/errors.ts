import { z } from 'zod';

/**
 * Error body of every failed API call (NF-06): an understandable message, an optional hint for
 * resolution and optional details (e.g. the original Kubernetes error), shown expandable.
 */
export const ApiErrorBodySchema = z.object({
  statusCode: z.number(),
  message: z.string(),
  hint: z.string().optional(),
  details: z.string().optional(),
  /** Field errors of a failed validation, keyed by dotted path. */
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/** Header every mutating request must carry (CSRF protection, NF-04). */
export const CSRF_HEADER = 'x-capi-navigator';
export const CSRF_HEADER_VALUE = '1';
