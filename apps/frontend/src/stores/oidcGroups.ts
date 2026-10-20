import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  AuthOptionsSchema,
  GroupMappingListSchema,
  GroupMappingSchema,
  type CreateGroupMappingRequest,
  type GroupMapping,
  type UpdateGroupMappingRequest,
} from '@capi-navigator/shared';
import { api, apiVoid, getJson } from '../api/client.js';

/** Mappings of OpenID Connect groups to role assignments (FP14-F-04); needs users.manage. */
export const useOidcGroupsStore = defineStore('oidcGroups', () => {
  const mappings = ref<GroupMapping[]>([]);
  const loading = ref(false);
  /** Whether sign-in with an OpenID Connect provider is configured at all. */
  const oidcEnabled = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const [list, options] = await Promise.all([
        api('GET', '/api/oidc-groups', GroupMappingListSchema),
        getJson('/api/auth/options', AuthOptionsSchema),
      ]);
      mappings.value = list;
      oidcEnabled.value = options.oidc !== null;
    } finally {
      loading.value = false;
    }
  }

  async function create(req: CreateGroupMappingRequest): Promise<void> {
    await api('POST', '/api/oidc-groups', GroupMappingSchema, req);
    await load();
  }

  async function update(name: string, req: UpdateGroupMappingRequest): Promise<void> {
    await api('PATCH', `/api/oidc-groups/${encodeURIComponent(name)}`, GroupMappingSchema, req);
    await load();
  }

  async function remove(name: string): Promise<void> {
    await apiVoid('DELETE', `/api/oidc-groups/${encodeURIComponent(name)}`);
    await load();
  }

  return { mappings, loading, oidcEnabled, load, create, update, remove };
});
