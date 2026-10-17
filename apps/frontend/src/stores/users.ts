import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  UserListSchema,
  UserSchema,
  type CreateUserRequest,
  type UpdateUserRequest,
  type User,
} from '@capi-navigator/shared';
import { api, apiVoid } from '../api/client.js';

/** User management for admins (FP1-F-05). */
export const useUsersStore = defineStore('users', () => {
  const users = ref<User[]>([]);
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      users.value = await api('GET', '/api/users', UserListSchema);
    } finally {
      loading.value = false;
    }
  }

  async function create(req: CreateUserRequest): Promise<void> {
    await api('POST', '/api/users', UserSchema, req);
    await load();
  }

  async function update(username: string, req: UpdateUserRequest): Promise<void> {
    await api('PATCH', `/api/users/${encodeURIComponent(username)}`, UserSchema, req);
    await load();
  }

  async function remove(username: string): Promise<void> {
    await apiVoid('DELETE', `/api/users/${encodeURIComponent(username)}`);
    await load();
  }

  async function resetPassword(username: string, password: string): Promise<void> {
    await api('POST', `/api/users/${encodeURIComponent(username)}/reset-password`, UserSchema, {
      password,
    });
    await load();
  }

  return { users, loading, load, create, update, remove, resetPassword };
});
