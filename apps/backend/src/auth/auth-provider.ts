import type { Principal } from './principal.js';

/**
 * Pluggable authentication (FP1-F-08). FP-1 ships local users; OIDC (FP-14) can add another
 * provider without touching the guard, which only works with sessions and principals.
 */
export interface AuthProvider {
  readonly id: string;
  /** Returns the principal for valid credentials, or undefined. */
  authenticate(credentials: { username: string; password: string }): Promise<Principal | undefined>;
}

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');
