import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NAMESPACE_USER_ROLE, ROLES } from '@capi-navigator/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.js';
import { checkUpgrade, parseShellRoute } from '../node-shell/node-shell.gateway.js';
import type { StoreService } from '../store/store.service.js';
import { createFakeStore } from '../testing/fake-store.js';
import { listRoutes } from '../testing/routes.js';
import { AuthGuard } from './auth.guard.js';
import type { Principal } from './principal.js';
import type { SessionService } from './session.service.js';

/** Everything a namespace user reaches besides the public endpoints (FP37-F-01, ADR-0041). */
const ALLOWED = ['GET /api/auth/me', 'POST /api/auth/change-password'];

const PUBLIC = [
  'GET /api/auth/oidc/callback',
  'GET /api/auth/oidc/login',
  'GET /api/auth/options',
  'GET /api/health',
  'GET /api/openapi.json',
  'GET /healthz',
  'GET /readyz',
  'POST /api/auth/login',
  'POST /api/auth/logout',
];

describe('access of namespace users (FP37-F-01)', async () => {
  const routes = await listRoutes();
  const store = createFakeStore() as unknown as { store?: StoreService } & StoreService;
  const principal = (role: string): Principal => ({
    username: 'u',
    bindings: [{ role }],
    mustChangePassword: false,
  });

  /** The answer of the real guard for every endpoint and live stream. */
  const reachable = (p: Principal | undefined) => {
    const guard = new AuthGuard(
      new Reflector(),
      { authenticate: () => p } as unknown as SessionService,
      (store.store ?? store) as StoreService,
      loadConfig({ LOG_JSON: 'false' }),
    );
    return routes
      .filter((r) => {
        const req = {
          method: 'GET',
          path: r.route,
          headers: {},
          body: {},
          params: { connection: 'c', namespace: 'n' },
          ip: '10.0.0.1',
        };
        const ctx = {
          getType: () => 'http',
          getHandler: () => r.handler,
          getClass: () => r.controller,
          switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
        } as unknown as ExecutionContext;
        try {
          return guard.canActivate(ctx);
        } catch (err) {
          const status = (err as { getStatus?: () => number }).getStatus?.();
          // Creating from a blueprint looks the blueprint up first; unknown names answer 404.
          if (status === 404 || status === 403 || status === 401) return false;
          throw err;
        }
      })
      .map((r) => r.route)
      .sort();
  };

  it('reaches the own account and nothing else, over all endpoints and live streams', () => {
    expect(reachable(principal(NAMESPACE_USER_ROLE))).toEqual([...PUBLIC, ...ALLOWED].sort());
  });

  it('covers the live streams', () => {
    const streams = routes.filter((r) => r.route.endsWith('/events'));
    expect(streams.length).toBeGreaterThanOrEqual(5);
    const open = reachable(principal(NAMESPACE_USER_ROLE));
    expect(streams.filter((r) => open.includes(r.route))).toEqual([]);
  });

  it('differs from every other built-in role, which can read', () => {
    for (const role of ROLES) {
      expect(reachable(principal(role)), role).toContain('GET /api/connections');
    }
    expect(reachable(undefined)).toEqual(PUBLIC);
  });

  it('is refused at the node shell', () => {
    const req = { headers: { origin: 'http://a', host: 'a' } } as never;
    for (const path of [
      '/api/connections/h/clusters/n/c/nodes/x/shell',
      '/api/connections/h/nodes/x/shell',
    ]) {
      expect(
        checkUpgrade(req, principal(NAMESPACE_USER_ROLE), parseShellRoute(path)!, () => []),
      ).toBe(403);
    }
  });
});
