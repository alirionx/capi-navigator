import { z } from 'zod';

import {
  EffectiveBindingSchema,
  RoleBindingSchema,
  ROLES,
  RoleSchema,
  type Role,
} from './permissions.js';

export { ROLES, RoleSchema, type Role };

/** True if `role` grants at least the permissions of `required` (FP1-F-04). */
export function hasRole(role: Role, required: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(required);
}

/** Lowercase DNS label, so the username can be used as a Kubernetes object name. */
export const UsernameSchema = z
  .string()
  .min(3, 'At least 3 characters')
  .max(40, 'At most 40 characters')
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    'Lowercase letters, digits and "-" only; must start and end with a letter or digit',
  );

export const PASSWORD_MIN_LENGTH = 8;
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `At least ${PASSWORD_MIN_LENGTH} characters`)
  .max(256, 'At most 256 characters');

export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(40),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: PasswordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'The new password must differ from the current one',
    path: ['newPassword'],
  });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/** The signed-in user as returned by `GET /api/auth/me`. */
export const MeSchema = z.object({
  username: z.string(),
  /**
   * Highest built-in role among the unlimited assignments, for display until the frontend checks
   * permissions (FP-19 step 5); "viewer" otherwise.
   */
  role: RoleSchema,
  /** Role assignments with the permissions they grant (FP19-F-10). */
  bindings: z.array(EffectiveBindingSchema),
  mustChangePassword: z.boolean(),
  /** Where the person signed in: a local account or the OpenID Connect provider (FP14-F-07). */
  source: z.enum(['local', 'oidc']),
  /** OIDC only: the person's groups that are mapped in the app (FP14-F-06). */
  groups: z.array(z.string()).optional(),
  /** OIDC only: the person's subject, for a person mapping (FP14-F-04). */
  subject: z.string().optional(),
});
export type Me = z.infer<typeof MeSchema>;

/** A user as shown in the user management (FP1-F-05). Never contains password data (NF-01). */
export const UserSchema = z.object({
  username: z.string(),
  /** Highest built-in role among the unlimited assignments (display, see MeSchema). */
  role: RoleSchema,
  /** Role assignments (FP19-F-03). */
  bindings: z.array(RoleBindingSchema),
  disabled: z.boolean(),
  /** Technical user: no password, no sign-in, API tokens only (FP22-F-01). */
  apiOnly: z.boolean(),
  mustChangePassword: z.boolean(),
  createdAt: z.string().optional(),
});
export type User = z.infer<typeof UserSchema>;
export const UserListSchema = z.array(UserSchema);

const BindingsSchema = z.array(RoleBindingSchema).max(50, 'At most 50 role assignments');

export const CreateUserRequestSchema = z
  .object({
    username: UsernameSchema,
    /** Shortcut for one unlimited assignment of a built-in role; `bindings` wins if given. */
    role: RoleSchema.optional(),
    /** Role assignments (FP19-F-03). */
    bindings: BindingsSchema.optional(),
    /** Technical user without password and sign-in, for API tokens (FP22-F-01). */
    apiOnly: z.boolean().default(false),
    /** Initial password; the user must change it on first login. Not for technical users. */
    password: PasswordSchema.optional(),
  })
  .refine((v) => v.role !== undefined || v.bindings !== undefined, {
    message: 'A role or role assignments are required',
    path: ['bindings'],
  })
  .refine((v) => (v.apiOnly ? v.password === undefined : v.password !== undefined), {
    message: 'Users need an initial password; technical users have none',
    path: ['password'],
  });
/** Input shape: `apiOnly` may be left out (default false). */
export type CreateUserRequest = z.input<typeof CreateUserRequestSchema>;

export const UpdateUserRequestSchema = z
  .object({
    role: RoleSchema.optional(),
    /** Replaces all role assignments (FP19-F-03); wins over `role`. */
    bindings: BindingsSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.bindings !== undefined || v.disabled !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  /** New temporary password; the user must change it on next login. */
  password: PasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

// ---- API tokens of technical users (FP-22, ADR-0017) ----

/** Prefix of API tokens; lets secret scanners recognise leaked tokens (FP22-F-03). */
export const API_TOKEN_PREFIX = 'capin_';
export const API_TOKEN_MAX_DAYS = 365;

export const TokenNameSchema = z
  .string()
  .min(2, 'At least 2 characters')
  .max(40, 'At most 40 characters')
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    'Lowercase letters, digits and "-" only; must start and end with a letter or digit',
  );

/** A token as listed in the user management; never contains the token or its hash. */
export const TokenInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
  createdBy: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().optional(),
  expired: z.boolean(),
});
export type TokenInfo = z.infer<typeof TokenInfoSchema>;
export const TokenInfoListSchema = z.array(TokenInfoSchema);

export const CreateTokenRequestSchema = z.object({
  name: TokenNameSchema,
  description: z.string().trim().max(200, 'At most 200 characters').optional(),
  /** Validity in days (FP22-F-02). Default: 90. */
  expiresInDays: z
    .int()
    .min(1, 'At least 1 day')
    .max(API_TOKEN_MAX_DAYS, `At most ${API_TOKEN_MAX_DAYS} days`)
    .default(90),
});
export type CreateTokenRequest = z.input<typeof CreateTokenRequestSchema>;

/** Answer after generating a token: the only time the token value is returned (FP22-F-03). */
export const CreatedTokenSchema = TokenInfoSchema.extend({ token: z.string() });
export type CreatedToken = z.infer<typeof CreatedTokenSchema>;
