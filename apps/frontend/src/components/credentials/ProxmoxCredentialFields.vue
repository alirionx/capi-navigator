<script setup lang="ts">
import { ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { ProxmoxCredentialInputSchema, type Credential } from '@capi-navigator/shared';
import { fieldErrors, zodRule } from '../../forms/zod-rules.js';

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
      :hint="t('credentials.proxmox.urlHint')"
      persistent-hint
      :error-messages="fieldErrors(serverFieldErrors, 'proxmox.url')"
      class="mb-2"
      data-testid="proxmox-url"
    />
    <v-text-field
      v-model="tokenId"
      :label="t('credentials.proxmox.tokenId')"
      :rules="[zodRule(shape.tokenId)]"
      :hint="t('credentials.proxmox.tokenIdHint')"
      persistent-hint
      :error-messages="fieldErrors(serverFieldErrors, 'proxmox.tokenId')"
      class="mb-2"
      data-testid="proxmox-token-id"
    />
    <v-text-field
      v-model="tokenSecret"
      :label="t('credentials.proxmox.tokenSecret')"
      :rules="[zodRule(shape.tokenSecret)]"
      :hint="t('credentials.proxmox.tokenSecretHint')"
      persistent-hint
      type="password"
      autocomplete="new-password"
      :error-messages="fieldErrors(serverFieldErrors, 'proxmox.tokenSecret')"
      class="mb-2"
      data-testid="proxmox-token-secret"
    />
    <v-file-input
      v-model="caFile"
      :label="t('credentials.proxmox.caFile')"
      accept=".pem,.crt"
      prepend-icon="mdi-certificate"
      show-size
      class="mb-1"
    />
    <v-textarea
      v-model="caCert"
      :label="t('credentials.proxmox.ca')"
      :hint="t('credentials.proxmox.caHint')"
      persistent-hint
      :rules="[zodRule(shape.caCert)]"
      :error-messages="fieldErrors(serverFieldErrors, 'proxmox.caCert')"
      rows="3"
      data-testid="proxmox-ca"
    />
  </div>
</template>
