import { defineStore } from 'pinia';
import { ref } from 'vue';
import { z } from 'zod';
import {
  AddonPresetViewSchema,
  AddonPreviewSchema,
  ChartSummarySchema,
  ChartValuesSchema,
  ChartVersionSchema,
  HelmRepositorySchema,
  HelmRepositoryTestResultSchema,
  type AddonPresetOverride,
  type CreateHelmRepositoryRequest,
  type HelmRepository,
  type UpdateHelmRepositoryRequest,
} from '@capi-navigator/shared';
import { api, apiVoid } from '../api/client.js';

const base = '/api/helm-repositories';
const item = (name: string) => `${base}/${encodeURIComponent(name)}`;

/** Helm repositories and the chart browser (FP8-F-02 to F-04), plus the presets (FP8-F-14). */
export const useHelmRepositoriesStore = defineStore('helm-repositories', () => {
  const repositories = ref<HelmRepository[]>([]);
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      repositories.value = await api('GET', base, z.array(HelmRepositorySchema));
    } finally {
      loading.value = false;
    }
  }

  function replace(r: HelmRepository): void {
    const idx = repositories.value.findIndex((x) => x.name === r.name);
    if (idx >= 0) repositories.value.splice(idx, 1, r);
    else repositories.value.push(r);
  }

  async function create(req: CreateHelmRepositoryRequest): Promise<HelmRepository> {
    const r = await api('POST', base, HelmRepositorySchema, req);
    replace(r);
    return r;
  }

  async function update(name: string, req: UpdateHelmRepositoryRequest): Promise<HelmRepository> {
    const r = await api('PATCH', item(name), HelmRepositorySchema, req);
    replace(r);
    return r;
  }

  async function remove(name: string): Promise<void> {
    await apiVoid('DELETE', item(name));
    repositories.value = repositories.value.filter((r) => r.name !== name);
  }

  const test = (name: string) => api('POST', `${item(name)}/test`, HelmRepositoryTestResultSchema);
  const testDraft = (req: CreateHelmRepositoryRequest) =>
    api('POST', `${base}/test`, HelmRepositoryTestResultSchema, req);
  const charts = (name: string) => api('GET', `${item(name)}/charts`, z.array(ChartSummarySchema));
  const versions = (name: string, chart: string) =>
    api(
      'GET',
      `${item(name)}/versions?chart=${encodeURIComponent(chart)}`,
      z.array(ChartVersionSchema),
    );
  const values = (name: string, chart: string, version: string) =>
    api(
      'GET',
      `${item(name)}/values?chart=${encodeURIComponent(chart)}&version=${encodeURIComponent(version)}`,
      ChartValuesSchema,
    );

  const presetsPath = (connection: string) =>
    `/api/connections/${encodeURIComponent(connection)}/addon-presets`;
  const presets = (connection: string) =>
    api('GET', presetsPath(connection), z.array(AddonPresetViewSchema));
  const setPresetOverride = (id: string, override: AddonPresetOverride | null) =>
    apiVoid('PUT', `/api/addon-presets/${encodeURIComponent(id)}`, { override });
  const presetRolloutPreview = (connection: string, id: string) =>
    api('POST', `${presetsPath(connection)}/${id}/rollout/preview`, AddonPreviewSchema);
  const presetRollout = (connection: string, id: string) =>
    api('POST', `${presetsPath(connection)}/${id}/rollout`, AddonPreviewSchema);

  return {
    repositories,
    loading,
    load,
    create,
    update,
    remove,
    test,
    testDraft,
    charts,
    versions,
    values,
    presets,
    setPresetOverride,
    presetRolloutPreview,
    presetRollout,
  };
});
