import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  allows,
  isScopable,
  isUnlimited,
  LogoutResponseSchema,
  MeSchema,
  type ChangePasswordRequest,
  type LoginRequest,
  type Me,
  type Permission,
  type PermissionScope,
} from '@capi-navigator/shared';
import { api, ApiError } from '../api/client.js';

export const useAuthStore = defineStore('auth', () => {
  const me = ref<Me | null>(null);
  /** True once the session state has been checked at least once. */
  const checked = ref(false);

  const signedIn = computed(() => me.value !== null);

  /**
   * Permission check for showing and hiding controls (FP19-F-10); the same rule as the backend,
   * which enforces it. Without scope: the permission somewhere.
   */
  function can(permission: Permission, scope: PermissionScope = {}): boolean {
    const m = me.value;
    if (!m || m.mustChangePassword) return false;
    return allows(
      m.bindings,
      (role) => m.bindings.find((b) => b.role === role)?.permissions,
      permission,
      scope,
    );
  }

  /**
   * Namespaces of a connection where the user has a permission (FP19-F-10), e.g. for the
   * namespace field of the wizard: 'all' when an assignment is not limited to namespaces.
   */
  function namespacesFor(permission: Permission, connection: string): 'all' | string[] {
    const m = me.value;
    if (!m || m.mustChangePassword) return [];
    const result = new Set<string>();
    for (const b of m.bindings) {
      if (!b.permissions.includes(permission)) continue;
      if (isUnlimited(b)) return 'all';
      if (!isScopable(permission)) continue;
      if (b.connections && !b.connections.includes(connection)) continue;
      if (!b.namespaces) return 'all';
      b.namespaces.forEach((n) => result.add(n));
    }
    return [...result].sort();
  }

  async function fetchMe(): Promise<void> {
    try {
      me.value = await api('GET', '/api/auth/me', MeSchema);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      me.value = null;
    } finally {
      checked.value = true;
    }
  }

  async function login(credentials: LoginRequest): Promise<Me> {
    me.value = await api('POST', '/api/auth/login', MeSchema, credentials);
    checked.value = true;
    return me.value;
  }

  /** Signs out; for OIDC people the URL to sign out at the provider too (FP14-F-10). */
  async function logout(): Promise<string | undefined> {
    try {
      return (await api('POST', '/api/auth/logout', LogoutResponseSchema)).endSessionUrl;
    } finally {
      me.value = null;
    }
  }

  async function changePassword(req: ChangePasswordRequest): Promise<void> {
    me.value = await api('POST', '/api/auth/change-password', MeSchema, req);
  }

  /** Forget the session locally, e.g. after a 401 from the backend. */
  function clear(): void {
    me.value = null;
  }

  return {
    me,
    checked,
    signedIn,
    can,
    namespacesFor,
    fetchMe,
    login,
    logout,
    changePassword,
    clear,
  };
});
