<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api/client.js';

/** Understandable error with hint; the original error stays expandable (NF-06). */
const props = defineProps<{ error: unknown }>();
const { t } = useI18n();
const showDetails = ref(false);

function message(): string {
  return props.error instanceof Error ? props.error.message : String(props.error);
}
function hint(): string | undefined {
  return props.error instanceof ApiError ? props.error.hint : undefined;
}
function details(): string | undefined {
  return props.error instanceof ApiError ? props.error.details : undefined;
}
</script>

<template>
  <v-alert type="error" variant="tonal" density="comfortable" data-testid="error-alert">
    <div class="font-weight-medium">{{ message() }}</div>
    <div v-if="hint()" class="text-body-medium mt-1">{{ hint() }}</div>
    <template v-if="details()">
      <v-btn
        variant="text"
        size="x-small"
        class="mt-1 px-0"
        :append-icon="showDetails ? 'mdi-chevron-up' : 'mdi-chevron-down'"
        @click="showDetails = !showDetails"
      >
        {{ t('errors.details') }}
      </v-btn>
      <pre v-if="showDetails" class="text-body-small mt-1 error-details">{{ details() }}</pre>
    </template>
  </v-alert>
</template>

<style scoped>
.error-details {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
