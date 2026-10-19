import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  CreatedTokenSchema,
  TokenInfoListSchema,
  type CreatedToken,
  type CreateTokenRequest,
  type TokenInfo,
} from '@capi-navigator/shared';
import { api, apiVoid } from '../api/client.js';

const base = (username: string) => `/api/users/${encodeURIComponent(username)}/tokens`;

/** API tokens of technical users (FP22-F-02); needs users.manage. */
export const useTokensStore = defineStore('tokens', () => {
  const tokens = ref<TokenInfo[]>([]);
  const loading = ref(false);

  async function load(username: string): Promise<void> {
    loading.value = true;
    try {
      tokens.value = await api('GET', base(username), TokenInfoListSchema);
    } finally {
      loading.value = false;
    }
  }

  /** The only time the token value comes back; the caller shows it once and drops it. */
  async function create(username: string, req: CreateTokenRequest): Promise<CreatedToken> {
    const created = await api('POST', base(username), CreatedTokenSchema, req);
    await load(username);
    return created;
  }

  async function revoke(username: string, id: string): Promise<void> {
    await apiVoid('DELETE', `${base(username)}/${encodeURIComponent(id)}`);
    await load(username);
  }

  return { tokens, loading, load, create, revoke };
});
