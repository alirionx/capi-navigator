import { defineStore } from 'pinia';
import { ref } from 'vue';
import { HealthResponseSchema, type HealthResponse } from '@capi-navigator/shared';
import { getJson } from '../api/client.js';

export const useHealthStore = defineStore('health', () => {
  const health = ref<HealthResponse | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      health.value = await getJson('/api/health', HealthResponseSchema);
    } catch (err) {
      health.value = null;
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  return { health, loading, error, load };
});
