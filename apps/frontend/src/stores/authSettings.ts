import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  AuthSettingsSchema,
  OidcTestResultSchema,
  type AuthSettings,
  type OidcTestResult,
  type UpdateOidcSettingsRequest,
} from '@capi-navigator/shared';
import { api } from '../api/client.js';

/** Authentication page (FP14-F-12, ADR-0020); needs users.manage. */
export const useAuthSettingsStore = defineStore('authSettings', () => {
  const settings = ref<AuthSettings | null>(null);
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      settings.value = await api('GET', '/api/auth-settings', AuthSettingsSchema);
    } finally {
      loading.value = false;
    }
  }

  async function save(req: UpdateOidcSettingsRequest): Promise<void> {
    settings.value = await api('PUT', '/api/auth-settings/oidc', AuthSettingsSchema, req);
  }

  function test(issuerUrl: string): Promise<OidcTestResult> {
    return api('POST', '/api/auth-settings/oidc/test', OidcTestResultSchema, { issuerUrl });
  }

  return { settings, loading, load, save, test };
});
