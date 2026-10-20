import { z } from 'zod';
import { NavigatorGroupSpecSchema, OidcGroupNameSchema } from './crds/navigator-group.js';
import { RoleBindingSchema } from './permissions.js';

/**
 * Sign-in options for the login page (FP14-F-07): the local form is always there; the OpenID
 * Connect button only when a provider is configured.
 */
export const AuthOptionsSchema = z.object({
  oidc: z
    .object({
      /** Text of the sign-in button, e.g. "Sign in with Okta". */
      label: z.string(),
    })
    .nullable(),
});
export type AuthOptions = z.infer<typeof AuthOptionsSchema>;

/** A group mapping (FP14-F-04) as shown in the user management. */
export const GroupMappingSchema = z.object({
  /** Resource name, derived from the group. */
  name: z.string(),
  group: z.string(),
  description: z.string().optional(),
  bindings: z.array(RoleBindingSchema),
  createdAt: z.string().optional(),
});
export type GroupMapping = z.infer<typeof GroupMappingSchema>;
export const GroupMappingListSchema = z.array(GroupMappingSchema);

export const CreateGroupMappingRequestSchema = NavigatorGroupSpecSchema;
export type CreateGroupMappingRequest = z.input<typeof CreateGroupMappingRequestSchema>;

export const UpdateGroupMappingRequestSchema = NavigatorGroupSpecSchema.omit({ group: true });
export type UpdateGroupMappingRequest = z.input<typeof UpdateGroupMappingRequestSchema>;

export { OidcGroupNameSchema };
