<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ManifestChartStatus } from '@capi-navigator/shared';
import ErrorAlert from '../ErrorAlert.vue';

/**
 * Where the chart of the manifest add-ons comes from and whether the needed version is there
 * (FP30-F-02, FP30-F-03); with the commands to fill a mirror when it is missing.
 */
defineProps<{ status: ManifestChartStatus | null; error?: unknown; compact?: boolean }>();
const { t } = useI18n();
</script>

<template>
  <ErrorAlert v-if="error" :error="error" />
  <template v-else-if="status">
    <div
      v-if="status.available"
      class="text-body-small text-medium-emphasis"
      data-testid="manifest-chart-ok"
    >
      <v-icon icon="mdi-check-circle" color="success" size="small" class="mr-1" />
      {{
        t('manifestAddons.chartFrom', {
          chart: status.chart,
          version: status.version,
          url: status.repositoryUrl,
        })
      }}
    </div>
    <v-alert
      v-else
      type="warning"
      variant="tonal"
      density="compact"
      data-testid="manifest-chart-missing"
    >
      <div>{{ status.message }}</div>
      <div v-if="status.hint" class="text-body-small mt-1">{{ status.hint }}</div>
      <template v-if="!compact">
        <div class="text-body-small mt-2">{{ t('manifestAddons.mirrorCommands') }}</div>
        <pre class="mirror-commands mt-1">{{ status.mirrorCommands }}</pre>
      </template>
    </v-alert>
  </template>
</template>

<style scoped>
.mirror-commands {
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
