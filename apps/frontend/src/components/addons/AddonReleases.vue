<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { HelmReleaseStatus } from '@capi-navigator/shared';
import YamlButton from '../YamlButton.vue';

/** HelmReleaseProxies of an add-on (FP8-F-11): one row per cluster. */
defineProps<{ releases: HelmReleaseStatus[]; namespace: string; hideCluster?: boolean }>();
const { t } = useI18n();

const statusColor = (r: HelmReleaseStatus) =>
  r.status === 'deployed' && r.ready
    ? 'success'
    : r.status === 'failed'
      ? 'error'
      : r.status?.startsWith('pending')
        ? 'info'
        : 'warning';
const problem = (r: HelmReleaseStatus) =>
  r.conditions.find((c) => c.status === 'False' && c.message)?.message;
</script>

<template>
  <v-table density="compact" data-testid="addon-releases">
    <thead>
      <tr>
        <th v-if="!hideCluster">{{ t('addons.cluster') }}</th>
        <th>{{ t('addons.release') }}</th>
        <th>{{ t('addons.chartVersion') }}</th>
        <th>{{ t('addons.revision') }}</th>
        <th>{{ t('addons.status') }}</th>
        <th />
      </tr>
    </thead>
    <tbody>
      <tr v-for="r in releases" :key="r.name" :data-testid="`release-${r.cluster}`">
        <td v-if="!hideCluster" class="font-weight-medium">{{ r.cluster }}</td>
        <td>{{ r.releaseNamespace ? `${r.releaseNamespace}/` : '' }}{{ r.releaseName ?? '–' }}</td>
        <td>{{ r.chartVersion ?? '–' }}</td>
        <td>{{ r.revision ?? '–' }}</td>
        <td>
          <v-chip size="small" variant="tonal" :color="statusColor(r)">{{
            r.status ?? t('addons.pending')
          }}</v-chip>
          <div v-if="problem(r)" class="text-caption text-error mt-1">{{ problem(r) }}</div>
        </td>
        <td class="text-right">
          <YamlButton
            :target="{
              apiVersion: 'addons.cluster.x-k8s.io/v1alpha1',
              kind: 'HelmReleaseProxy',
              namespace,
              name: r.name,
            }"
          />
        </td>
      </tr>
      <tr v-if="!releases.length">
        <td colspan="6" class="text-medium-emphasis">{{ t('addons.noReleases') }}</td>
      </tr>
    </tbody>
  </v-table>
</template>
