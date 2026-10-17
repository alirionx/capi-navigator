<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ResourceYamlSchema } from '@capi-navigator/shared';
import { liveStream } from '../api/live.js';
import { useConnectionsStore } from '../stores/connections.js';
import { useYamlViewStore } from '../stores/yaml-view.js';
import YamlViewer from './YamlViewer.vue';

/**
 * Global read-only YAML view (FP7-F-01 to F-05): live via watch, managed fields hidden by
 * default, Secret values never shown, copy and download; no editing (hard rule 4).
 */
const { t } = useI18n();
const store = useYamlViewStore();
const connections = useConnectionsStore();

const yaml = ref('');
const masked = ref(false);
const error = ref<string | null>(null);
const live = ref(false);
const managedFields = ref(false);
let stop: (() => void) | null = null;

const title = computed(() => {
  const r = store.target;
  return r ? `${r.kind} ${r.namespace ? `${r.namespace}/` : ''}${r.name}` : '';
});

function connect(): void {
  stop?.();
  stop = null;
  yaml.value = '';
  error.value = null;
  const r = store.target;
  if (!store.open || !r || !connections.activeName) return;
  const q = new URLSearchParams({
    apiVersion: r.apiVersion,
    kind: r.kind,
    name: r.name,
    managedFields: String(managedFields.value),
    ...(r.namespace ? { namespace: r.namespace } : {}),
    ...(r.cluster ? { clusterNamespace: r.cluster.namespace, clusterName: r.cluster.name } : {}),
  });
  stop = liveStream(
    `/api/connections/${encodeURIComponent(connections.activeName)}/resources/yaml/events?${q}`,
    ResourceYamlSchema,
    {
      state: (s) => {
        yaml.value = s.yaml;
        masked.value = s.masked;
        error.value = null;
      },
      error: (m) => (error.value = m),
      live: (on) => (live.value = on),
    },
  );
}

watch(() => [store.open, store.target, managedFields.value] as const, connect);
onBeforeUnmount(() => stop?.());
watch(
  () => store.open,
  (o) => {
    if (!o) {
      stop?.();
      stop = null;
      managedFields.value = false;
    }
  },
);
const filename = computed(() =>
  store.target ? `${store.target.kind.toLowerCase()}-${store.target.name}.yaml` : 'resource.yaml',
);
</script>

<template>
  <v-dialog v-model="store.open" max-width="1100" scrollable>
    <v-card data-testid="yaml-dialog">
      <v-card-item>
        <template #prepend><v-icon icon="mdi-code-braces" color="primary" /></template>
        <v-card-title class="text-truncate">{{ title }}</v-card-title>
        <v-card-subtitle>
          {{ store.target?.apiVersion }}
          <template v-if="store.target?.cluster">
            · {{ t('yamlView.inCluster', { name: store.target.cluster.name }) }}
          </template>
        </v-card-subtitle>
        <template #append>
          <v-chip size="small" variant="tonal" class="mr-2">{{ t('yamlView.readOnly') }}</v-chip>
          <v-chip
            size="small"
            variant="tonal"
            :color="live ? 'success' : 'grey'"
            prepend-icon="mdi-access-point"
            >{{ live ? t('providers.live') : t('providers.connecting') }}</v-chip
          >
        </template>
      </v-card-item>
      <v-card-text>
        <div class="d-flex align-center flex-wrap ga-3 mb-2">
          <v-switch
            v-model="managedFields"
            :label="t('yamlView.managedFields')"
            hide-details
            data-testid="yaml-managed-fields"
          />
          <v-alert
            v-if="masked"
            type="info"
            variant="tonal"
            density="compact"
            class="flex-grow-1"
            >{{ t('yamlView.masked') }}</v-alert
          >
        </div>
        <v-alert v-if="error" type="error" variant="tonal" class="mb-2">{{ error }}</v-alert>
        <v-progress-linear v-if="!yaml && !error" indeterminate />
        <YamlViewer v-if="yaml" :value="yaml" height="60vh" :filename="filename" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="store.open = false">{{ t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
