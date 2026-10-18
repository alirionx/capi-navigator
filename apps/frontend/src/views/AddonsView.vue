<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AddonSpec, AddonStatus } from '@capi-navigator/shared';
import AddonDialog from '../components/addons/AddonDialog.vue';
import AddonReleases from '../components/addons/AddonReleases.vue';
import DeleteAddonDialog from '../components/addons/DeleteAddonDialog.vue';
import PresetsPanel from '../components/addons/PresetsPanel.vue';
import YamlButton from '../components/YamlButton.vue';
import { useAddonsStore } from '../stores/addons.js';
import { useAuthStore } from '../stores/auth.js';
import { useClustersStore } from '../stores/clusters.js';
import { useConnectionsStore } from '../stores/connections.js';
import { useHelmRepositoriesStore } from '../stores/helm-repositories.js';

/** Helm add-ons via CAAPH (FP-8): list, releases per cluster, create, edit, delete. */
const { t } = useI18n();
const auth = useAuthStore();
const connections = useConnectionsStore();
const store = useAddonsStore();
const clusters = useClustersStore();
const repos = useHelmRepositoriesStore();
const canChange = computed(() => auth.can('operator'));

let release: (() => void) | null = null;
watch(
  () => connections.activeName,
  (name) => {
    release?.();
    release = name ? store.watch(name) : null;
    if (name) void clusters.load(name).catch(() => undefined);
  },
  { immediate: true },
);
void repos.load().catch(() => undefined);
onBeforeUnmount(() => release?.());

const caaph = computed(() => store.overview?.caaph);
const addons = computed(() => (store.overview?.addons ?? []).filter((a) => !a.presetId));
/** Namespaces with workload clusters (a HelmChartProxy selects clusters of its namespace only). */
const namespaces = computed(() =>
  [
    ...new Set([
      ...clusters.clusters.map((c) => c.namespace),
      ...addons.value.map((a) => a.namespace),
    ]),
  ].sort(),
);

const headers = computed(() => [
  { title: t('addons.name'), key: 'name' },
  { title: t('addons.namespace'), key: 'namespace' },
  { title: t('addons.chart'), key: 'chartName' },
  { title: t('addons.selector'), key: 'selector', sortable: false },
  { title: t('addons.releases'), key: 'releases', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
  { title: '', key: 'data-table-expand' },
]);
const expanded = ref<string[]>([]);
const rowKey = (a: AddonStatus) => `${a.namespace}/${a.name}`;
const deployed = (a: AddonStatus) =>
  a.releases.filter((r) => r.status === 'deployed' && r.ready).length;

const dialogOpen = ref(false);
const editing = ref<AddonSpec | undefined>(undefined);
function openNew(): void {
  editing.value = undefined;
  dialogOpen.value = true;
}
function openEdit(a: AddonStatus): void {
  editing.value = a.spec;
  dialogOpen.value = true;
}
const deleting = ref<AddonStatus | null>(null);
const deleteOpen = ref(false);
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <div>
        <h1 class="page-title">{{ t('addons.title') }}</h1>
        <p class="text-body-2 text-medium-emphasis mt-1">{{ t('addons.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-chip
        v-if="connections.active"
        :color="store.live ? 'success' : 'grey'"
        variant="tonal"
        prepend-icon="mdi-access-point"
      >
        {{ store.live ? t('providers.live') : t('providers.connecting') }}
      </v-chip>
      <v-btn
        v-if="canChange && connections.active"
        color="primary"
        prepend-icon="mdi-plus"
        :disabled="!caaph?.ready || !repos.repositories.length"
        data-testid="new-addon"
        @click="openNew"
        >{{ t('addons.new') }}</v-btn
      >
    </div>

    <v-alert v-if="!connections.active" type="info" variant="tonal">
      {{ t('providers.noConnection') }}
    </v-alert>
    <template v-else>
      <v-alert v-if="store.error" type="error" variant="tonal" class="mb-4">{{
        store.error
      }}</v-alert>
      <v-progress-linear v-if="!store.overview && !store.error" indeterminate class="mb-4" />
      <!-- FP8-F-01 -->
      <v-alert
        v-if="caaph && !caaph.ready"
        type="warning"
        variant="tonal"
        class="mb-4"
        data-testid="caaph-missing"
      >
        {{ caaph.message }}
        <template #append>
          <v-btn :to="{ name: 'providers' }" variant="text">{{ t('nav.providers') }}</v-btn>
        </template>
      </v-alert>
      <v-alert
        v-if="caaph?.ready && !repos.repositories.length && !repos.loading"
        type="info"
        variant="tonal"
        class="mb-4"
      >
        {{ t('addons.noRepositoriesYet') }}
        <template #append>
          <v-btn :to="{ name: 'helm-repositories' }" variant="text">{{
            t('nav.helmRepositories')
          }}</v-btn>
        </template>
      </v-alert>

      <v-card v-if="store.overview" border class="mb-6">
        <v-data-table
          v-model:expanded="expanded"
          :headers="headers"
          :items="addons"
          :item-value="rowKey"
          show-expand
          :no-data-text="t('addons.empty')"
          data-testid="addons-table"
        >
          <template #[`item.name`]="{ item }">
            <span class="font-weight-medium">{{ item.name }}</span>
            <v-chip v-if="!item.managed" size="x-small" variant="tonal" class="ml-2">{{
              t('addons.external')
            }}</v-chip>
            <v-chip
              v-if="item.reconcileStrategy === 'InstallOnce'"
              size="x-small"
              variant="tonal"
              color="info"
              class="ml-1"
              >{{ t('addons.installOnce') }}</v-chip
            >
          </template>
          <template #[`item.chartName`]="{ item }">
            {{ item.chartName }}<span class="text-medium-emphasis ml-1">{{ item.version }}</span>
            <div class="text-caption text-medium-emphasis">
              {{ item.repository ?? item.repoURL }}
            </div>
          </template>
          <template #[`item.selector`]="{ item }">
            <v-chip
              v-for="(v, k) in item.clusterSelector.matchLabels ?? {}"
              :key="k"
              size="x-small"
              variant="outlined"
              class="mr-1"
              >{{ k }}={{ v }}</v-chip
            >
            <span v-if="item.clusterSelector.matchExpressions?.length" class="text-caption">{{
              t('addons.expressions')
            }}</span>
          </template>
          <template #[`item.releases`]="{ item }">
            <v-chip
              size="small"
              variant="tonal"
              :color="
                item.releases.length && deployed(item) === item.releases.length
                  ? 'success'
                  : item.releases.length
                    ? 'warning'
                    : 'grey'
              "
              :data-testid="`addon-releases-${item.name}`"
              >{{ deployed(item) }}/{{ item.matchingClusters.length }}</v-chip
            >
          </template>
          <template #[`item.actions`]="{ item }">
            <div class="d-flex justify-end ga-1">
              <YamlButton
                :target="{
                  apiVersion: 'addons.cluster.x-k8s.io/v1alpha1',
                  kind: 'HelmChartProxy',
                  namespace: item.namespace,
                  name: item.name,
                }"
              />
              <v-btn
                v-if="canChange && item.managed && item.spec"
                icon="mdi-pencil"
                size="small"
                variant="text"
                :aria-label="t('addons.edit')"
                :data-testid="`edit-addon-${item.name}`"
                @click="openEdit(item)"
              />
              <v-btn
                v-if="canChange && item.managed"
                icon="mdi-delete"
                size="small"
                variant="text"
                color="error"
                :aria-label="t('common.delete')"
                :data-testid="`delete-addon-${item.name}`"
                @click="
                  deleting = item;
                  deleteOpen = true;
                "
              />
            </div>
          </template>
          <template #expanded-row="{ columns, item }">
            <tr>
              <td :colspan="columns.length" class="py-3">
                <AddonReleases :releases="item.releases" :namespace="item.namespace" />
                <div
                  v-for="c in item.conditions.filter((x) => x.status === 'False')"
                  :key="c.type"
                  class="text-caption text-warning mt-2"
                >
                  {{ c.type }}: {{ c.reason }} {{ c.message }}
                </div>
              </td>
            </tr>
          </template>
        </v-data-table>
      </v-card>

      <PresetsPanel v-if="caaph?.installed" :connection="connections.activeName!" />

      <AddonDialog
        v-model="dialogOpen"
        :connection="connections.activeName!"
        :initial="editing"
        :namespaces="namespaces"
      />
      <DeleteAddonDialog
        v-if="deleting"
        v-model="deleteOpen"
        :connection="connections.activeName!"
        :namespace="deleting.namespace"
        :name="deleting.name"
      />
    </template>
  </v-container>
</template>
