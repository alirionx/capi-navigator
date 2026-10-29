<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAddonsStore } from '../../stores/addons.js';
import { selectorLabels, type SelectorRow } from './selector.js';

/**
 * matchLabels of a HelmChartProxy with the clusters they select right now (FP8-F-07); shared by
 * Helm and manifest add-ons.
 */
const props = defineProps<{ connection: string; namespace: string; active: boolean }>();
const rows = defineModel<SelectorRow[]>({ required: true });
const { t } = useI18n();
const addons = useAddonsStore();

const matching = ref<string[] | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  [() => props.namespace, () => selectorLabels(rows.value), () => props.active],
  ([ns, sel, active]) => {
    clearTimeout(timer);
    matching.value = null;
    if (!active || !ns || !Object.keys(sel).length) return;
    timer = setTimeout(async () => {
      try {
        matching.value = await addons.matching(props.connection, ns, sel);
      } catch {
        matching.value = null;
      }
    }, 400);
  },
  { deep: true, immediate: true },
);
</script>

<template>
  <div class="text-title-small mt-4">{{ t('addons.selector') }}</div>
  <p class="text-body-small text-medium-emphasis mb-2">
    {{ t('addons.selectorHint') }}
    {{ t('addons.mapsTo', { field: 'spec.clusterSelector.matchLabels' }) }}
  </p>
  <div v-for="(s, i) in rows" :key="i" class="d-flex ga-2 align-center">
    <v-text-field
      v-model="s.key"
      :label="t('addons.labelKey')"
      density="compact"
      hide-details
      :data-testid="`selector-key-${i}`"
    />
    <v-text-field
      v-model="s.value"
      :label="t('addons.labelValue')"
      density="compact"
      hide-details
      :data-testid="`selector-value-${i}`"
    />
    <v-btn
      icon="mdi-close"
      size="small"
      variant="text"
      :aria-label="t('common.delete')"
      :disabled="rows.length === 1"
      @click="rows.splice(i, 1)"
    />
  </div>
  <v-btn
    size="small"
    variant="text"
    prepend-icon="mdi-plus"
    class="mt-1"
    @click="rows.push({ key: '', value: '' })"
    >{{ t('addons.addLabel') }}</v-btn
  >
  <div class="mt-2" data-testid="addon-matching">
    <span class="text-body-small text-medium-emphasis mr-2">{{ t('addons.matching') }}</span>
    <template v-if="matching">
      <v-chip
        v-for="c in matching"
        :key="c"
        size="small"
        color="success"
        variant="tonal"
        class="mr-1"
        >{{ c }}</v-chip
      >
      <span v-if="!matching.length" class="text-body-small">{{ t('addons.noMatch') }}</span>
    </template>
    <span v-else class="text-body-small">–</span>
  </div>
</template>
