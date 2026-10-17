<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { PASSWORD_MIN_LENGTH, PasswordSchema } from '@capi-navigator/shared';
import { ApiError } from '../api/client.js';
import ErrorAlert from '../components/ErrorAlert.vue';
import { fieldErrors, zodRule } from '../forms/zod-rules.js';
import { useAuthStore } from '../stores/auth.js';

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();

const current = ref('');
const next = ref('');
const confirm = ref('');
const valid = ref(false);
const loading = ref(false);
const error = ref<unknown>(null);
const done = ref(false);
const form = ref<{ resetValidation: () => void } | null>(null);

const forced = computed(() => auth.me?.mustChangePassword ?? false);
const serverFieldErrors = computed(() =>
  error.value instanceof ApiError ? error.value.fieldErrors : undefined,
);
const confirmRule = (v: string) => v === next.value || t('changePassword.mismatch');

async function submit(): Promise<void> {
  if (!valid.value) return;
  loading.value = true;
  error.value = null;
  const wasForced = forced.value;
  try {
    await auth.changePassword({ currentPassword: current.value, newPassword: next.value });
    current.value = next.value = confirm.value = '';
    form.value?.resetValidation();
    // After the forced change at first sign-in, continue into the app.
    if (wasForced) await router.replace({ name: 'home' });
    else done.value = true;
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <v-container class="d-flex justify-center">
    <v-card width="480" class="mt-8" border>
      <v-card-title class="page-title pt-6 px-6">{{ t('changePassword.title') }}</v-card-title>
      <v-card-text>
        <v-alert v-if="forced" type="info" variant="tonal" class="mb-4">
          {{ t('changePassword.required') }}
        </v-alert>
        <v-alert v-if="done" type="success" variant="tonal" class="mb-4">
          {{ t('changePassword.done') }}
        </v-alert>
        <v-form ref="form" v-model="valid" @submit.prevent="submit">
          <v-text-field
            v-model="current"
            :label="t('changePassword.current')"
            type="password"
            autocomplete="current-password"
            :error-messages="fieldErrors(serverFieldErrors, 'currentPassword')"
            name="current-password"
          />
          <v-text-field
            v-model="next"
            :label="t('changePassword.new')"
            type="password"
            autocomplete="new-password"
            :rules="[zodRule(PasswordSchema)]"
            :hint="t('changePassword.newHint', { min: PASSWORD_MIN_LENGTH })"
            persistent-hint
            :error-messages="fieldErrors(serverFieldErrors, 'newPassword')"
            name="new-password"
          />
          <v-text-field
            v-model="confirm"
            :label="t('changePassword.confirm')"
            type="password"
            autocomplete="new-password"
            :rules="[confirmRule]"
            class="mt-2"
            name="confirm-password"
          />
          <ErrorAlert v-if="error" :error="error" class="mb-4" />
          <v-btn
            type="submit"
            color="primary"
            block
            :loading="loading"
            :disabled="!valid || !current"
          >
            {{ t('changePassword.submit') }}
          </v-btn>
        </v-form>
      </v-card-text>
    </v-card>
  </v-container>
</template>
