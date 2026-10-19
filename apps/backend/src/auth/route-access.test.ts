import { describe, expect, it } from 'vitest';
import {
  allows,
  BUILTIN_ROLES,
  hasRole,
  ROLES,
  type Role,
  type RolePermissions,
} from '@capi-navigator/shared';
import { listRoutes } from '../testing/routes.js';
import baseline from './route-access.baseline.json' with { type: 'json' };
import { PERMISSION_KEY, PUBLIC_KEY, type PermissionRule } from './decorators.js';

const builtin: RolePermissions = (r) => BUILTIN_ROLES[r as Role]?.permissions;
const meta = <T>(key: string, ...targets: object[]): T | undefined =>
  targets.map((t) => Reflect.getMetadata(key, t) as T | undefined).find((v) => v !== undefined);

/**
 * FP19-F-01: the built-in roles keep exactly the access of FP-1. The baseline holds the minimum
 * role of every endpoint before FP-19 ("public" for endpoints without session).
 */
describe('endpoint permissions (FP19-F-01, FP19-F-05)', async () => {
  const routes = await listRoutes();
  // Endpoints added since: the built-in roles get the access stated here.
  const added: Record<string, Role | 'public'> = {
    'GET /api/openapi.json': 'public',
    'GET /api/users/:username/tokens': 'admin',
    'POST /api/users/:username/tokens': 'admin',
    'DELETE /api/users/:username/tokens/:id': 'admin',
    'GET /api/roles': 'admin',
    'POST /api/roles': 'admin',
    'PATCH /api/roles/:name': 'admin',
    'DELETE /api/roles/:name': 'admin',
  };
  const expected = { ...(baseline as Record<string, string>), ...added };

  it('covers every endpoint, and every endpoint has an access rule', () => {
    expect(routes.map((r) => r.route).sort()).toEqual(Object.keys(expected).sort());
    for (const r of routes) {
      const rule = meta<PermissionRule>(PERMISSION_KEY, r.handler, r.controller);
      const isPublic = meta<boolean>(PUBLIC_KEY, r.handler, r.controller);
      expect(isPublic || rule, `${r.route} has no access rule`).toBeTruthy();
    }
  });

  it.each(ROLES)('gives the built-in role %s exactly its FP-1 access', (role) => {
    const differences: string[] = [];
    for (const r of routes) {
      const before = expected[r.route]!;
      if (before === 'public') {
        if (!meta<boolean>(PUBLIC_KEY, r.handler, r.controller))
          differences.push(`${r.route}: no longer public`);
        continue;
      }
      const rule = meta<PermissionRule>(PERMISSION_KEY, r.handler, r.controller)!;
      const now =
        rule.signedIn === true ||
        rule.anyOf.some((p) => allows([{ role }], builtin, p, { connection: 'c', namespace: 'n' }));
      if (now !== hasRole(role, before as Role)) {
        differences.push(`${r.route}: was ${before}, now ${now ? 'allowed' : 'denied'}`);
      }
    }
    expect(differences).toEqual([]);
  });

  it('takes the namespace of create requests from the body', () => {
    const create = routes.find((r) => r.route === 'POST /api/connections/:connection/clusters')!;
    expect(meta<PermissionRule>(PERMISSION_KEY, create.handler)).toEqual({
      anyOf: ['clusters.create'],
      namespaceFromBody: 'spec.namespace',
    });
  });
});
