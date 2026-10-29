<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { OidcSettingsSchema, type OidcSettings, type OidcTestResult } from '@capi-navigator/shared';
import { ApiError } from '../api/client.js';
import ErrorAlert from '../components/ErrorAlert.vue';
import { fieldErrors, zodRule } from '../forms/zod-rules.js';
import { useAuthSettingsStore } from '../stores/authSettings.js';
import { useRolesStore } from '../stores/roles.js';

/**
 * Authentication page (FP14-F-12, ADR-0020): the OpenID Connect provider, tested before saving,
 * with a preview of the change. The client secret is write-only (FP14-F-14).
 */
const { t } = useI18n();
const store = useAuthSettingsStore();
const roles = useRolesStore();

const loadError = ref<unknown>(null);
const saveError = ref<unknown>(null);
const valid = ref(false);
const saving = ref(false);
const saved = ref(false);
const testing = ref(false);
const testResult = ref<OidcTestResult | null>(null);
const confirmOpen = ref(false);

const defaults = (): OidcSettings =>
  OidcSettingsSchema.parse({ issuerUrl: 'https://x.invalid', clientId: 'x' });
const form = ref<OidcSettings & { clientSecret: string }>({
  ...defaults(),
  issuerUrl: '',
  clientId: '',
  clientSecret: '',
});

function reset(): void {
  const s = store.settings?.oidc;
  form.value = s
    ? { ...JSON.parse(JSON.stringify(s)), clientSecret: '' }
    : { ...defaults(), issuerUrl: '', clientId: '', clientSecret: '' };
  delete (form.value as { secretSet?: boolean }).secretSet;
}

onMounted(async () => {
  try {
    await Promise.all([store.load(), roles.load()]);
    reset();
  } catch (err) {
    loadError.value = err;
  }
});

const stored = computed(() => store.settings?.oidc ?? null);
const publicUrlMissing = computed(() => store.settings !== null && !store.settings.publicUrl);
const roleItems = computed(() => [
  { title: t('authSettings.noDefaultRole'), value: '' },
  ...roles.roles.map((r) => ({
    title: r.builtin ? t(`roles.${r.name}`) : r.displayName,
    value: r.name,
  })),
]);
const serverFieldErrors = computed(() =>
  saveError.value instanceof ApiError ? saveError.value.fieldErrors : undefined,
);

/** Changed fields for the preview (hard rule 6); the secret only as "replaced". */
const FIELDS = [
  'enabled',
  'issuerUrl',
  'clientId',
  'scopes',
  'groupsClaim',
  'usernameClaim',
  'buttonLabel',
  'defaultRole',
] as const;
const changes = computed(() => {
  const before = stored.value;
  const rows = FIELDS.filter((f) => !before || before[f] !== form.value[f]).map((f) => ({
    field: t(`authSettings.fields.${f}`),
    before: before ? String(before[f]) : '–',
    after: String(form.value[f]),
  }));
  if (form.value.clientSecret) {
    rows.push({
      field: t('authSettings.fields.clientSecret'),
      before: stored.value?.secretSet ? '••••' : '–',
      after: t('authSettings.secretReplaced'),
    });
  }
  return rows;
});

async function runTest(): Promise<void> {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await store.test(form.value.issuerUrl);
  } catch (err) {
    testResult.value = { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    testing.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  saveError.value = null;
  saved.value = false;
  const { clientSecret, ...settings } = form.value;
  try {
    await store.save({ ...settings, ...(clientSecret ? { clientSecret } : {}) });
    confirmOpen.value = false;
    saved.value = true;
    reset();
  } catch (err) {
    saveError.value = err;
    confirmOpen.value = false;
  } finally {
    saving.value = false;
  }
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text);
}
</script>

<template>
  <v-container class="settings">
    <h1 class="page-title">{{ t('authSettings.title') }}</h1>
    <p class="text-body-medium text-medium-emphasis mt-1 mb-4">{{ t('authSettings.subtitle') }}</p>

    <ErrorAlert v-if="loadError" :error="loadError" class="mb-4" />
    <v-alert
      v-if="publicUrlMissing"
      type="warning"
      variant="tonal"
      class="mb-4"
      data-testid="public-url-missing"
      >{{ t('authSettings.publicUrlMissing') }}</v-alert
    >

    <v-card v-if="store.settings" border class="pa-6" data-testid="auth-settings">
      <v-form v-model="valid" @submit.prevent="confirmOpen = true">
        <v-switch
          v-model="form.enabled"
          color="primary"
          :label="t('authSettings.enabled')"
          :hint="t('authSettings.enabledHint')"
          persistent-hint
          :disabled="publicUrlMissing"
          class="mb-4"
          data-testid="oidc-enabled"
        />

        <div v-if="store.settings.redirectUri" class="mb-6">
          <div class="text-title-small">{{ t('authSettings.redirectUri') }}</div>
          <div class="d-flex align-center ga-2">
            <code data-testid="redirect-uri">{{ store.settings.redirectUri }}</code>
            <v-btn
              icon="mdi-content-copy"
              size="small"
              variant="text"
              :aria-label="t('common.copy')"
              @click="copy(store.settings.redirectUri)"
            />
          </div>
          <div class="text-body-small text-medium-emphasis">
            {{ t('authSettings.redirectUriHint') }}
          </div>
        </div>

        <div class="d-flex ga-2 align-start">
          <v-text-field
            v-model="form.issuerUrl"
            :label="t('authSettings.fields.issuerUrl')"
            :hint="t('authSettings.issuerUrlHint')"
            persistent-hint
            :rules="[zodRule(OidcSettingsSchema.shape.issuerUrl)]"
            :error-messages="fieldErrors(serverFieldErrors, 'issuerUrl')"
            data-testid="oidc-issuer"
          />
          <v-btn
            variant="tonal"
            class="mt-2"
            prepend-icon="mdi-connection"
            :loading="testing"
            :disabled="!form.issuerUrl"
            data-testid="oidc-test"
            @click="runTest"
            >{{ t('authSettings.test') }}</v-btn
          >
        </div>
        <v-alert
          v-if="testResult"
          :type="testResult.ok ? 'success' : 'error'"
          variant="tonal"
          density="compact"
          class="my-3"
          data-testid="oidc-test-result"
        >
          <template v-if="testResult.ok">
            <div>{{ t('authSettings.testOk', { issuer: testResult.issuer }) }}</div>
            <div class="text-body-small">
              {{ t('authSettings.testScopes') }}:
              {{ testResult.scopesSupported?.join(' ') || '–' }}
            </div>
            <div class="text-body-small">
              {{ t('authSettings.testLogout') }}:
              {{ testResult.endSessionEndpoint ? t('common.yes') : t('common.no') }}
            </div>
          </template>
          <template v-else>{{ testResult.message }}</template>
        </v-alert>

        <v-row class="mt-2">
          <v-col cols="12" md="6">
            <v-text-field
              v-model="form.clientId"
              :label="t('authSettings.fields.clientId')"
              :rules="[zodRule(OidcSettingsSchema.shape.clientId)]"
              data-testid="oidc-client-id"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="form.clientSecret"
              :label="t('authSettings.fields.clientSecret')"
              type="password"
              autocomplete="new-password"
              :placeholder="stored?.secretSet ? '••••••••' : ''"
              persistent-placeholder
              :hint="
                stored?.secretSet ? t('authSettings.secretSetHint') : t('authSettings.secretHint')
              "
              persistent-hint
              :error-messages="fieldErrors(serverFieldErrors, 'clientSecret')"
              data-testid="oidc-client-secret"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="form.scopes"
              :label="t('authSettings.fields.scopes')"
              :hint="t('authSettings.scopesHint')"
              persistent-hint
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="form.groupsClaim"
              :label="t('authSettings.fields.groupsClaim')"
              :hint="t('authSettings.groupsClaimHint')"
              persistent-hint
              :rules="[zodRule(OidcSettingsSchema.shape.groupsClaim)]"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="form.usernameClaim"
              :label="t('authSettings.fields.usernameClaim')"
              :hint="t('authSettings.usernameClaimHint')"
              persistent-hint
              :rules="[zodRule(OidcSettingsSchema.shape.usernameClaim)]"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="form.buttonLabel"
              :label="t('authSettings.fields.buttonLabel')"
              :hint="t('authSettings.buttonLabelHint')"
              persistent-hint
              :rules="[zodRule(OidcSettingsSchema.shape.buttonLabel)]"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="form.defaultRole"
              :items="roleItems"
              :label="t('authSettings.fields.defaultRole')"
              :hint="t('authSettings.defaultRoleHint')"
              persistent-hint
              :error-messages="fieldErrors(serverFieldErrors, 'defaultRole')"
              data-testid="oidc-default-role"
            />
          </v-col>
        </v-row>

        <ErrorAlert v-if="saveError" :error="saveError" class="mt-4" />
        <v-alert
          v-if="saved"
          type="success"
          variant="tonal"
          density="compact"
          class="mt-4"
          data-testid="oidc-saved"
          >{{ t('authSettings.saved') }}</v-alert
        >
        <div class="d-flex mt-6">
          <v-spacer />
          <v-btn variant="text" :disabled="saving" @click="reset">{{ t('common.reset') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!valid || changes.length === 0"
            data-testid="oidc-preview"
            @click="confirmOpen = true"
            >{{ t('authSettings.preview') }}</v-btn
          >
        </div>
      </v-form>
    </v-card>

    <v-dialog v-model="confirmOpen" max-width="720">
      <v-card :title="t('authSettings.confirmTitle')" data-testid="oidc-confirm">
        <v-card-text>
          <v-table density="compact">
            <thead>
              <tr>
                <th>{{ t('authSettings.field') }}</th>
                <th>{{ t('authSettings.before') }}</th>
                <th>{{ t('authSettings.after') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in changes" :key="c.field">
                <td>{{ c.field }}</td>
                <td class="text-medium-emphasis">{{ c.before }}</td>
                <td>{{ c.after }}</td>
              </tr>
            </tbody>
          </v-table>
          <p class="text-body-small text-medium-emphasis mt-3">
            {{ t('authSettings.confirmText') }}
          </p>
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="confirmOpen = false">{{ t('common.cancel') }}</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="saving"
            data-testid="oidc-save"
            @click="save"
            >{{ t('common.save') }}</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<style scoped>
.settings {
  max-width: 1000px;
}
code {
  font-size: 0.9rem;
  word-break: break-all;
}
</style>
