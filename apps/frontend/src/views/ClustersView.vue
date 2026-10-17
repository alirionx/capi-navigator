<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ErrorAlert from '../components/ErrorAlert.vue';
import { useAuthStore } from '../stores/auth.js';
import { useClustersStore } from '../stores/clusters.js';
import { useConnectionsStore } from '../stores/connections.js';

/** Workload clusters of the active management cluster (FP-5; full list view in FP-6). */
const { t } = useI18n();
const auth = useAuthStore();
const connections = useConnectionsStore();
const store = useClustersStore();
const error = ref<unknown>(null);

async function reload(): Promise<void> {
  if (!connections.activeName) return;
  error.value = null;
  try {
    await store.load(connections.activeName);
  } catch (err) {
    error.value = err;
  }
}
watch(() => connections.activeName, reload, { immediate: true });

const headers = computed(() => [
  { title: t('clusters.name'), key: 'name' },
  { title: t('clusters.namespace'), key: 'namespace' },
  { title: t('clusters.provider'), key: 'provider' },
  { title: t('clusters.version'), key: 'version' },
  { title: t('clusters.nodes'), key: 'nodes', sortable: false },
  { title: t('clusters.phase'), key: 'phase' },
]);
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <div>
        <h1 class="text-h4">{{ t('clusters.title') }}</h1>
        <p class="text-medium-emphasis">{{ t('clusters.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-btn icon="mdi-refresh" variant="text" :aria-label="t('home.refresh')" @click="reload" />
      <v-btn
        v-if="auth.can('operator') && connections.active"
        color="primary"
        prepend-icon="mdi-plus"
        :to="{ name: 'cluster-new' }"
        data-testid="new-cluster"
      >
        {{ t('clusters.create') }}
      </v-btn>
    </div>
    <v-alert v-if="!connections.active" type="info" variant="tonal">{{
      t('providers.noConnection')
    }}</v-alert>
    <template v-else>
      <ErrorAlert v-if="error" :error="error" class="mb-4" />
      <v-data-table
        :headers="headers"
        :items="store.clusters"
        :loading="store.loading"
        :no-data-text="t('clusters.empty')"
        data-testid="clusters-table"
      >
        <template #[`item.name`]="{ item }">
          <router-link
            :to="{ name: 'cluster', params: { namespace: item.namespace, name: item.name } }"
            >{{ item.name }}</router-link
          >
        </template>
        <template #[`item.provider`]="{ item }"
          >{{ item.provider ?? '–' }} {{ item.flavor ? `· ${item.flavor}` : '' }}</template
        >
        <template #[`item.nodes`]="{ item }">
          <span v-if="item.controlPlane"
            >{{ item.controlPlane.ready }}/{{ item.controlPlane.replicas }} CP</span
          >
          <span v-if="item.workers">
            · {{ item.workers.ready }}/{{ item.workers.replicas }} {{ t('clusters.workers') }}</span
          >
        </template>
        <template #[`item.phase`]="{ item }">
          <v-chip
            size="small"
            variant="tonal"
            :color="item.ready ? 'success' : item.phase === 'Failed' ? 'error' : 'info'"
          >
            {{ item.ready ? t('clusters.ready') : item.phase }}
          </v-chip>
        </template>
      </v-data-table>
    </template>
  </v-container>
</template>
