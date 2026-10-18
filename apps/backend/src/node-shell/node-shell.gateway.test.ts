import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, isBuiltinRole, type RoleBinding } from '@capi-navigator/shared';
import { checkUpgrade as check, parseShellRoute, type ShellRoute } from './node-shell.gateway.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
const user = (role: 'viewer' | 'operator' | 'admin', mustChangePassword = false) => ({
  username: 'u',
  bindings: [{ role }] as RoleBinding[],
  mustChangePassword,
});
const roles = (r: string) => (isBuiltinRole(r) ? BUILTIN_ROLES[r].permissions : undefined);
const checkUpgrade = (r: IncomingMessage, p: Parameters<typeof check>[1], route: ShellRoute) =>
  check(r, p, route, roles);

describe('node shell upgrade (FP-17, ADR-0008)', () => {
  it('parses workload and management routes with their permission and scope', () => {
    expect(
      parseShellRoute('/api/connections/home/clusters/team-a/demo/nodes/ip-10-0-1-2/shell'),
    ).toEqual({
      target: {
        kind: 'workload',
        connection: 'home',
        namespace: 'team-a',
        cluster: 'demo',
        node: 'ip-10-0-1-2',
      },
      permission: 'nodes.shell',
      scope: { connection: 'home', namespace: 'team-a' },
    });
    expect(parseShellRoute('/api/connections/home/nodes/kind-cp/shell')).toEqual({
      target: { kind: 'management', connection: 'home', node: 'kind-cp' },
      permission: 'managementNodes.shell',
      scope: { connection: 'home' },
    });
    expect(parseShellRoute('/api/connections/home/nodes')).toBeUndefined();
  });

  it('requires the same origin, a session and the permission', () => {
    const workload = parseShellRoute('/api/connections/h/clusters/n/c/nodes/x/shell')!;
    const mgmt = parseShellRoute('/api/connections/h/nodes/x/shell')!;
    const same = req({ origin: 'http://app:3000', host: 'app:3000' });
    expect(checkUpgrade(same, user('operator'), workload)).toBeUndefined();
    expect(checkUpgrade(req({ host: 'app:3000' }), user('admin'), workload)).toBe(403);
    expect(
      checkUpgrade(req({ origin: 'http://evil', host: 'app:3000' }), user('admin'), workload),
    ).toBe(403);
    expect(checkUpgrade(same, undefined, workload)).toBe(401);
    expect(checkUpgrade(same, user('viewer'), workload)).toBe(403);
    expect(checkUpgrade(same, user('operator'), mgmt)).toBe(403);
    expect(checkUpgrade(same, user('admin'), mgmt)).toBeUndefined();
    expect(checkUpgrade(same, user('admin', true), mgmt)).toBe(403);
  });

  it('refuses workload shells outside the namespaces of the assignment (FP19-F-05)', () => {
    const same = req({ origin: 'http://app:3000', host: 'app:3000' });
    const teamA = {
      username: 'u',
      bindings: [{ role: 'operator', connections: ['h'], namespaces: ['team-a'] }],
      mustChangePassword: false,
    };
    const inTeam = parseShellRoute('/api/connections/h/clusters/team-a/c/nodes/x/shell')!;
    const other = parseShellRoute('/api/connections/h/clusters/team-b/c/nodes/x/shell')!;
    const mgmt = parseShellRoute('/api/connections/h/nodes/x/shell')!;
    expect(checkUpgrade(same, teamA, inTeam)).toBeUndefined();
    expect(checkUpgrade(same, teamA, other)).toBe(403);
    expect(checkUpgrade(same, teamA, mgmt)).toBe(403);
  });
});
