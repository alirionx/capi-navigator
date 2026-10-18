<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DeletePreview } from '@capi-navigator/shared';
import { useClustersStore } from '../stores/clusters.js';
import ErrorAlert from './ErrorAlert.vue';

/**
 * Deletes a cluster (FP6-F-06): shows what will be removed (hard rule 6), cleans up workloads,
 * load balancers and volumes inside the cluster first (default) and is confirmed by the name.
 */
const props = defineProps<{ connection: string; namespace: string; name: string }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ deleted: [] }>();
const { t } = useI18n();
const store = useClustersStore();

const preview = ref<DeletePreview | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref<unknown>(null);
const cleanup = ref(true);
const skipDrain = ref(false);
const confirmName = ref('');

watch(open, async (o) => {
  if (!o) return;
  preview.value = null;
  error.value = null;
  confirmName.value = '';
  cleanup.value = true;
  skipDrain.value = false;
  loading.value = true;
  try {
    preview.value = await store.deletePreview(props.connection, props.namespace, props.name);
    cleanup.value = preview.value.workloadReachable;
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
});

const canDelete = computed(
  () => !!preview.value?.managed && confirmName.value === props.name && !busy.value,
);
const nothingInside = computed(
  () =>
    !!preview.value &&
    preview.value.namespaces.length +
      preview.value.loadBalancers.length +
      preview.value.volumes.length ===
      0,
);

async function confirm(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await store.deleteCluster(props.connection, props.namespace, props.name, {
      confirmName: confirmName.value,
      cleanup: cleanup.value,
      skipDrain: skipDrain.value,
    });
    open.value = false;
    emit('deleted');
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="640" scrollable>
    <v-card :title="t('deletion.title', { name })" data-testid="delete-dialog">
      <v-card-text>
        <v-progress-linear v-if="loading" indeterminate class="mb-3" />
        <template v-if="preview">
          <v-alert v-if="!preview.managed" type="info" variant="tonal" class="mb-3">{{
            t('changes.externalReadOnly')
          }}</v-alert>
          <p class="text-body-2 mb-2">{{ t('deletion.removes') }}</p>
          <ul class="text-body-2 mb-3 ml-5">
            <li v-for="o in preview.objects" :key="o.kind + o.name">
              {{ o.kind }} <span class="font-weight-medium">{{ o.name }}</span>
            </li>
            <li>{{ t('deletion.cascade') }}</li>
          </ul>

          <v-card border class="pa-3 mb-3">
            <v-switch
              v-model="cleanup"
              :disabled="!preview.workloadReachable"
              :label="t('deletion.cleanup')"
              :hint="t('deletion.cleanupHint')"
              persistent-hint
              data-testid="delete-cleanup"
            />
            <div v-if="cleanup && preview.workloadReachable" class="text-body-2 mt-3">
              <div v-if="nothingInside" class="text-medium-emphasis">
                {{ t('deletion.nothingInside') }}
              </div>
              <div v-if="preview.namespaces.length">
                <strong>{{ t('deletion.namespaces') }}:</strong> {{ preview.namespaces.join(', ') }}
              </div>
              <div v-if="preview.loadBalancers.length">
                <strong>{{ t('deletion.loadBalancers') }}:</strong>
                {{ preview.loadBalancers.join(', ') }}
              </div>
              <div v-if="preview.volumes.length">
                <strong>{{ t('deletion.volumes') }}:</strong> {{ preview.volumes.join(', ') }}
              </div>
            </div>
            <!-- Without a working cluster API, node draining never finishes. -->
            <v-switch
              v-if="!preview.workloadReachable"
              v-model="skipDrain"
              :label="t('deletion.skipDrain')"
              :hint="t('deletion.skipDrainHint')"
              persistent-hint
              color="warning"
              class="mt-2"
              data-testid="delete-skip-drain"
            />
          </v-card>

          <v-alert
            v-for="w in preview.warnings"
            :key="w"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-2"
            >{{ w }}</v-alert
          >
          <v-alert v-if="!cleanup" type="warning" variant="tonal" density="compact" class="mb-2">{{
            t('deletion.noCleanupWarning')
          }}</v-alert>

          <v-text-field
            v-model="confirmName"
            :label="t('deletion.confirmLabel', { name })"
            :disabled="!preview.managed"
            class="mt-3"
            autocomplete="off"
            data-testid="delete-confirm"
          />
        </template>
        <ErrorAlert v-if="error" :error="error" class="mt-2" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
        <v-btn
          color="error"
          variant="flat"
          :disabled="!canDelete"
          :loading="busy"
          data-testid="delete-submit"
          @click="confirm"
          >{{ t('common.delete') }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
