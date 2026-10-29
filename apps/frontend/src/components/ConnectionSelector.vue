<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConnectionsStore } from '../stores/connections.js';

/** Globally active management cluster, shown in the app bar (FP2-F-05). */
const { t } = useI18n();
const store = useConnectionsStore();

const items = computed(() =>
  store.connections.map((c) => ({
    title: c.displayName || c.name,
    value: c.name,
    phase: c.status.phase,
  })),
);
const color = (phase: string) =>
  phase === 'Reachable' ? 'success' : phase === 'Unknown' ? 'grey' : 'error';
</script>

<template>
  <v-select
    v-if="store.connections.length > 0"
    :model-value="store.activeName"
    :items="items"
    :label="t('connections.active')"
    prepend-inner-icon="mdi-kubernetes"
    density="compact"
    variant="solo-filled"
    flat
    hide-details
    max-width="280"
    class="mr-2"
    data-testid="connection-selector"
    @update:model-value="store.setActive"
  >
    <template #item="{ props, internalItem: item }">
      <v-list-item v-bind="props">
        <template #prepend>
          <v-icon icon="mdi-circle" size="x-small" :color="color(item.raw.phase)" class="mr-2" />
        </template>
      </v-list-item>
    </template>
  </v-select>
</template>
