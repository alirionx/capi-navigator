<script setup lang="ts">
import { computed, ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { GcpCredentialInputSchema, type Credential } from '@capi-navigator/shared';
import { fieldErrors, zodRule } from '../../forms/zod-rules.js';
import FieldHelp from '../FieldHelp.vue';

/** Secret part of Google Cloud credentials: the JSON key of a service account (FP25-F-02). */
const input = defineModel<unknown>({ required: true });
const props = defineProps<{
  credential?: Credential | null;
  serverFieldErrors?: Record<string, string[]>;
}>();
const { t } = useI18n();
const gcpShape = GcpCredentialInputSchema.shape;

const gcpKey = ref('');
const gcpKeyFile = ref<File | File[] | null>(null);
const gcpRegion = ref(props.credential?.summary.region ?? 'europe-west6');
watch(gcpKeyFile, async (f) => {
  const file = Array.isArray(f) ? f[0] : f;
  if (file) gcpKey.value = await file.text();
});
/** Project and service account of the pasted key, shown before saving (no secret parts). */
const gcpKeyInfo = computed(() => {
  try {
    const k = JSON.parse(gcpKey.value) as {
      type?: string;
      project_id?: string;
      client_email?: string;
    };
    return k.type === 'service_account' && k.project_id
      ? { project: k.project_id, account: k.client_email ?? '' }
      : null;
  } catch {
    return null;
  }
});

watchEffect(() => {
  input.value = { serviceAccountKey: gcpKey.value.trim(), region: gcpRegion.value.trim() };
});
</script>

<template>
  <div>
    <v-alert type="info" variant="tonal" density="compact" class="mb-3">{{
      t('credentials.gcp.recommend')
    }}</v-alert>
    <v-file-input
      v-model="gcpKeyFile"
      :label="t('credentials.gcp.keyFile')"
      accept=".json,application/json"
      prepend-icon="mdi-file-key"
      show-size
      data-testid="gcp-key-file"
    />
    <v-textarea
      v-model="gcpKey"
      :label="t('credentials.gcp.keyPaste')"
      :rules="[zodRule(gcpShape.serviceAccountKey)]"
      :error-messages="fieldErrors(serverFieldErrors, 'gcp.serviceAccountKey')"
      rows="3"
      class="secret-text mb-4"
      autocomplete="off"
      data-testid="gcp-key"
    >
      <template #append-inner>
        <FieldHelp :text="t('credentials.gcp.keyHint')" />
      </template>
    </v-textarea>
    <v-alert
      v-if="gcpKeyInfo"
      type="success"
      variant="tonal"
      density="compact"
      class="my-3"
      data-testid="gcp-key-info"
      >{{ t('credentials.gcp.keyInfo', gcpKeyInfo) }}</v-alert
    >
    <v-text-field
      v-model="gcpRegion"
      :label="t('credentials.gcp.region')"
      :rules="[zodRule(gcpShape.region)]"
      name="gcpRegion"
      data-testid="gcp-region"
    >
      <template #append-inner>
        <FieldHelp :text="t('credentials.gcp.regionHint')" />
      </template>
    </v-text-field>
  </div>
</template>

<style scoped>
/* The key is a secret: blur it until the field is focused. */
.secret-text :deep(textarea:not(:focus)) {
  filter: blur(4px);
}
</style>
