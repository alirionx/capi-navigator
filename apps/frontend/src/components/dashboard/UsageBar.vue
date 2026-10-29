<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ResourceUse } from '@capi-navigator/shared';

/**
 * Usage of one resource (FP-18): solid bar = actual usage (metrics-server), light bar = requests,
 * both relative to the allocatable capacity; limits as text.
 */
const props = defineProps<{ label: string; use: ResourceUse; kind: 'cpu' | 'memory' }>();
const { t } = useI18n();

const pct = (v: number | undefined) =>
  v === undefined || props.use.allocatable <= 0
    ? undefined
    : Math.round((v / props.use.allocatable) * 100);
const usagePct = computed(() => pct(props.use.usage));
const requestPct = computed(() => pct(props.use.requests) ?? 0);
const limitPct = computed(() => pct(props.use.limits) ?? 0);

function fmt(v: number): string {
  if (props.kind === 'cpu') return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}` : `${v}m`;
  const gi = v / 1024 ** 3;
  return gi >= 1 ? `${gi.toFixed(1)}Gi` : `${Math.round(v / 1024 ** 2)}Mi`;
}
const tone = computed(() => {
  const p = Math.max(usagePct.value ?? 0, requestPct.value);
  return p >= 90 ? 'error' : p >= 75 ? 'warning' : 'primary';
});
</script>

<template>
  <div class="usage">
    <div class="d-flex text-body-small mb-1">
      <span class="font-weight-medium">{{ label }}</span>
      <v-spacer />
      <span v-if="use.usage !== undefined"
        >{{ fmt(use.usage) }} / {{ fmt(use.allocatable) }} ({{ usagePct }}%)</span
      >
      <span v-else class="text-medium-emphasis">{{ t('dashboard.noMetrics') }}</span>
    </div>
    <div class="track" role="img" :aria-label="`${label}: ${usagePct ?? '–'}%`">
      <div class="requests" :style="{ width: `${Math.min(requestPct, 100)}%` }" />
      <div
        v-if="usagePct !== undefined"
        class="used"
        :class="`used--${tone}`"
        :style="{ width: `${Math.min(usagePct, 100)}%` }"
      />
    </div>
    <div class="text-body-small text-medium-emphasis mt-1">
      {{ t('dashboard.requests') }} {{ fmt(use.requests) }} ({{ requestPct }}%) ·
      {{ t('dashboard.limits') }} {{ fmt(use.limits) }} ({{ limitPct }}%)
    </div>
  </div>
</template>

<style scoped>
.track {
  position: relative;
  height: 10px;
  border-radius: 5px;
  background: rgba(var(--v-theme-on-surface), 0.08);
  overflow: hidden;
}
.requests,
.used {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 5px;
}
.requests {
  background: rgba(var(--v-theme-info), 0.3);
}
.used--primary {
  background: rgb(var(--v-theme-primary));
}
.used--warning {
  background: rgb(var(--v-theme-warning));
}
.used--error {
  background: rgb(var(--v-theme-error));
}
</style>
