import { z } from 'zod';

/** Built-in roles from section 3 of the requirements, from least to most privileged. */
export const ROLES = ['viewer', 'operator', 'admin'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Permissions of FP-19 (requirements section 6, ADR-0015). */
export const PERMISSIONS = [
  'view',
  'clusters.create',
  'clusters.change',
  'clusters.delete',
  'clusters.kubeconfig',
  'nodes.shell',
  'addons.manage',
  'presets.manage',
  'providers.manage',
  'credentials.manage',
  'connections.manage',
  'helmRepositories.manage',
  'managementNodes.shell',
  'users.manage',
] as const;
export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof PermissionSchema>;

/**
 * Permissions a limited role assignment may grant (FP19-F-03). Everything else is a platform
 * permission and needs an unlimited assignment.
 */
export const SCOPABLE_PERMISSIONS: readonly Permission[] = [
  'clusters.create',
  'clusters.change',
  'clusters.delete',
  'clusters.kubeconfig',
  'nodes.shell',
  'addons.manage',
];
export const isScopable = (p: Permission) => SCOPABLE_PERMISSIONS.includes(p);

/** Groups and help texts for the roles page (FP19-F-09). */
export const PERMISSION_GROUPS: { group: string; permissions: Permission[] }[] = [
  { group: 'General', permissions: ['view'] },
  {
    group: 'Workload clusters',
    permissions: [
      'clusters.create',
      'clusters.change',
      'clusters.delete',
      'clusters.kubeconfig',
      'nodes.shell',
    ],
  },
  { group: 'Add-ons', permissions: ['addons.manage', 'presets.manage', 'helmRepositories.manage'] },
  {
    group: 'Platform',
    permissions: [
      'connections.manage',
      'providers.manage',
      'credentials.manage',
      'managementNodes.shell',
    ],
  },
  { group: 'Administration', permissions: ['users.manage'] },
];

/** Built-in roles: fixed, not changeable, exactly the access of FP-1 (FP19-F-01). */
export const BUILTIN_ROLES: Record<
  Role,
  { displayName: string; description: string; permissions: readonly Permission[] }
> = {
  viewer: {
    displayName: 'Viewer',
    description: 'Reads everything; no changes.',
    permissions: ['view'],
  },
  operator: {
    displayName: 'Operator',
    description: 'Creates, changes and deletes workload clusters and manages add-ons.',
    permissions: [
      'view',
      'clusters.create',
      'clusters.change',
      'clusters.delete',
      'clusters.kubeconfig',
      'nodes.shell',
      'addons.manage',
    ],
  },
  admin: {
    displayName: 'Admin',
    description: 'Everything, including providers, credentials, connections and users.',
    permissions: PERMISSIONS,
  },
};
export const isBuiltinRole = (name: string): name is Role =>
  (ROLES as readonly string[]).includes(name);

/** Name of a custom role: a DNS label, also the name of its `NavigatorRole` resource. */
export const RoleNameSchema = z
  .string()
  .min(2, 'At least 2 characters')
  .max(40, 'At most 40 characters')
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    'Lowercase letters, digits and "-" only; must start and end with a letter or digit',
  );

const NamespaceNameSchema = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Not a valid namespace name');

/**
 * One role assignment of a user (FP19-F-03), like a Kubernetes RoleBinding. Without
 * `connections`/`namespaces` it applies everywhere.
 */
export const RoleBindingSchema = z.object({
  role: RoleNameSchema,
  /** Management cluster connections the assignment is limited to. */
  connections: z.array(z.string().min(1).max(63)).min(1).optional(),
  /** Namespaces (in those connections) the assignment is limited to. */
  namespaces: z.array(NamespaceNameSchema).min(1).optional(),
});
export type RoleBinding = z.infer<typeof RoleBindingSchema>;

export const isUnlimited = (b: RoleBinding) => !b.connections && !b.namespaces;

/** An assignment together with the permissions its role grants, for the frontend (FP19-F-10). */
export const EffectiveBindingSchema = RoleBindingSchema.extend({
  permissions: z.array(PermissionSchema),
});
export type EffectiveBinding = z.infer<typeof EffectiveBindingSchema>;

/** Assignments with their permissions; assignments of unknown roles grant nothing. */
export function effectiveBindings(
  bindings: readonly RoleBinding[],
  rolePermissions: RolePermissions,
): EffectiveBinding[] {
  return bindings.map((b) => ({ ...b, permissions: [...(rolePermissions(b.role) ?? [])] }));
}

/** Highest built-in role among the unlimited assignments (display only, see MeSchema). */
export function displayRole(bindings: readonly RoleBinding[]): Role {
  const builtin = bindings
    .filter(isUnlimited)
    .map((b) => b.role)
    .filter((r): r is Role => (ROLES as readonly string[]).includes(r));
  return [...ROLES].reverse().find((r) => builtin.includes(r)) ?? 'viewer';
}

/** Where an action takes place; missing parts mean "somewhere" (FP19-F-05). */
export interface PermissionScope {
  connection?: string;
  namespace?: string;
}

/** Resolves the permissions of a role; `undefined` for an unknown role (grants nothing). */
export type RolePermissions = (role: string) => readonly Permission[] | undefined;

/**
 * True if one of the assignments grants `permission` in `scope` (FP19-F-05). Platform permissions
 * count only from unlimited assignments; reading (`view`) is never limited (FP19-F-04). An
 * assignment limited to some namespaces matches a scope without namespace (e.g. cloud lookups
 * of a connection): the namespace is checked again on the actual change.
 */
export function allows(
  bindings: readonly RoleBinding[],
  rolePermissions: RolePermissions,
  permission: Permission,
  scope: PermissionScope = {},
): boolean {
  return bindings.some((b) => {
    const granted = rolePermissions(b.role);
    if (!granted?.includes(permission) && !(permission === 'view' && granted)) return false;
    if (isUnlimited(b) || permission === 'view') return true;
    if (!isScopable(permission)) return false;
    // `undefined` means "somewhere"; any given value, also an empty one, must match exactly.
    if (
      b.connections &&
      scope.connection !== undefined &&
      !b.connections.includes(scope.connection)
    )
      return false;
    if (b.namespaces && scope.namespace !== undefined && !b.namespaces.includes(scope.namespace))
      return false;
    return true;
  });
}

/** Problems of an assignment list, e.g. platform permissions in a limited assignment. */
export function bindingProblems(
  bindings: readonly RoleBinding[],
  rolePermissions: RolePermissions,
): string[] {
  const problems: string[] = [];
  for (const b of bindings) {
    const granted = rolePermissions(b.role);
    if (!granted) {
      problems.push(`Role "${b.role}" does not exist`);
      continue;
    }
    if (!isUnlimited(b)) {
      const platform = granted.filter((p) => p !== 'view' && !isScopable(p));
      if (platform.length > 0) {
        problems.push(
          `Role "${b.role}" contains ${platform.join(', ')}, which can only be assigned without limits`,
        );
      }
    }
  }
  return problems;
}

/**
 * Assignments of a stored user (FP19-F-07): users created before FP-19 have only `role`, which
 * becomes one unlimited assignment.
 */
export function userBindings(spec: { role?: Role; bindings?: RoleBinding[] }): RoleBinding[] {
  // Once written, `bindings` wins, also when empty (all access removed).
  if (spec.bindings) return spec.bindings;
  return spec.role ? [{ role: spec.role }] : [];
}

/**
 * True if at least one enabled user keeps an unlimited assignment with `users.manage`
 * (FP19-F-08), so nobody can lock the app out of its user management.
 */
export function hasUserManager(
  users: readonly { disabled: boolean; bindings: readonly RoleBinding[] }[],
  rolePermissions: RolePermissions,
): boolean {
  return users.some(
    (u) =>
      !u.disabled &&
      u.bindings.some((b) => isUnlimited(b) && rolePermissions(b.role)?.includes('users.manage')),
  );
}

/** A role as shown on the roles page (FP19-F-09). */
export const RoleInfoSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  permissions: z.array(PermissionSchema),
  builtin: z.boolean(),
  /** Users with an assignment of this role. */
  users: z.array(z.string()),
});
export type RoleInfo = z.infer<typeof RoleInfoSchema>;
export const RoleInfoListSchema = z.array(RoleInfoSchema);

const RoleFieldsSchema = z.object({
  displayName: z.string().trim().min(1, 'Required').max(60, 'At most 60 characters'),
  description: z.string().trim().max(300, 'At most 300 characters').optional(),
  /** `view` is always granted in addition. */
  permissions: z.array(PermissionSchema).max(PERMISSIONS.length),
});
export const CreateRoleRequestSchema = RoleFieldsSchema.extend({
  name: RoleNameSchema.refine(
    (n) => !isBuiltinRole(n),
    'This name is reserved for a built-in role',
  ),
});
export type CreateRoleRequest = z.infer<typeof CreateRoleRequestSchema>;
export const UpdateRoleRequestSchema = RoleFieldsSchema;
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequestSchema>;
