<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiText } from '../api/client.js';
import ErrorAlert from './ErrorAlert.vue';
import YamlViewer from './YamlViewer.vue';

/**
 * Kubeconfig of a workload cluster (FP6-F-04, ADR-0005): fetched only while the dialog is open,
 * kept in this component only and dropped on close. The download goes through the audited
 * backend endpoint.
 */
const props = defineProps<{ connection: string; namespace: string; name: string }>();
const open = defineModel<boolean>({ required: true });
const { t } = useI18n();
const content = ref('');
const loading = ref(false);
const error = ref<unknown>(null);

const base = () =>
  `/api/connections/${encodeURIComponent(props.connection)}/clusters/${encodeURIComponent(
    props.namespace,
  )}/${encodeURIComponent(props.name)}/kubeconfig`;

watch(
  open,
  async (isOpen) => {
    content.value = '';
    error.value = null;
    if (!isOpen) return;
    loading.value = true;
    try {
      content.value = await apiText(base());
    } catch (err) {
      error.value = err;
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);
</script>

<template>
  <v-dialog v-model="open" max-width="900" scrollable>
    <v-card :title="t('kubeconfig.title', { name })" data-testid="kubeconfig-dialog">
      <v-card-text>
        <v-alert type="warning" variant="tonal" density="compact" class="mb-3">
          {{ t('kubeconfig.warning') }}
        </v-alert>
        <ErrorAlert v-if="error" :error="error" />
        <v-progress-linear v-else-if="loading" indeterminate />
        <YamlViewer v-else-if="content" :value="content" height="420px" no-download>
          <template #actions>
            <v-btn
              size="small"
              variant="text"
              prepend-icon="mdi-download"
              :href="`${base()}/download`"
              data-testid="kubeconfig-download"
              >{{ t('yaml.download') }}</v-btn
            >
          </template>
        </YamlViewer>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">{{ t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
