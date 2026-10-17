<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Connection } from '@capi-navigator/shared';

const props = defineProps<{ connection: Connection }>();
const { t } = useI18n();

const missing = computed(
  () =>
    props.connection.status.permissions?.filter((p) => !p.allowed && p.level === 'required') ?? [],
);
const look = computed(() => {
  switch (props.connection.status.phase) {
    case 'Reachable':
      return missing.value.length > 0
        ? { color: 'warning', icon: 'mdi-alert' }
        : { color: 'success', icon: 'mdi-check-circle' };
    case 'Unauthorized':
      return { color: 'error', icon: 'mdi-lock-alert' };
    case 'Unreachable':
      return { color: 'error', icon: 'mdi-lan-disconnect' };
    default:
      return { color: 'grey', icon: 'mdi-help-circle' };
  }
});
</script>

<template>
  <v-chip :color="look.color" :prepend-icon="look.icon" size="small" variant="tonal">
    {{ t(`connections.phase.${connection.status.phase}`) }}
  </v-chip>
</template>
