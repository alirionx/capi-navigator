import { z } from 'zod';
import { RoleSchema } from '../auth.js';
import { RoleBindingSchema } from '../permissions.js';
import type { CrdDefinition } from './types.js';

/**
 * `NavigatorUser` (FP1-F-01). The password hash is not part of the resource; it lives in the
 * Secret named by {@link passwordSecretName}.
 */
export const NavigatorUserSpecSchema = z.object({
  /** Role of users created before FP-19; read as one unlimited assignment (FP19-F-07). */
  role: RoleSchema.optional(),
  /** Role assignments (FP19-F-03); replace `role` on the next change of the user. */
  bindings: z.array(RoleBindingSchema).max(50).optional(),
  disabled: z.boolean().default(false),
  /** Technical user (FP22-F-01): no password, no sign-in; uses API tokens. */
  apiOnly: z.boolean().default(false),
  mustChangePassword: z.boolean().default(false),
  /**
   * Incremented on password change, reset, disable and role change. Session cookies carry the
   * generation they were issued for, so increasing it invalidates all existing sessions.
   */
  sessionGeneration: z.int().min(0).default(0),
});
export type NavigatorUserSpec = z.infer<typeof NavigatorUserSpecSchema>;

export const NavigatorUserCrd: CrdDefinition<typeof NavigatorUserSpecSchema> = {
  kind: 'NavigatorUser',
  plural: 'navigatorusers',
  singular: 'navigatoruser',
  shortNames: ['navuser'],
  scope: 'Namespaced',
  spec: NavigatorUserSpecSchema,
  printerColumns: [
    { name: 'Roles', type: 'string', jsonPath: '.spec.bindings[*].role' },
    { name: 'Disabled', type: 'boolean', jsonPath: '.spec.disabled' },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
  ],
};

/** Name of the Secret holding a user's password hash. */
export function passwordSecretName(username: string): string {
  return `navigator-user-${username}-password`;
}
