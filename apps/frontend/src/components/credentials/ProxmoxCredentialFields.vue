<script setup lang="ts">
import { ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { ProxmoxCredentialInputSchema, type Credential } from '@capi-navigator/shared';
import { fieldErrors, zodRule } from '../../forms/zod-rules.js';
import FieldHelp from '../FieldHelp.vue';

/** Secret part of Proxmox VE credentials: API URL, token and its CA (FP31-F-02). */
const input = defineModel<unknown>({ required: true });
const props = defineProps<{
  credential?: Credential | null;
  serverFieldErrors?: Record<string, string[]>;
}>();
const { t } = useI18n();
const shape = ProxmoxCredentialInputSchema.shape;

const url = ref(props.credential?.summary.url ?? '');
const tokenId = ref(props.credential?.summary.tokenId ?? '');
const tokenSecret = ref('');
const caCert = ref('');
const caFile = ref<File | File[] | null>(null);
watch(caFile, async (f) => {
  const file = Array.isArray(f) ? f[0] : f;
  if (file) caCert.value = await file.text();
});

watchEffect(() => {
  input.value = {
    url: url.value.trim(),
    tokenId: tokenId.value.trim(),
    tokenSecret: tokenSecret.value.trim(),
    ...(caCert.value.trim() ? { caCert: caCert.value.trim() } : {}),
  };
});
</script>

<template>
  <div>
    <v-alert type="info" variant="tonal" density="compact" class="mb-3">{{
      t('credentials.proxmox.recommend')
    }}</v-alert>
    <v-text-field
      v-model="url"
      :label="t('credentials.proxmox.url')"
      :rules="[zodRule(shape.url)]"
      :error-messages="fieldErrors(serverFieldErrors, 'proxmox.url')"
      data-testid="proxmox-url"
    >
      <template #append-inner>
        <FieldHelp :text="t('credentials.proxmox.urlHint')" />
      </template>
    </v-text-field>
    <v-text-field
      v-model="tokenId"
      :label="t('credentials.proxmox.tokenId')"
      :rules="[zodRule(shape.tokenId)]"
      :error-messages="fieldErrors(serverFieldErrors, 'proxmox.tokenId')"
      data-testid="proxmox-token-id"
    >
      <template #append-inner>
        <FieldHelp :text="t('credentials.proxmox.tokenIdHint')" />
      </template>
    </v-text-field>
    <v-text-field
      v-model="tokenSecret"
      :label="t('credentials.proxmox.tokenSecret')"
      :rules="[zodRule(shape.tokenSecret)]"
      type="password"
      autocomplete="new-password"
      :error-messages="fieldErrors(serverFieldErrors, 'proxmox.tokenSecret')"
      data-testid="proxmox-token-secret"
    >
      <template #append-inner>
        <FieldHelp :text="t('credentials.proxmox.tokenSecretHint')" />
      </template>
    </v-text-field>
    <v-file-input
      v-model="caFile"
      :label="t('credentials.proxmox.caFile')"
      accept=".pem,.crt"
      prepend-icon="mdi-certificate"
      show-size
    />
    <v-textarea
      v-model="caCert"
      :label="t('credentials.proxmox.ca')"
      :rules="[zodRule(shape.caCert)]"
      :error-messages="fieldErrors(serverFieldErrors, 'proxmox.caCert')"
      rows="3"
      data-testid="proxmox-ca"
    >
      <template #append-inner>
        <FieldHelp :text="t('credentials.proxmox.caHint')" />
      </template>
    </v-textarea>
  </div>
</template>
