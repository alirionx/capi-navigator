<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ConnectionNameSchema,
  CreateConnectionRequestSchema,
  type AuthType,
  type Connection,
  type ConnectionCredentials,
  type KubeconfigContexts,
} from '@capi-navigator/shared';
import { ApiError } from '../api/client.js';
import { fieldErrors, zodRule } from '../forms/zod-rules.js';
import { useConnectionsStore } from '../stores/connections.js';
import ErrorAlert from './ErrorAlert.vue';

/** Create or edit a management cluster connection (FP2-F-01). */
const props = defineProps<{ connection?: Connection | null }>();
const emit = defineEmits<{ close: []; saved: [Connection] }>();
const { t } = useI18n();
const store = useConnectionsStore();

const editing = computed(() => !!props.connection);
const name = ref(props.connection?.name ?? '');
const displayName = ref(props.connection?.displayName ?? '');
const replaceCredentials = ref(!props.connection);
const authType = ref<AuthType>(props.connection?.authType ?? 'kubeconfig');

const kubeconfig = ref('');
const kubeconfigFile = ref<File | File[] | null>(null);
const contexts = ref<KubeconfigContexts | null>(null);
const context = ref<string | null>(null);
const contextsError = ref<unknown>(null);

const server = ref('');
const token = ref('');
const caCert = ref('');
const caFile = ref<File | File[] | null>(null);
const showToken = ref(false);

const valid = ref(false);
const busy = ref(false);
const error = ref<unknown>(null);
const serverFieldErrors = computed(() =>
  error.value instanceof ApiError ? error.value.fieldErrors : undefined,
);

const tokenSchemas = CreateConnectionRequestSchema.shape.credentials.options[1].shape;
const required = (v: string) => !!v?.trim() || t('connections.required');

async function readFile(f: File | File[] | null): Promise<string | null> {
  const file = Array.isArray(f) ? f[0] : f;
  return file ? file.text() : null;
}

watch(kubeconfigFile, async (f) => {
  const text = await readFile(f);
  if (text !== null) kubeconfig.value = text;
});
watch(caFile, async (f) => {
  const text = await readFile(f);
  if (text !== null) caCert.value = text;
});

// Parse the kubeconfig in the backend to offer its contexts; no credentials come back.
let timer: ReturnType<typeof setTimeout> | undefined;
watch(kubeconfig, (text) => {
  clearTimeout(timer);
  contexts.value = null;
  contextsError.value = null;
  if (!text.trim()) return;
  timer = setTimeout(async () => {
    try {
      contexts.value = await store.contexts(text);
      context.value = contexts.value.currentContext ?? contexts.value.contexts[0]?.name ?? null;
    } catch (err) {
      contextsError.value = err;
    }
  }, 400);
});

const contextItems = computed(
  () =>
    contexts.value?.contexts.map((c) => ({ title: `${c.name} — ${c.server}`, value: c.name })) ??
    [],
);

function credentials(): ConnectionCredentials {
  switch (authType.value) {
    case 'kubeconfig':
      return {
        authType: 'kubeconfig',
        kubeconfig: kubeconfig.value,
        ...(context.value ? { context: context.value } : {}),
      };
    case 'token':
      return {
        authType: 'token',
        server: server.value.trim(),
        token: token.value.trim(),
        ...(caCert.value.trim() ? { caCert: caCert.value.trim() } : {}),
      };
    default:
      return { authType: 'in-cluster' };
  }
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const saved = editing.value
      ? await store.update(props.connection!.name, {
          displayName: displayName.value,
          ...(replaceCredentials.value ? { credentials: credentials() } : {}),
        })
      : await store.create({
          name: name.value,
          ...(displayName.value ? { displayName: displayName.value } : {}),
          credentials: credentials(),
        });
    emit('saved', saved);
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
        editing ? t('connections.editTitle', { name: connection?.name }) : t('connections.addTitle')
      }}
    </v-card-title>
    <v-card-text>
      <v-form v-model="valid" @submit.prevent="save">
        <v-text-field
          v-if="!editing"
          v-model="name"
          :label="t('connections.name')"
          :rules="[zodRule(ConnectionNameSchema)]"
          :hint="t('connections.nameHint')"
          persistent-hint
          :error-messages="fieldErrors(serverFieldErrors, 'name')"
          class="mb-2"
          name="name"
        />
        <v-text-field
          v-model="displayName"
          :label="t('connections.displayName')"
          :hint="t('connections.displayNameHint')"
          persistent-hint
          class="mb-2"
          name="displayName"
        />

        <v-switch
          v-if="editing"
          v-model="replaceCredentials"
          :label="t('connections.replaceCredentials')"
          :hint="t('connections.replaceCredentialsHint')"
          persistent-hint
          color="primary"
          class="mb-2"
        />

        <template v-if="replaceCredentials">
          <div class="text-title-small mt-2 mb-1">{{ t('connections.authType') }}</div>
          <v-btn-toggle
            v-model="authType"
            mandatory
            color="primary"
            variant="outlined"
            density="comfortable"
            class="mb-1"
          >
            <v-btn value="kubeconfig" data-testid="auth-kubeconfig">{{
              t('connections.auth.kubeconfig')
            }}</v-btn>
            <v-btn value="token" data-testid="auth-token">{{ t('connections.auth.token') }}</v-btn>
            <v-btn value="in-cluster" data-testid="auth-in-cluster">{{
              t('connections.auth.in-cluster')
            }}</v-btn>
          </v-btn-toggle>
          <div class="text-body-small text-medium-emphasis mb-4">
            {{ t(`connections.authHint.${authType}`) }}
          </div>

          <template v-if="authType === 'kubeconfig'">
            <v-file-input
              v-model="kubeconfigFile"
              :label="t('connections.kubeconfigFile')"
              prepend-icon="mdi-file-upload"
              density="comfortable"
              show-size
            />
            <v-textarea
              v-model="kubeconfig"
              :label="t('connections.kubeconfig')"
              :hint="t('connections.kubeconfigHint')"
              persistent-hint
              :rules="[required]"
              :error-messages="fieldErrors(serverFieldErrors, 'credentials.kubeconfig')"
              rows="5"
              class="font-monospace mb-2"
              name="kubeconfig"
            />
            <ErrorAlert v-if="contextsError" :error="contextsError" class="mb-2" />
            <v-select
              v-if="contexts"
              v-model="context"
              :items="contextItems"
              :label="t('connections.context')"
              :hint="t('connections.contextHint')"
              persistent-hint
              class="mb-2"
              name="context"
            />
          </template>

          <template v-else-if="authType === 'token'">
            <v-text-field
              v-model="server"
              :label="t('connections.server')"
              placeholder="https://203.0.113.10:6443"
              :rules="[zodRule(tokenSchemas.server)]"
              :hint="t('connections.serverHint')"
              persistent-hint
              :error-messages="fieldErrors(serverFieldErrors, 'credentials.server')"
              class="mb-2"
              name="server"
            />
            <v-text-field
              v-model="token"
              :label="t('connections.token')"
              :type="showToken ? 'text' : 'password'"
              :append-inner-icon="showToken ? 'mdi-eye-off' : 'mdi-eye'"
              :rules="[required]"
              :hint="t('connections.tokenHint')"
              persistent-hint
              autocomplete="off"
              :error-messages="fieldErrors(serverFieldErrors, 'credentials.token')"
              class="mb-2"
              name="token"
              @click:append-inner="showToken = !showToken"
            />
            <v-file-input
              v-model="caFile"
              :label="t('connections.caFile')"
              prepend-icon="mdi-certificate"
              density="comfortable"
            />
            <v-textarea
              v-model="caCert"
              :label="t('connections.caCert')"
              :hint="t('connections.caCertHint')"
              persistent-hint
              :rules="[zodRule(tokenSchemas.caCert)]"
              :error-messages="fieldErrors(serverFieldErrors, 'credentials.caCert')"
              rows="4"
              class="font-monospace"
              name="caCert"
            />
          </template>

          <v-alert v-else type="info" variant="tonal" density="comfortable">
            {{ t('connections.inClusterInfo') }}
          </v-alert>
        </template>

        <ErrorAlert v-if="error" :error="error" class="mt-4" />
      </v-form>
    </v-card-text>
    <v-card-actions class="px-6 pb-4">
      <v-spacer />
      <v-btn variant="text" @click="emit('close')">{{ t('common.cancel') }}</v-btn>
      <v-btn
        color="primary"
        variant="flat"
        :loading="busy"
        :disabled="!valid"
        data-testid="connection-save"
        @click="save"
      >
        {{ editing ? t('connections.saveAndTest') : t('connections.addAndTest') }}
      </v-btn>
    </v-card-actions>
  </v-card>
</template>
