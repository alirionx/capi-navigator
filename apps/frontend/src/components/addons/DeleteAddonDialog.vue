<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AddonDeletePreview } from '@capi-navigator/shared';
import ErrorAlert from '../ErrorAlert.vue';
import YamlViewer from '../YamlViewer.vue';
import { useAddonsStore } from '../../stores/addons.js';

/** Removing an add-on (FP8-F-13): which releases are uninstalled, then confirm by name. */
const props = defineProps<{ connection: string; namespace: string; name: string }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ deleted: [] }>();
const { t } = useI18n();
const addons = useAddonsStore();

const preview = ref<AddonDeletePreview | null>(null);
const error = ref<unknown>(null);
const confirmName = ref('');
const busy = ref(false);

watch(
  open,
  async (o) => {
    if (!o) return;
    preview.value = null;
    error.value = null;
    confirmName.value = '';
    try {
      preview.value = await addons.deletePreview(props.connection, props.namespace, props.name);
    } catch (err) {
      error.value = err;
    }
  },
  { immediate: true },
);

async function confirm(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await addons.remove(props.connection, props.namespace, props.name);
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
  <v-dialog v-model="open" max-width="760" scrollable>
    <v-card :title="t('addons.deleteTitle', { name })" data-testid="delete-addon-dialog">
      <v-card-text>
        <v-progress-linear v-if="!preview && !error" indeterminate />
        <template v-if="preview">
          <v-alert
            v-for="w in preview.warnings"
            :key="w"
            :type="preview.uninstalls ? 'warning' : 'info'"
            variant="tonal"
            class="mb-3"
            >{{ w }}</v-alert
          >
          <div class="text-subtitle-2 mb-1">{{ t('addons.affectedReleases') }}</div>
          <div class="mb-3" data-testid="delete-releases">
            <v-chip
              v-for="r in preview.releases"
              :key="r.cluster"
              size="small"
              :color="preview.uninstalls ? 'warning' : 'default'"
              variant="tonal"
              class="mr-1 mb-1"
              >{{ r.cluster }}{{ r.releaseName ? ` / ${r.releaseName}` : '' }}</v-chip
            >
            <span v-if="!preview.releases.length" class="text-body-2">{{
              t('addons.noReleases')
            }}</span>
          </div>
          <YamlViewer :value="preview.yaml" height="220px" no-download />
          <v-text-field
            v-model="confirmName"
            :label="t('addons.confirmName', { name })"
            class="mt-4"
            data-testid="delete-addon-confirm"
          />
        </template>
        <ErrorAlert v-if="error" :error="error" class="mt-3" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">{{ t('common.cancel') }}</v-btn>
        <v-btn
          color="error"
          variant="flat"
          :disabled="!preview || confirmName !== name"
          :loading="busy"
          data-testid="delete-addon-apply"
          @click="confirm"
          >{{ t('common.delete') }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
