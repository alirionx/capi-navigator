<script setup lang="ts">
import { AuthOptionsSchema, type AuthOptions } from '@capi-navigator/shared';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import AppLogo from '../components/AppLogo.vue';
import { getJson } from '../api/client.js';
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
const options = ref<AuthOptions>({ oidc: null });

const redirect = computed(() =>
  typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
    ? route.query.redirect
    : '/',
);
/** FP14-F-07: the backend runs the OpenID Connect flow; the browser only navigates there. */
const oidcHref = computed(
  () => `/api/auth/oidc/login?redirect=${encodeURIComponent(redirect.value)}`,
);
/** Result of a failed OpenID Connect sign-in, from the callback redirect. */
const oidcError = computed(() => {
  const code = route.query.error;
  return code === 'oidc_failed' || code === 'oidc_no_access' || code === 'oidc_cancelled'
    ? t(`login.${code}`)
    : null;
});

onMounted(async () => {
  try {
    options.value = await getJson('/api/auth/options', AuthOptionsSchema);
  } catch {
    // Without the options the local form still works.
  }
});

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
      await router.replace(redirect.value);
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
    <v-card width="400" border>
      <div class="d-flex align-center ga-3 pt-6 px-6">
        <AppLogo :size="42" />
        <div>
          <div class="brand-title">{{ t('app.title') }}</div>
          <div class="text-body-2 text-medium-emphasis">{{ t('login.title') }}</div>
        </div>
      </div>
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
        <template v-if="options.oidc">
          <div class="d-flex align-center ga-3 my-4 text-medium-emphasis text-body-2">
            <v-divider />{{ t('login.or') }}<v-divider />
          </div>
          <v-alert
            v-if="oidcError"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-4"
            data-testid="oidc-error"
            >{{ oidcError }}</v-alert
          >
          <v-btn
            :href="oidcHref"
            variant="tonal"
            block
            size="large"
            prepend-icon="mdi-shield-account"
            data-testid="oidc-sign-in"
            >{{ options.oidc.label }}</v-btn
          >
        </template>
      </v-form>
    </v-card>
  </v-container>
</template>

<style scoped>
.brand-title {
  font-weight: 800;
  font-size: 1.3rem;
  line-height: 1.1;
}
</style>
