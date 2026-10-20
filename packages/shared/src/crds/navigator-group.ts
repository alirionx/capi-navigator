import { z } from 'zod';
import { RoleBindingSchema } from '../permissions.js';
import type { CrdDefinition } from './types.js';

/** A group name as the identity provider sends it: any text, e.g. a name, a path, a URL or an ID. */
export const OidcGroupNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter the group name from the identity provider')
  .max(256, 'At most 256 characters');

/**
 * `NavigatorGroup` (FP14-F-04): maps one group of the OpenID Connect provider to role
 * assignments. The resource name is derived from the group (`oidcGroupResourceName`), so each group
 * has at most one mapping.
 */
export const NavigatorGroupSpecSchema = z.object({
  group: OidcGroupNameSchema,
  description: z.string().max(300).optional(),
  bindings: z.array(RoleBindingSchema).min(1, 'Add at least one role assignment').max(50),
});
export type NavigatorGroupSpec = z.infer<typeof NavigatorGroupSpecSchema>;

export const NavigatorGroupCrd: CrdDefinition<typeof NavigatorGroupSpecSchema> = {
  kind: 'NavigatorGroup',
  plural: 'navigatorgroups',
  singular: 'navigatorgroup',
  shortNames: ['navgroup'],
  scope: 'Namespaced',
  spec: NavigatorGroupSpecSchema,
  printerColumns: [
    { name: 'Group', type: 'string', jsonPath: '.spec.group' },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
  ],
};
