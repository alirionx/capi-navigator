<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { isReservedLabel, type ClusterSummary } from '@capi-navigator/shared';
import { formatAge, formatCreated, useNow } from '../composables/age.js';
import { useAuthStore } from '../stores/auth.js';
import { useClustersStore } from '../stores/clusters.js';
import { useConnectionsStore } from '../stores/connections.js';
import { useCredentialsStore } from '../stores/credentials.js';
import { infraLocation } from '../components/infra-location.js';
import AirGappedChip from '../components/AirGappedChip.vue';

/** Live list of the workload clusters of the active management cluster (FP6-F-01). */
const { t } = useI18n();
const auth = useAuthStore();
const connections = useConnectionsStore();
const store = useClustersStore();
const credentials = useCredentialsStore();
const search = ref('');
const now = useNow();

watch(
  () => connections.activeName,
  (name) => {
    store.clusters = [];
    if (name) store.watchList(name);
    else store.unwatchList();
    // UX-08: the region of OpenStack credentials; without it the list shows the credential name.
    if (name) credentials.load(name).catch(() => undefined);
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
  // Sorting by creation time: newest first means the smallest age.
  {
    title: t('clusters.age'),
    key: 'createdAt',
    sortRaw: (a: ClusterSummary, b: ClusterSummary) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
  },
]);

/** Labels shown in the list: without the labels the app and CAPI set themselves. */
const userLabels = (c: ClusterSummary) =>
  Object.entries(c.labels).filter(([k]) => !isReservedLabel(k));

function filter(_value: unknown, query: string, item?: { raw: ClusterSummary }): boolean {
  if (!item) return false;
  const q = query.trim().toLowerCase();
  const c = item.raw;
  return [
    c.name,
    c.namespace,
    c.provider ?? '',
    location(c) ?? '',
    ...Object.entries(c.labels).flat(),
  ].some((s) => s.toLowerCase().includes(q));
}

/** UX-08: credentials and region or node the cluster runs on. */
const location = (c: ClusterSummary) => infraLocation(c, credentials.credentials);

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
        <p class="text-body-medium text-medium-emphasis mt-1">
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
        v-if="
          connections.active && auth.can('clusters.create', { connection: connections.active.name })
        "
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
            <AirGappedChip
              v-if="item.airGappedRegistry"
              :registry="item.airGappedRegistry"
              class="ml-2"
            />
          </template>
          <template #[`item.provider`]="{ item }">
            <div>{{ item.provider ?? '–' }}</div>
            <div
              v-if="location(item)"
              class="text-body-small text-medium-emphasis"
              data-testid="cluster-location"
            >
              {{ location(item) }}
            </div>
          </template>
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
          <template #[`item.createdAt`]="{ item }">
            <span :title="formatCreated(item.createdAt)" data-testid="cluster-age">{{
              formatAge(item.createdAt, now)
            }}</span>
          </template>
          <template #[`item.phase`]="{ item }">
            <v-chip
              v-if="item.deletion"
              size="small"
              variant="tonal"
              :color="item.deletion.phase === 'cleanup-timeout' ? 'warning' : 'info'"
              :title="item.deletion.message"
            >
              {{ t(`deletion.phase.${item.deletion.phase}`) }}
            </v-chip>
            <v-chip v-else size="small" variant="tonal" :color="phaseColor(item)">
              {{ item.ready ? t('clusters.ready') : item.phase }}
            </v-chip>
          </template>
        </v-data-table>
      </v-card>
    </template>
  </v-container>
</template>
