<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ClusterSummary } from '@capi-navigator/shared';
import { useAuthStore } from '../stores/auth.js';
import { useClustersStore } from '../stores/clusters.js';
import { useConnectionsStore } from '../stores/connections.js';

/** Live list of the workload clusters of the active management cluster (FP6-F-01). */
const { t } = useI18n();
const auth = useAuthStore();
const connections = useConnectionsStore();
const store = useClustersStore();
const search = ref('');

watch(
  () => connections.activeName,
  (name) => {
    store.clusters = [];
    if (name) store.watchList(name);
    else store.unwatchList();
  },
  { immediate: true },
);
onBeforeUnmount(() => store.unwatchList());

const headers = computed(() => [
  { title: t('clusters.name'), key: 'name' },
  { title: t('clusters.namespace'), key: 'namespace' },
  { title: t('clusters.provider'), key: 'provider' },
  { title: t('clusters.distribution'), key: 'flavor' },
  { title: t('clusters.version'), key: 'version' },
  { title: t('clusters.nodes'), key: 'nodes', sortable: false },
  { title: t('clusters.labels'), key: 'labels', sortable: false },
  { title: t('clusters.phase'), key: 'phase' },
]);

/** Labels shown in the list: without the add-on selection labels the app sets itself. */
const userLabels = (c: ClusterSummary) =>
  Object.entries(c.labels).filter(([k]) => !k.startsWith('capi-navigator.io/'));

function filter(_value: unknown, query: string, item?: { raw: ClusterSummary }): boolean {
  if (!item) return false;
  const q = query.trim().toLowerCase();
  const c = item.raw;
  return [c.name, c.namespace, c.provider ?? '', ...Object.entries(c.labels).flat()].some((s) =>
    s.toLowerCase().includes(q),
  );
}

const phaseColor = (c: ClusterSummary) =>
  c.ready
    ? 'success'
    : c.phase === 'Failed'
      ? 'error'
      : c.phase === 'Deleting'
        ? 'warning'
        : 'info';
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-3 mb-6">
      <div>
        <h1 class="page-title">{{ t('clusters.title') }}</h1>
        <p class="text-body-2 text-medium-emphasis mt-1">
          {{ t('clusters.count', { n: store.clusters.length }) }} · {{ t('clusters.subtitle') }}
        </p>
      </div>
      <v-spacer />
      <v-chip
        v-if="connections.active"
        :color="store.listLive ? 'success' : 'grey'"
        variant="tonal"
        prepend-icon="mdi-access-point"
        size="small"
      >
        {{ store.listLive ? t('providers.live') : t('providers.connecting') }}
      </v-chip>
      <v-text-field
        v-model="search"
        prepend-inner-icon="mdi-magnify"
        :label="t('clusters.search')"
        hide-details
        clearable
        style="max-width: 20rem"
      />
      <v-btn
        v-if="auth.can('operator') && connections.active"
        color="primary"
        variant="flat"
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
      <v-alert v-if="store.listError" type="error" variant="tonal" class="mb-4">{{
        store.listError
      }}</v-alert>
      <v-card border class="table-card">
        <v-data-table
          :headers="headers"
          :items="store.clusters"
          :loading="store.loading"
          :search="search"
          :custom-filter="filter"
          :no-data-text="t('clusters.empty')"
          hover
          data-testid="clusters-table"
        >
          <template #[`item.name`]="{ item }">
            <router-link
              :to="{ name: 'cluster', params: { namespace: item.namespace, name: item.name } }"
              class="font-weight-medium"
              >{{ item.name }}</router-link
            >
            <v-chip
              v-if="!item.managed"
              size="x-small"
              variant="tonal"
              class="ml-2"
              :title="t('clusters.externalHint')"
              >{{ t('clusters.external') }}</v-chip
            >
          </template>
          <template #[`item.provider`]="{ item }">{{ item.provider ?? '–' }}</template>
          <template #[`item.flavor`]="{ item }">{{ item.flavor ?? '–' }}</template>
          <template #[`item.version`]="{ item }">{{ item.version ?? '–' }}</template>
          <template #[`item.nodes`]="{ item }">
            <span v-if="item.controlPlane"
              >{{ item.controlPlane.ready }}/{{ item.controlPlane.replicas }} CP</span
            >
            <span v-if="item.workers">
              · {{ item.workers.ready }}/{{ item.workers.replicas }}
              {{ t('clusters.workers') }}</span
            >
          </template>
          <template #[`item.labels`]="{ item }">
            <v-chip
              v-for="[k, v] in userLabels(item)"
              :key="k"
              size="x-small"
              variant="outlined"
              class="mr-1"
              >{{ k }}={{ v }}</v-chip
            >
          </template>
          <template #[`item.phase`]="{ item }">
            <v-chip size="small" variant="tonal" :color="phaseColor(item)">
              {{ item.ready ? t('clusters.ready') : item.phase }}
            </v-chip>
          </template>
        </v-data-table>
      </v-card>
    </template>
  </v-container>
</template>
