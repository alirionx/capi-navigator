import { z } from 'zod';

/** Roles from section 3 of the requirements, ordered from least to most privileged. */
export const ROLES = ['viewer', 'operator', 'admin'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

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
  role: RoleSchema,
  mustChangePassword: z.boolean(),
});
export type Me = z.infer<typeof MeSchema>;

/** A user as shown in the user management (FP1-F-05). Never contains password data (NF-01). */
export const UserSchema = z.object({
  username: z.string(),
  role: RoleSchema,
  disabled: z.boolean(),
  mustChangePassword: z.boolean(),
  createdAt: z.string().optional(),
});
export type User = z.infer<typeof UserSchema>;
export const UserListSchema = z.array(UserSchema);

export const CreateUserRequestSchema = z.object({
  username: UsernameSchema,
  role: RoleSchema,
  /** Initial password; the user must change it on first login. */
  password: PasswordSchema,
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const UpdateUserRequestSchema = z
  .object({
    role: RoleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.disabled !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  /** New temporary password; the user must change it on next login. */
  password: PasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;
