import { z } from 'zod';
import { OidcSettingsSchema } from './crds/navigator-auth-settings.js';
import {
  NavigatorGroupSpecSchema,
  OidcGroupNameSchema,
  OidcSubjectSchema,
} from './crds/navigator-group.js';
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

/** After sign-out: where to send the browser to sign out at the provider too (FP14-F-10). */
export const LogoutResponseSchema = z.object({ endSessionUrl: z.string().optional() });
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

/** A mapping of a group or a person (FP14-F-04) as shown in the user management. */
export const GroupMappingSchema = z.object({
  /** Resource name, derived from the group or the person. */
  name: z.string(),
  kind: z.enum(['group', 'person']),
  group: z.string().optional(),
  subject: z.string().optional(),
  issuer: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  bindings: z.array(RoleBindingSchema),
  createdAt: z.string().optional(),
});
export type GroupMapping = z.infer<typeof GroupMappingSchema>;
export const GroupMappingListSchema = z.array(GroupMappingSchema);

const MappingBase = NavigatorGroupSpecSchema.pick({ description: true, bindings: true });

/**
 * A group, or a person by subject; the issuer of a person mapping is the configured provider's
 * (set by the backend).
 */
export const CreateGroupMappingRequestSchema = z.union([
  MappingBase.extend({ group: OidcGroupNameSchema }).strict(),
  MappingBase.extend({
    subject: OidcSubjectSchema,
    displayName: NavigatorGroupSpecSchema.shape.displayName,
  }).strict(),
]);
export type CreateGroupMappingRequest = z.input<typeof CreateGroupMappingRequestSchema>;

export const UpdateGroupMappingRequestSchema = MappingBase.extend({
  displayName: NavigatorGroupSpecSchema.shape.displayName,
});
export type UpdateGroupMappingRequest = z.input<typeof UpdateGroupMappingRequestSchema>;

/** A person who signed in with the configured provider recently (FP14-F-15), from the audit log. */
export const OidcSignInSchema = z.object({
  subject: z.string(),
  name: z.string(),
  lastSignIn: z.string(),
  outcome: z.enum(['success', 'failure']),
  /** Where the person's access comes from now. */
  access: z.object({
    kind: z.enum(['groups', 'person', 'default', 'none']),
    /** Mapped groups (kind groups; with a person mapping too), or the default role. */
    detail: z.array(z.string()).default([]),
  }),
  /** Name of the person mapping, if any. */
  mapping: z.string().optional(),
});
export type OidcSignIn = z.infer<typeof OidcSignInSchema>;
export const OidcSignInListSchema = z.array(OidcSignInSchema);

export { OidcGroupNameSchema, OidcSubjectSchema };

/** The Authentication page (FP14-F-12): settings without the secret, and the deployment values. */
export const AuthSettingsSchema = z.object({
  /** null until the provider was configured once. */
  oidc: OidcSettingsSchema.extend({ secretSet: z.boolean() }).nullable(),
  /** Helm value publicUrl; OIDC cannot be enabled without it (FP14-F-03). */
  publicUrl: z.string().nullable(),
  /** The redirect URI to register at the provider; null without public URL. */
  redirectUri: z.string().nullable(),
});
export type AuthSettings = z.infer<typeof AuthSettingsSchema>;

/**
 * Saving the provider settings. `clientSecret` is write-only (FP14-F-14): left out, the stored one
 * is kept.
 */
export const UpdateOidcSettingsRequestSchema = OidcSettingsSchema.extend({
  clientSecret: z.string().min(1).max(1024).optional(),
});
export type UpdateOidcSettingsRequest = z.input<typeof UpdateOidcSettingsRequestSchema>;

/** Discovery test with the entered values, before saving (FP14-F-12). */
export const OidcTestRequestSchema = z.object({ issuerUrl: OidcSettingsSchema.shape.issuerUrl });
export type OidcTestRequest = z.infer<typeof OidcTestRequestSchema>;

export const OidcTestResultSchema = z.object({
  ok: z.boolean(),
  /** Why the test failed, in words. */
  message: z.string().optional(),
  issuer: z.string().optional(),
  authorizationEndpoint: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  userinfoEndpoint: z.string().optional(),
  endSessionEndpoint: z.string().optional(),
  scopesSupported: z.array(z.string()).optional(),
  claimsSupported: z.array(z.string()).optional(),
});
export type OidcTestResult = z.infer<typeof OidcTestResultSchema>;
