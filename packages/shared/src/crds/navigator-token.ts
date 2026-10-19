import { z } from 'zod';
import type { CrdDefinition } from './types.js';

/**
 * `NavigatorToken` (FP-22, ADR-0017): an API token of a technical user. Holds the SHA-256 hash,
 * never the token: the hash is read from the informer cache on every request and cannot be turned
 * back into the token (256 bits of randomness).
 */
export const NavigatorTokenSpecSchema = z.object({
  /** Technical user the token acts as. */
  user: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** Hex SHA-256 of the token. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.string(),
  /** User who generated the token. */
  createdBy: z.string(),
});
export type NavigatorTokenSpec = z.infer<typeof NavigatorTokenSpecSchema>;

export const NavigatorTokenStatusSchema = z.object({
  /** Updated at most once per hour (FP22-F-09). */
  lastUsedAt: z.string().optional(),
});
export type NavigatorTokenStatus = z.infer<typeof NavigatorTokenStatusSchema>;

export const NavigatorTokenCrd: CrdDefinition<
  typeof NavigatorTokenSpecSchema,
  typeof NavigatorTokenStatusSchema
> = {
  kind: 'NavigatorToken',
  plural: 'navigatortokens',
  singular: 'navigatortoken',
  shortNames: ['navtoken'],
  scope: 'Namespaced',
  spec: NavigatorTokenSpecSchema,
  status: NavigatorTokenStatusSchema,
  printerColumns: [
    { name: 'User', type: 'string', jsonPath: '.spec.user' },
    { name: 'Token', type: 'string', jsonPath: '.spec.name' },
    { name: 'Expires', type: 'string', jsonPath: '.spec.expiresAt' },
    { name: 'Last used', type: 'string', jsonPath: '.status.lastUsedAt' },
  ],
};
