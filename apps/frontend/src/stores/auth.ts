import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  hasRole,
  MeSchema,
  type ChangePasswordRequest,
  type LoginRequest,
  type Me,
  type Role,
} from '@capi-navigator/shared';
import { api, ApiError, apiVoid } from '../api/client.js';

export const useAuthStore = defineStore('auth', () => {
  const me = ref<Me | null>(null);
  /** True once the session state has been checked at least once. */
  const checked = ref(false);

  const signedIn = computed(() => me.value !== null);

  /** Role check for showing and hiding controls; enforcement happens in the backend (FP1-F-07). */
  function can(role: Role): boolean {
    return me.value !== null && !me.value.mustChangePassword && hasRole(me.value.role, role);
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

  async function logout(): Promise<void> {
    try {
      await apiVoid('POST', '/api/auth/logout');
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

  return { me, checked, signedIn, can, fetchMe, login, logout, changePassword, clear };
});
