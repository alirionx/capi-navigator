<script setup lang="ts">
import { useI18n } from 'vue-i18n';

// UX-05: marks a cluster whose nodes run without internet (FP-29); the tooltip names the internal
// registry they pull from.
defineProps<{ registry: string; size?: 'x-small' | 'small' }>();
const { t } = useI18n();
</script>

<template>
  <v-tooltip location="top" :text="t('clusters.airGappedHint', { registry })">
    <template #activator="{ props: activator }">
      <v-chip
        v-bind="activator"
        :size="size ?? 'x-small'"
        variant="tonal"
        color="info"
        prepend-icon="mdi-lan-disconnect"
        data-testid="air-gapped-chip"
        >{{ t('clusters.airGapped') }}</v-chip
      >
    </template>
  </v-tooltip>
</template>
