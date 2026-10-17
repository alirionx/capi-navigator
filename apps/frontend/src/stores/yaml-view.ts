import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ResourceRef } from '@capi-navigator/shared';

/** Opens the global read-only YAML dialog for any resource (FP7-F-01). */
export const useYamlViewStore = defineStore('yamlView', () => {
  const target = ref<ResourceRef | null>(null);
  const open = ref(false);

  function show(ref: ResourceRef): void {
    target.value = ref;
    open.value = true;
  }

  return { target, open, show };
});
