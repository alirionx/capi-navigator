import { z } from 'zod';
import { ROLES, type Role } from './auth.js';

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
    if (b.connections && scope.connection && !b.connections.includes(scope.connection))
      return false;
    if (b.namespaces && scope.namespace && !b.namespaces.includes(scope.namespace)) return false;
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
  if (spec.bindings && spec.bindings.length > 0) return spec.bindings;
  return spec.role ? [{ role: spec.role }] : [];
}
