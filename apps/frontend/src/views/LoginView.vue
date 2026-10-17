<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import ErrorAlert from '../components/ErrorAlert.vue';
import { useAuthStore } from '../stores/auth.js';

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const showPassword = ref(false);
const loading = ref(false);
const error = ref<unknown>(null);

async function submit(): Promise<void> {
  if (!username.value || !password.value) return;
  loading.value = true;
  error.value = null;
  try {
    const me = await auth.login({ username: username.value, password: password.value });
    password.value = '';
    if (me.mustChangePassword) {
      await router.replace({ name: 'change-password' });
    } else {
      const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
      await router.replace(redirect.startsWith('/') ? redirect : '/');
    }
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <v-container class="fill-height d-flex align-center justify-center">
    <v-card width="400" elevation="4">
      <v-card-title class="text-h5 pt-6 px-6">{{ t('app.title') }}</v-card-title>
      <v-card-subtitle class="px-6">{{ t('login.title') }}</v-card-subtitle>
      <v-form class="pa-6" @submit.prevent="submit">
        <v-text-field
          v-model="username"
          :label="t('login.username')"
          autocomplete="username"
          autofocus
          name="username"
          prepend-inner-icon="mdi-account"
        />
        <v-text-field
          v-model="password"
          :label="t('login.password')"
          :type="showPassword ? 'text' : 'password'"
          :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
          autocomplete="current-password"
          name="password"
          prepend-inner-icon="mdi-lock"
          @click:append-inner="showPassword = !showPassword"
        />
        <ErrorAlert v-if="error" :error="error" class="mb-4" />
        <v-btn
          type="submit"
          color="primary"
          block
          size="large"
          :loading="loading"
          :disabled="!username || !password"
        >
          {{ t('login.submit') }}
        </v-btn>
      </v-form>
    </v-card>
  </v-container>
</template>
