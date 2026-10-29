<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { MANIFEST_CHART_DEFAULT_URL, type ManifestChartStatus } from '@capi-navigator/shared';
import ErrorAlert from '../ErrorAlert.vue';
import ManifestChartAlert from './ManifestChartAlert.vue';
import { useAddonsStore } from '../../stores/addons.js';
import { useAuthStore } from '../../stores/auth.js';
import { useConnectionsStore } from '../../stores/connections.js';
import { useHelmRepositoriesStore } from '../../stores/helm-repositories.js';
import FieldHelp from '../FieldHelp.vue';

/**
 * Chart source of the manifest add-ons of one connection (FP30-F-02, FP30-F-03): the chart on
 * ghcr.io by default, or a Helm repository of the app (a mirror); admins change it.
 */
const props = defineProps<{ connection: string }>();
const { t } = useI18n();
const addons = useAddonsStore();
const auth = useAuthStore();
const connections = useConnectionsStore();
const repos = useHelmRepositoriesStore();
const isAdmin = computed(() => auth.can('connections.manage'));

const status = ref<ManifestChartStatus | null>(null);
const error = ref<unknown>(null);
async function load(): Promise<void> {
  error.value = null;
  try {
    status.value = await addons.manifestChart(props.connection);
  } catch (err) {
    error.value = err;
  }
}
watch(() => props.connection, load, { immediate: true });

const DEFAULT = '';
const editOpen = ref(false);
const source = ref(DEFAULT);
const saving = ref(false);
const saveError = ref<unknown>(null);
const sources = computed(() => [
  {
    title: t('manifestAddons.defaultSource'),
    value: DEFAULT,
    subtitle: MANIFEST_CHART_DEFAULT_URL,
  },
  ...repos.repositories.map((r) => ({ title: r.name, value: r.name, subtitle: r.url })),
]);
function edit(): void {
  source.value = status.value?.repository ?? DEFAULT;
  saveError.value = null;
  if (!repos.repositories.length) void repos.load().catch(() => undefined);
  editOpen.value = true;
}
async function save(): Promise<void> {
  saving.value = true;
  saveError.value = null;
  try {
    await connections.update(props.connection, { manifestChartRepository: source.value || null });
    editOpen.value = false;
    await load();
  } catch (err) {
    saveError.value = err;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-card border class="mb-6" data-testid="manifest-chart-panel">
    <v-card-item>
      <v-card-title class="text-body-large">{{ t('manifestAddons.chartTitle') }}</v-card-title>
      <v-card-subtitle>{{ t('manifestAddons.chartSubtitle') }}</v-card-subtitle>
      <template #append>
        <v-btn
          v-if="isAdmin"
          size="small"
          variant="text"
          prepend-icon="mdi-pencil"
          data-testid="edit-manifest-chart-source"
          @click="edit"
          >{{ t('manifestAddons.changeSource') }}</v-btn
        >
      </template>
    </v-card-item>
    <v-card-text>
      <ManifestChartAlert :status="status" :error="error" />
    </v-card-text>
  </v-card>

  <v-dialog v-model="editOpen" max-width="640">
    <v-card :title="t('manifestAddons.sourceTitle')">
      <v-card-text>
        <p class="text-body-medium mb-3">{{ t('manifestAddons.sourceInfo') }}</p>
        <v-select
          v-model="source"
          :items="sources"
          :label="t('manifestAddons.source')"
          data-testid="manifest-chart-source"
        >
          <template #append-inner>
            <FieldHelp :text="t('manifestAddons.sourceHint')" />
          </template>
          <template #item="{ props: p, internalItem: item }">
            <v-list-item v-bind="p" :subtitle="item.raw.subtitle" />
          </template>
        </v-select>
        <div v-if="status" class="text-body-small mt-4">
          {{ t('manifestAddons.mirrorCommands') }}
        </div>
        <pre v-if="status" class="text-body-small mt-1 mirror-commands">{{
          status.mirrorCommands
        }}</pre>
        <ErrorAlert v-if="saveError" :error="saveError" class="mt-3" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="editOpen = false">{{ t('common.cancel') }}</v-btn>
        <v-btn
          color="primary"
          :loading="saving"
          data-testid="save-manifest-chart-source"
          @click="save"
          >{{ t('common.save') }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.mirror-commands {
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
