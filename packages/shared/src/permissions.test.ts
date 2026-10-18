import { describe, expect, it } from 'vitest';
import {
  allows,
  BUILTIN_ROLES,
  bindingProblems,
  isBuiltinRole,
  PERMISSION_GROUPS,
  PERMISSIONS,
  userBindings,
  type Permission,
  type RolePermissions,
} from './permissions.js';

const roles: RolePermissions = (name) =>
  isBuiltinRole(name)
    ? BUILTIN_ROLES[name].permissions
    : (
        { day2: ['clusters.change'], platform: ['providers.manage'] } as Record<
          string,
          Permission[]
        >
      )[name];

describe('permissions (FP-19, ADR-0015)', () => {
  it('lists every permission in exactly one group (FP19-F-09)', () => {
    const grouped = PERMISSION_GROUPS.flatMap((g) => g.permissions);
    expect([...grouped].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('keeps the built-in roles nested: viewer ⊂ operator ⊂ admin (FP19-F-01)', () => {
    const { viewer, operator, admin } = BUILTIN_ROLES;
    expect(viewer.permissions.every((p) => operator.permissions.includes(p))).toBe(true);
    expect(operator.permissions.every((p) => admin.permissions.includes(p))).toBe(true);
    expect(admin.permissions).toEqual(PERMISSIONS);
  });

  it('grants unlimited assignments everywhere', () => {
    const op = [{ role: 'operator' }];
    expect(allows(op, roles, 'clusters.delete', { connection: 'home', namespace: 'x' })).toBe(true);
    expect(allows(op, roles, 'providers.manage', { connection: 'home' })).toBe(false);
    expect(allows([{ role: 'admin' }], roles, 'users.manage')).toBe(true);
  });

  it('limits scopable permissions to connections and namespaces (FP19-F-03)', () => {
    const teamA = [{ role: 'operator', connections: ['home'], namespaces: ['team-a'] }];
    expect(
      allows(teamA, roles, 'clusters.change', { connection: 'home', namespace: 'team-a' }),
    ).toBe(true);
    expect(
      allows(teamA, roles, 'clusters.change', { connection: 'home', namespace: 'team-b' }),
    ).toBe(false);
    expect(allows(teamA, roles, 'nodes.shell', { connection: 'aws', namespace: 'team-a' })).toBe(
      false,
    );
    // Endpoints of a connection without namespace (e.g. cloud lookups): any namespace there.
    expect(allows(teamA, roles, 'clusters.create', { connection: 'home' })).toBe(true);
    expect(allows(teamA, roles, 'clusters.create', { connection: 'aws' })).toBe(false);
    // An empty or forged namespace never counts as "somewhere".
    expect(allows(teamA, roles, 'clusters.create', { connection: 'home', namespace: '' })).toBe(
      false,
    );
    // Endpoints without connection (e.g. chart browsing).
    expect(allows(teamA, roles, 'addons.manage')).toBe(true);
  });

  it('never grants platform permissions from limited assignments', () => {
    const limitedAdmin = [{ role: 'admin', namespaces: ['team-a'] }];
    expect(allows(limitedAdmin, roles, 'users.manage')).toBe(false);
    expect(allows(limitedAdmin, roles, 'clusters.delete', { namespace: 'team-a' })).toBe(true);
    expect(bindingProblems(limitedAdmin, roles)).toEqual([
      expect.stringMatching(/Role "admin" contains presets.manage, .*users.manage, which can only/),
    ]);
    expect(bindingProblems([{ role: 'platform', connections: ['home'] }], roles)).toHaveLength(1);
    expect(bindingProblems([{ role: 'operator', namespaces: ['team-a'] }], roles)).toEqual([]);
  });

  it('lets every assignment read, everywhere (FP19-F-04)', () => {
    const teamA = [{ role: 'day2', connections: ['home'], namespaces: ['team-a'] }];
    expect(allows(teamA, roles, 'view', { connection: 'aws', namespace: 'other' })).toBe(true);
    expect(
      allows(teamA, roles, 'clusters.delete', { connection: 'home', namespace: 'team-a' }),
    ).toBe(false);
  });

  it('combines several assignments', () => {
    const user = [{ role: 'viewer' }, { role: 'operator', namespaces: ['team-a', 'team-b'] }];
    expect(allows(user, roles, 'clusters.create', { connection: 'x', namespace: 'team-b' })).toBe(
      true,
    );
    expect(allows(user, roles, 'clusters.create', { connection: 'x', namespace: 'prod' })).toBe(
      false,
    );
  });

  it('grants nothing for unknown roles or no assignments', () => {
    expect(allows([{ role: 'deleted-role' }], roles, 'view')).toBe(false);
    expect(allows([], roles, 'view')).toBe(false);
    expect(bindingProblems([{ role: 'deleted-role' }], roles)).toEqual([
      'Role "deleted-role" does not exist',
    ]);
  });

  it('reads users from before FP-19 as one unlimited assignment (FP19-F-07)', () => {
    expect(userBindings({ role: 'operator' })).toEqual([{ role: 'operator' }]);
    expect(userBindings({ role: 'admin', bindings: [{ role: 'viewer' }] })).toEqual([
      { role: 'viewer' },
    ]);
    expect(userBindings({})).toEqual([]);
    // Removing every assignment must not bring the legacy role back.
    expect(userBindings({ role: 'admin', bindings: [] })).toEqual([]);
  });
});
