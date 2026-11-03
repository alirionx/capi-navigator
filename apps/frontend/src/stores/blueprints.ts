import { defineStore } from 'pinia';
import { ref } from 'vue';
import { z } from 'zod';
import {
  ClusterBlueprintSchema,
  ClusterListSchema,
  ClusterPreviewSchema,
  type BlueprintSaveRequest,
  type ClusterBlueprint,
  type ClusterBlueprintSpecInput,
} from '@capi-navigator/shared';
import { api, apiVoid } from '../api/client.js';

const base = '/api/blueprints';
const item = (name: string) => `${base}/${encodeURIComponent(name)}`;

/** Cluster blueprints (FP-34): reviewed cluster specs with a few parameters. */
export const useBlueprintsStore = defineStore('blueprints', () => {
  const blueprints = ref<ClusterBlueprint[]>([]);
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      blueprints.value = await api('GET', base, z.array(ClusterBlueprintSchema));
    } finally {
      loading.value = false;
    }
  }

  function replace(b: ClusterBlueprint): void {
    const idx = blueprints.value.findIndex((x) => x.name === b.name);
    if (idx >= 0) blueprints.value.splice(idx, 1, b);
    else blueprints.value.push(b);
  }

  /** FP34-F-04: YAML, dry run and blockers of the base spec before saving. */
  const preview = (req: BlueprintSaveRequest) =>
    api('POST', `${base}/preview`, ClusterPreviewSchema, req);

  async function create(req: BlueprintSaveRequest): Promise<ClusterBlueprint> {
    const b = await api('POST', base, ClusterBlueprintSchema, req);
    replace(b);
    return b;
  }

  async function update(name: string, spec: ClusterBlueprintSpecInput): Promise<ClusterBlueprint> {
    const b = await api('PUT', item(name), ClusterBlueprintSchema, { spec });
    replace(b);
    return b;
  }

  async function remove(name: string): Promise<void> {
    await apiVoid('DELETE', item(name));
    blueprints.value = blueprints.value.filter((b) => b.name !== name);
  }

  const clusters = (name: string) => api('GET', `${item(name)}/clusters`, ClusterListSchema);

  return { blueprints, loading, load, preview, create, update, remove, clusters };
});
