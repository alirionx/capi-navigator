<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ClusterResourceListSchema, type ClusterResourceList } from '@capi-navigator/shared';
import { api } from '../api/client.js';
import ErrorAlert from './ErrorAlert.vue';
import YamlButton from './YamlButton.vue';

/** All objects of a cluster in the management cluster, each with live YAML (FP7-F-01). */
const props = defineProps<{ connection: string; namespace: string; name: string }>();
const { t } = useI18n();
const items = ref<ClusterResourceList>([]);
const loading = ref(false);
const error = ref<unknown>(null);
const search = ref('');

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    items.value = await api(
      'GET',
      `/api/connections/${encodeURIComponent(props.connection)}/clusters/${encodeURIComponent(props.namespace)}/${encodeURIComponent(props.name)}/resources`,
      ClusterResourceListSchema,
    );
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
}
watch(() => [props.connection, props.namespace, props.name], load, { immediate: true });

const shown = computed(() => {
  const q = search.value.trim().toLowerCase();
  return q
    ? items.value.filter((i) => `${i.kind} ${i.name}`.toLowerCase().includes(q))
    : items.value;
});
</script>

<template>
  <div data-testid="cluster-resources">
    <div class="d-flex align-center flex-wrap ga-3 mb-3">
      <span class="text-body-medium text-medium-emphasis">{{ t('yamlView.resourcesHint') }}</span>
      <v-spacer />
      <v-text-field
        v-model="search"
        prepend-inner-icon="mdi-magnify"
        :label="t('clusters.search')"
        hide-details
        clearable
        style="max-width: 18rem"
      />
      <v-btn icon="mdi-refresh" variant="text" :loading="loading" @click="load" />
    </div>
    <ErrorAlert v-if="error" :error="error" class="mb-2" />
    <v-card border class="table-card">
      <v-table density="compact">
        <thead>
          <tr>
            <th>{{ t('dashboard.kind') }}</th>
            <th>{{ t('clusters.name') }}</th>
            <th>apiVersion</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in shown" :key="r.kind + r.name">
            <td class="text-body-small">{{ r.kind }}</td>
            <td class="font-weight-medium">{{ r.name }}</td>
            <td class="text-body-small font-monospace text-medium-emphasis">{{ r.apiVersion }}</td>
            <td class="text-right"><YamlButton :target="r" label /></td>
          </tr>
          <tr v-if="!loading && !shown.length">
            <td colspan="4" class="text-medium-emphasis">{{ t('dashboard.none') }}</td>
          </tr>
        </tbody>
      </v-table>
    </v-card>
  </div>
</template>
