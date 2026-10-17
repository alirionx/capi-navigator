import { createPinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from './index.js';

function mockMe(status: number, body?: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        body ? JSON.stringify(body) : JSON.stringify({ statusCode: status, message: 'x' }),
        {
          status,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    ),
  );
}

describe('router guards (FP1-F-07)', () => {
  let pinia: Pinia;
  beforeEach(() => {
    pinia = createPinia();
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends signed-out users to the login page and remembers the target', async () => {
    mockMe(401);
    const router = createAppRouter(pinia);
    await router.push('/users');
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect).toBe('/users');
  });

  it('forces the password change before anything else', async () => {
    mockMe(200, { username: 'admin', role: 'admin', mustChangePassword: true });
    const router = createAppRouter(pinia);
    await router.push('/users');
    expect(router.currentRoute.value.name).toBe('change-password');
  });

  it('keeps viewers out of admin routes', async () => {
    mockMe(200, { username: 'vera', role: 'viewer', mustChangePassword: false });
    const router = createAppRouter(pinia);
    await router.push('/users');
    expect(router.currentRoute.value.name).toBe('home');
  });

  it('lets admins open the user management', async () => {
    mockMe(200, { username: 'admin', role: 'admin', mustChangePassword: false });
    const router = createAppRouter(pinia);
    await router.push('/users');
    expect(router.currentRoute.value.name).toBe('users');
  });

  it('redirects signed-in users away from the login page', async () => {
    mockMe(200, { username: 'otto', role: 'operator', mustChangePassword: false });
    const router = createAppRouter(pinia);
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('home');
  });
});
