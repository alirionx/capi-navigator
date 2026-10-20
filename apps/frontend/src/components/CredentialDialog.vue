<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  CredentialNameSchema,
  type CreateCredentialRequest,
  type Credential,
  type CredentialProvider,
  type ManifestPreview,
} from '@capi-navigator/shared';
import { ApiError } from '../api/client.js';
import { fieldErrors, zodRule } from '../forms/zod-rules.js';
import { useCredentialsStore } from '../stores/credentials.js';
import ErrorAlert from './ErrorAlert.vue';
import { CREDENTIAL_FIELDS } from './credentials/index.js';
import YamlViewer from './YamlViewer.vue';

/** Create or edit OpenStack, AWS and Google Cloud credentials (FP4-F-01, FP4-F-07, FP25-F-02). */
const props = defineProps<{ provider: CredentialProvider; credential?: Credential | null }>();
const emit = defineEmits<{ close: []; saved: [Credential] }>();
const { t } = useI18n();
const store = useCredentialsStore();

const editing = computed(() => !!props.credential);
const step = ref<'form' | 'preview'>('form');
const name = ref(props.credential?.name ?? '');
const displayName = ref(props.credential?.displayName ?? '');
const namespaces = ref<string[]>(props.credential?.allowedNamespaces ?? ['default']);
const replaceSecret = ref(!props.credential);

/** Secret part from the provider's field component (FP25-F-05). */
const secret = ref<unknown>(null);

const valid = ref(false);
const busy = ref(false);
const error = ref<unknown>(null);
const preview = ref<ManifestPreview | null>(null);
const serverFieldErrors = computed(() =>
  error.value instanceof ApiError ? error.value.fieldErrors : undefined,
);
/** The secret part of the form, keyed by provider as the API expects it. */
const secretInput = () => ({ [props.provider]: secret.value });

function createRequest(): CreateCredentialRequest {
  const common = {
    name: name.value,
    allowedNamespaces: namespaces.value,
    ...(displayName.value ? { displayName: displayName.value } : {}),
  };
  return { provider: props.provider, ...common, ...secretInput() } as CreateCredentialRequest;
}

async function next(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    if (editing.value) {
      const saved = await store.update(props.credential!, {
        displayName: displayName.value,
        allowedNamespaces: namespaces.value,
        ...(replaceSecret.value ? secretInput() : {}),
      });
      emit('saved', saved);
    } else {
      preview.value = await store.preview(createRequest());
      step.value = 'preview';
    }
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    emit('saved', await store.create(createRequest()));
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-card>
    <v-card-title class="pt-4 px-6">
      {{
        editing
          ? t('credentials.editTitle', { name: credential?.name })
          : t(`credentials.addTitle.${provider}`)
      }}
    </v-card-title>

    <v-card-text v-if="step === 'form'">
      <v-form v-model="valid" @submit.prevent="next">
        <v-text-field
          v-if="!editing"
          v-model="name"
          :label="t('credentials.name')"
          :rules="[zodRule(CredentialNameSchema)]"
          :hint="t('credentials.nameHint')"
          persistent-hint
          :error-messages="fieldErrors(serverFieldErrors, 'name')"
          class="mb-2"
          name="name"
        />
        <v-text-field
          v-model="displayName"
          :label="t('credentials.displayName')"
          :hint="t('credentials.displayNameHint')"
          persistent-hint
          class="mb-2"
        />
        <v-combobox
          v-model="namespaces"
          :label="t('credentials.allowedNamespaces')"
          :hint="t(`credentials.allowedNamespacesHint.${provider}`)"
          persistent-hint
          multiple
          chips
          closable-chips
          class="mb-3"
          name="allowedNamespaces"
        />

        <v-switch
          v-if="editing"
          v-model="replaceSecret"
          :label="t('credentials.replaceSecret')"
          color="primary"
          density="compact"
          hide-details
          class="mb-2"
        />

        <component
          :is="CREDENTIAL_FIELDS[provider]"
          v-if="replaceSecret"
          v-model="secret"
          :credential="credential"
          :server-field-errors="serverFieldErrors"
        />

        <ErrorAlert v-if="error" :error="error" class="mt-3" />
      </v-form>
    </v-card-text>

    <v-card-text v-else-if="preview">
      <p class="mb-2">{{ t('credentials.previewText') }}</p>
      <YamlViewer :value="preview.yaml" height="300px" :filename="`credential-${name}.yaml`" />
      <ErrorAlert v-if="error" :error="error" class="mt-3" />
    </v-card-text>

    <v-card-actions class="px-6 pb-4">
      <v-btn
        v-if="step === 'preview'"
        variant="text"
        prepend-icon="mdi-arrow-left"
        @click="step = 'form'"
        >{{ t('common.back') }}</v-btn
      >
      <v-spacer />
      <v-btn variant="text" @click="emit('close')">{{ t('common.cancel') }}</v-btn>
      <v-btn
        v-if="step === 'form'"
        color="primary"
        variant="flat"
        :loading="busy"
        :disabled="!valid"
        data-testid="credential-next"
        @click="next"
      >
        {{ editing ? t('credentials.saveAndTest') : t('providers.showPreview') }}
      </v-btn>
      <v-btn
        v-else
        color="primary"
        variant="flat"
        :loading="busy"
        data-testid="credential-save"
        @click="save"
      >
        {{ t('credentials.saveAndTest') }}
      </v-btn>
    </v-card-actions>
  </v-card>
</template>
