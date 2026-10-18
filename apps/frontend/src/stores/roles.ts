import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  RoleInfoListSchema,
  RoleInfoSchema,
  type CreateRoleRequest,
  type RoleInfo,
  type UpdateRoleRequest,
} from '@capi-navigator/shared';
import { api, apiVoid } from '../api/client.js';

/** Roles page and role assignments (FP19-F-09); needs users.manage. */
export const useRolesStore = defineStore('roles', () => {
  const roles = ref<RoleInfo[]>([]);
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      roles.value = await api('GET', '/api/roles', RoleInfoListSchema);
    } finally {
      loading.value = false;
    }
  }

  async function create(req: CreateRoleRequest): Promise<void> {
    await api('POST', '/api/roles', RoleInfoSchema, req);
    await load();
  }

  async function update(name: string, req: UpdateRoleRequest): Promise<void> {
    await api('PATCH', `/api/roles/${encodeURIComponent(name)}`, RoleInfoSchema, req);
    await load();
  }

  async function remove(name: string): Promise<void> {
    await apiVoid('DELETE', `/api/roles/${encodeURIComponent(name)}`);
    await load();
  }

  return { roles, loading, load, create, update, remove };
});
