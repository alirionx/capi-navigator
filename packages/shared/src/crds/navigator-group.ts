import { z } from 'zod';
import { RoleBindingSchema } from '../permissions.js';
import type { CrdDefinition } from './types.js';

/** A group name as the identity provider sends it: any text, e.g. a name, a path, a URL or an ID. */
export const OidcGroupNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter the group name from the identity provider')
  .max(256, 'At most 256 characters');

/** The provider's subject (`sub`) of a person: stable and unique per issuer. */
export const OidcSubjectSchema = z
  .string()
  .trim()
  .min(1, 'Enter the ID of the person (shown in their user menu)')
  .max(256, 'At most 256 characters');

/**
 * `NavigatorGroup` (FP14-F-04): maps one group of the OpenID Connect provider, or one person of it
 * (subject plus issuer), to role assignments. The resource name is derived from the group or the
 * person, so each has at most one mapping.
 */
export const NavigatorGroupSpecSchema = z.object({
  group: OidcGroupNameSchema.optional(),
  /** Person mapping: subject (`sub`) and the issuer it applies to (ADR-0019). */
  subject: OidcSubjectSchema.optional(),
  issuer: z.string().optional(),
  /** Person mapping: name for the list, e.g. as shown in the person's user menu. */
  displayName: z.string().trim().max(100).optional(),
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
    { name: 'Subject', type: 'string', jsonPath: '.spec.subject' },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
  ],
};
