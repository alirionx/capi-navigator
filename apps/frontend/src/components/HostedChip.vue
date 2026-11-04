<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { HOST_LABEL, HOSTED_ON_LABEL } from '@capi-navigator/shared';

// UX-10: marks hosts and tenants of hosted control planes (FP-24) by their labels; a tenant names
// its host.
defineOptions({ inheritAttrs: false });
const props = defineProps<{ labels: Record<string, string>; size?: 'x-small' | 'small' }>();
const { t } = useI18n();
const host = computed(() => props.labels[HOSTED_ON_LABEL]);
const isHost = computed(() => !host.value && props.labels[HOST_LABEL] === 'true');
</script>

<template>
  <v-tooltip
    v-if="host || isHost"
    location="top"
    :text="host ? t('clusters.hostedTenantHint', { host }) : t('clusters.hostedHostHint')"
  >
    <template #activator="{ props: activator }">
      <v-chip
        v-bind="{ ...activator, ...$attrs }"
        :size="size ?? 'x-small'"
        variant="tonal"
        color="secondary"
        :prepend-icon="host ? 'mdi-cloud-outline' : 'mdi-server-network'"
        data-testid="hosted-chip"
        >{{ host ? t('clusters.hostedTenant', { host }) : t('clusters.hostedHost') }}</v-chip
      >
    </template>
  </v-tooltip>
</template>
