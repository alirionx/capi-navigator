<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { API_TOKEN_MAX_DAYS, TokenNameSchema, type TokenInfo } from '@capi-navigator/shared';
import { ApiError } from '../../api/client.js';
import { fieldErrors, zodRule } from '../../forms/zod-rules.js';
import { useTokensStore } from '../../stores/tokens.js';
import ErrorAlert from '../ErrorAlert.vue';
import FieldHelp from '../FieldHelp.vue';

/**
 * API tokens of a technical user (FP22-F-02, FP22-F-03): list, generate (shown exactly once) and
 * revoke. The token value lives only in this component until the dialog closes.
 */
const props = defineProps<{ username: string }>();
const open = defineModel<boolean>({ required: true });
const { t, d } = useI18n();
const store = useTokensStore();

const error = ref<unknown>(null);
const busy = ref(false);
const valid = ref(false);
const formRef = ref<{ resetValidation(): void } | null>(null);
const form = ref({ name: '', description: '', expiresInDays: 90 });
/** The generated token: shown once, dropped when the dialog closes. */
const created = ref<{ name: string; token: string } | null>(null);
const copied = ref(false);
const revoking = ref<TokenInfo | null>(null);

const serverFieldErrors = computed(() =>
  error.value instanceof ApiError ? error.value.fieldErrors : undefined,
);
const headers = computed(() => [
  { title: t('tokens.name'), key: 'name' },
  { title: t('tokens.expires'), key: 'expiresAt' },
  { title: t('tokens.lastUsed'), key: 'lastUsedAt' },
  { title: t('tokens.createdBy'), key: 'createdBy' },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
]);
const when = (iso?: string) => (iso ? d(new Date(iso), 'short') : t('tokens.never'));

watch(
  open,
  async (isOpen) => {
    created.value = null;
    copied.value = false;
    error.value = null;
    revoking.value = null;
    form.value = { name: '', description: '', expiresInDays: 90 };
    if (!isOpen) return;
    try {
      await store.load(props.username);
    } catch (err) {
      error.value = err;
    }
  },
  { immediate: true },
);

async function generate(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const result = await store.create(props.username, {
      name: form.value.name,
      ...(form.value.description.trim() ? { description: form.value.description } : {}),
      expiresInDays: Number(form.value.expiresInDays),
    });
    created.value = { name: result.name, token: result.token };
    form.value = { name: '', description: '', expiresInDays: 90 };
    // An emptied form is not an input error (after Vue has applied the emptied values).
    await nextTick();
    formRef.value?.resetValidation();
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}

async function copy(): Promise<void> {
  if (!created.value) return;
  await navigator.clipboard.writeText(created.value.token);
  copied.value = true;
}

async function revoke(): Promise<void> {
  if (!revoking.value) return;
  busy.value = true;
  error.value = null;
  try {
    await store.revoke(props.username, revoking.value.id);
    revoking.value = null;
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="820">
    <v-card data-testid="tokens-dialog">
      <v-card-title class="pt-4 px-6">{{ t('tokens.title', { username }) }}</v-card-title>
      <v-card-text>
        <p class="text-body-medium text-medium-emphasis mb-4">{{ t('tokens.intro') }}</p>

        <v-alert
          v-if="created"
          type="success"
          variant="tonal"
          class="mb-4"
          data-testid="token-created"
        >
          <div class="font-weight-medium mb-2">
            {{ t('tokens.createdTitle', { name: created.name }) }}
          </div>
          <div class="text-body-medium mb-2">{{ t('tokens.createdOnce') }}</div>
          <div class="d-flex align-center ga-2">
            <code class="token-value pa-2 flex-grow-1" data-testid="token-value">{{
              created.token
            }}</code>
            <v-btn
              :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'"
              variant="tonal"
              data-testid="token-copy"
              @click="copy"
              >{{ copied ? t('tokens.copied') : t('tokens.copy') }}</v-btn
            >
          </div>
          <div class="text-body-small mt-2">
            {{ t('tokens.usage') }} <code>Authorization: Bearer capin_…</code>
          </div>
        </v-alert>

        <v-data-table
          :headers="headers"
          :items="store.tokens"
          :loading="store.loading"
          :no-data-text="t('tokens.empty')"
          density="compact"
          class="mb-4"
          data-testid="tokens-table"
        >
          <template #[`item.name`]="{ item }">
            <div class="font-weight-medium">{{ item.name }}</div>
            <div v-if="item.description" class="text-body-small text-medium-emphasis">
              {{ item.description }}
            </div>
          </template>
          <template #[`item.expiresAt`]="{ item }">
            <v-chip v-if="item.expired" size="x-small" color="error" variant="tonal">{{
              t('tokens.expired')
            }}</v-chip>
            <span v-else>{{ when(item.expiresAt) }}</span>
          </template>
          <template #[`item.lastUsedAt`]="{ item }">{{ when(item.lastUsedAt) }}</template>
          <template #[`item.actions`]="{ item }">
            <v-btn
              icon="mdi-key-remove"
              size="small"
              variant="text"
              color="error"
              :title="t('tokens.revoke')"
              :aria-label="t('tokens.revoke')"
              :data-testid="`token-revoke-${item.name}`"
              @click="revoking = item"
            />
          </template>
        </v-data-table>

        <v-alert v-if="revoking" type="warning" variant="tonal" class="mb-4">
          <div class="mb-2">{{ t('tokens.revokeText', { name: revoking.name }) }}</div>
          <v-btn
            color="error"
            variant="flat"
            :loading="busy"
            data-testid="token-revoke-confirm"
            @click="revoke"
            >{{ t('tokens.revoke') }}</v-btn
          >
          <v-btn variant="text" class="ml-2" @click="revoking = null">{{
            t('common.cancel')
          }}</v-btn>
        </v-alert>

        <div class="text-title-small mb-2">{{ t('tokens.generate') }}</div>
        <v-form ref="formRef" v-model="valid" @submit.prevent="generate">
          <div class="d-flex flex-wrap ga-3">
            <v-text-field
              v-model="form.name"
              :label="t('tokens.name')"
              :rules="[zodRule(TokenNameSchema)]"
              :error-messages="fieldErrors(serverFieldErrors, 'name')"
              style="min-width: 200px"
              data-testid="token-name"
            >
              <template #append-inner>
                <FieldHelp :text="t('tokens.nameHint')" />
              </template>
            </v-text-field>
            <v-text-field
              v-model.number="form.expiresInDays"
              type="number"
              :min="1"
              :max="API_TOKEN_MAX_DAYS"
              :label="t('tokens.days')"
              :error-messages="fieldErrors(serverFieldErrors, 'expiresInDays')"
              style="max-width: 200px"
              data-testid="token-days"
            >
              <template #append-inner>
                <FieldHelp :text="t('tokens.daysHint', { max: API_TOKEN_MAX_DAYS })" />
              </template>
            </v-text-field>
          </div>
          <v-text-field v-model="form.description" :label="t('tokens.description')" class="mt-2">
            <template #append-inner>
              <FieldHelp :text="t('tokens.descriptionHint')" />
            </template>
          </v-text-field>
        </v-form>
        <ErrorAlert v-if="error" :error="error" class="mt-4" />
      </v-card-text>
      <v-card-actions class="px-6 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="open = false">{{ t('common.close') }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-key-plus"
          :loading="busy"
          :disabled="!valid"
          data-testid="token-generate"
          @click="generate"
          >{{ t('tokens.generate') }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.token-value {
  word-break: break-all;
  background: rgba(var(--v-theme-on-surface), 0.06);
  border-radius: 4px;
  font-size: 0.85rem;
}
</style>
