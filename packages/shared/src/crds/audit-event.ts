import { z } from 'zod';
import type { CrdDefinition } from './types.js';

/** `AuditEvent` (FP1-F-06): who did what, when, on which cluster. */
export const AuditEventSpecSchema = z.object({
  /** ISO 8601 timestamp of the action. */
  timestamp: z.string(),
  /** Username of the actor; for failed logins the attempted username. */
  actor: z.string(),
  /** Action identifier, e.g. "user.create" or "auth.login". */
  action: z.string(),
  outcome: z.enum(['success', 'failure']),
  /** HTTP method and path of the request. */
  request: z.object({ method: z.string(), path: z.string() }).optional(),
  target: z
    .object({
      kind: z.string(),
      name: z.string(),
      namespace: z.string().optional(),
    })
    .optional(),
  /** Management cluster the action ran against (from FP-2). */
  managementCluster: z.string().optional(),
  /** Name of the API token the request used (FP22-F-07); never the token itself. */
  token: z.string().optional(),
  /** Short reason for a failure. Never contains credentials (NF-01). */
  message: z.string().optional(),
});
export type AuditEventSpec = z.infer<typeof AuditEventSpecSchema>;

export const AuditEventCrd: CrdDefinition<typeof AuditEventSpecSchema> = {
  kind: 'AuditEvent',
  plural: 'auditevents',
  singular: 'auditevent',
  scope: 'Namespaced',
  spec: AuditEventSpecSchema,
  printerColumns: [
    { name: 'Actor', type: 'string', jsonPath: '.spec.actor' },
    { name: 'Action', type: 'string', jsonPath: '.spec.action' },
    { name: 'Outcome', type: 'string', jsonPath: '.spec.outcome' },
    { name: 'Time', type: 'date', jsonPath: '.spec.timestamp' },
  ],
};
