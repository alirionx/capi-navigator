import { z } from 'zod';
import { PermissionSchema } from '../permissions.js';
import type { CrdDefinition } from './types.js';

/**
 * `NavigatorRole` (FP19-F-02): a custom role as a set of permissions. The name of the resource is
 * the role name; the built-in roles viewer, operator and admin exist only in code.
 */
export const NavigatorRoleSpecSchema = z.object({
  displayName: z.string().min(1).max(60),
  description: z.string().max(300).optional(),
  /** `view` is always granted in addition. */
  permissions: z.array(PermissionSchema).max(32),
});
export type NavigatorRoleSpec = z.infer<typeof NavigatorRoleSpecSchema>;

export const NavigatorRoleCrd: CrdDefinition<typeof NavigatorRoleSpecSchema> = {
  kind: 'NavigatorRole',
  plural: 'navigatorroles',
  singular: 'navigatorrole',
  shortNames: ['navrole'],
  scope: 'Namespaced',
  spec: NavigatorRoleSpecSchema,
  printerColumns: [
    { name: 'Display name', type: 'string', jsonPath: '.spec.displayName' },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
  ],
};
