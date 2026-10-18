<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { isReservedLabel, matchesSelector, type AddonStatus } from '@capi-navigator/shared';
import ChangeDialog from '../ChangeDialog.vue';
import AddonReleases from './AddonReleases.vue';
import { useAddonsStore } from '../../stores/addons.js';
import { useAuthStore } from '../../stores/auth.js';
import { useClustersStore } from '../../stores/clusters.js';

/**
 * Helm add-ons of one cluster (FP8-F-12) and assigning an add-on by adding its selector labels
 * to the cluster (FP8-F-08), through the label change with preview (FP6-F-07).
 */
const props = defineProps<{
  connection: string;
  namespace: string;
  name: string;
  labels: Record<string, string>;
}>();
const { t } = useI18n();
const store = useAddonsStore();
const clusters = useClustersStore();
const auth = useAuthStore();
const canChange = computed(() => auth.can('operator'));

let release: (() => void) | null = null;
watch(
  () => props.connection,
  (c) => {
    release?.();
    release = store.watch(c);
  },
  { immediate: true },
);
onBeforeUnmount(() => release?.());

const inNamespace = computed(() =>
  (store.overview?.addons ?? []).filter((a) => a.namespace === props.namespace),
);
const selects = (a: AddonStatus) =>
  a.clusterSelector.matchExpressions?.length
    ? a.matchingClusters.includes(props.name)
    : matchesSelector(props.labels, a.clusterSelector.matchLabels ?? {});
const assigned = computed(() =>
  inNamespace.value.filter((a) => selects(a) || a.releases.some((r) => r.cluster === props.name)),
);
/** Add-ons the cluster can be assigned to: their selector uses user labels only. */
const userSelector = (a: AddonStatus) =>
  !a.presetId &&
  !a.clusterSelector.matchExpressions?.length &&
  Object.keys(a.clusterSelector.matchLabels ?? {}).length > 0 &&
  !Object.keys(a.clusterSelector.matchLabels ?? {}).some(isReservedLabel);
const assignable = computed(() => inNamespace.value.filter((a) => !selects(a) && userSelector(a)));
const releaseOf = (a: AddonStatus) => a.releases.filter((r) => r.cluster === props.name);

const userLabels = computed(() =>
  Object.fromEntries(Object.entries(props.labels).filter(([k]) => !isReservedLabel(k))),
);
const change = ref<{ addon: AddonStatus; labels: Record<string, string>; assign: boolean } | null>(
  null,
);
const changeOpen = ref(false);
const selected = ref<string | null>(null);
function assign(): void {
  const addon = assignable.value.find((a) => a.name === selected.value);
  if (!addon) return;
  change.value = {
    addon,
    labels: { ...userLabels.value, ...addon.clusterSelector.matchLabels },
    assign: true,
  };
  changeOpen.value = true;
}
function unassign(addon: AddonStatus): void {
  const labels = { ...userLabels.value };
  for (const k of Object.keys(addon.clusterSelector.matchLabels ?? {})) delete labels[k];
  change.value = { addon, labels, assign: false };
  changeOpen.value = true;
}
</script>

<template>
  <div data-testid="cluster-addons">
    <v-alert v-if="store.overview && !store.overview.caaph.installed" type="info" variant="tonal">{{
      store.overview.caaph.message
    }}</v-alert>
    <v-progress-linear v-else-if="!store.overview" indeterminate />
    <template v-else>
      <v-card v-if="canChange && assignable.length" border class="mb-4">
        <v-card-text class="d-flex align-center ga-3 flex-wrap">
          <v-select
            v-model="selected"
            :items="assignable"
            item-title="name"
            item-value="name"
            :label="t('addons.assignLabel')"
            density="compact"
            hide-details
            style="max-width: 360px"
            data-testid="assign-addon-select"
          >
            <template #item="{ props: p, item }">
              <v-list-item
                v-bind="p"
                :subtitle="
                  Object.entries(item.raw.clusterSelector.matchLabels ?? {})
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ')
                "
              />
            </template>
          </v-select>
          <v-btn
            color="primary"
            variant="tonal"
            :disabled="!selected"
            prepend-icon="mdi-tag-plus"
            data-testid="assign-addon"
            @click="assign"
            >{{ t('addons.assign') }}</v-btn
          >
          <span class="text-caption text-medium-emphasis">{{ t('addons.assignHint') }}</span>
        </v-card-text>
      </v-card>

      <v-card
        v-for="a in assigned"
        :key="a.name"
        border
        class="mb-3"
        :data-testid="`cluster-addon-${a.name}`"
      >
        <v-card-item
          :title="a.name"
          :subtitle="`${a.chartName} ${a.version ?? ''} · ${a.repository ?? a.repoURL}`"
        >
          <template #append>
            <v-chip v-if="a.presetId" size="x-small" variant="tonal" class="mr-2">{{
              t('addons.preset')
            }}</v-chip>
            <v-btn
              v-if="canChange && userSelector(a) && selects(a)"
              size="small"
              variant="text"
              color="error"
              prepend-icon="mdi-tag-remove"
              :data-testid="`unassign-addon-${a.name}`"
              @click="unassign(a)"
              >{{ t('addons.unassign') }}</v-btn
            >
          </template>
        </v-card-item>
        <v-card-text>
          <AddonReleases :releases="releaseOf(a)" :namespace="a.namespace" hide-cluster />
        </v-card-text>
      </v-card>
      <v-alert v-if="!assigned.length" type="info" variant="tonal">{{
        t('addons.noneForCluster')
      }}</v-alert>
    </template>

    <ChangeDialog
      v-if="change"
      v-model="changeOpen"
      :title="
        change.assign
          ? t('addons.assignTitle', { addon: change.addon.name })
          : t('addons.unassignTitle', { addon: change.addon.name })
      "
      :valid="true"
      :preview="
        () => clusters.labelsPreview(connection, namespace, name, { labels: change!.labels })
      "
      :apply="
        (takeOver) =>
          clusters.setLabels(connection, namespace, name, { labels: change!.labels, takeOver })
      "
    >
      <p class="text-body-2">
        {{
          change.assign
            ? t('addons.assignText', {
                labels: Object.entries(change.addon.clusterSelector.matchLabels ?? {})
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', '),
              })
            : t('addons.unassignText')
        }}
      </p>
    </ChangeDialog>
  </div>
</template>
