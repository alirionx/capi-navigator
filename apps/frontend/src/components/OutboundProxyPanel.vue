<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  catalogEntry,
  OutboundProxySchema,
  type InstalledProvider,
  type OutboundProxy,
} from '@capi-navigator/shared';
import { ApiError } from '../api/client.js';
import { fieldErrors, zodRule } from '../forms/zod-rules.js';
import { useAuthStore } from '../stores/auth.js';
import { useConnectionsStore } from '../stores/connections.js';
import ErrorAlert from './ErrorAlert.vue';
import { providersWithoutProxy } from './outbound-proxy.js';
import FieldHelp from './FieldHelp.vue';

/**
 * Outbound proxy of the active management cluster for provider controllers that need the
 * internet, e.g. CAAPH for Helm repositories (FP-29). Admins change it; providers pick it up on
 * their next install or update.
 */
const props = defineProps<{ providers: InstalledProvider[] }>();
const { t } = useI18n();
const auth = useAuthStore();
const connections = useConnectionsStore();
const isAdmin = computed(() => auth.can('connections.manage'));

const proxy = computed(() => connections.active?.outboundProxy);
const outdated = computed(() => props.providers.filter((p) => p.outboundProxy === 'outdated'));
const withoutProxy = computed(() => (proxy.value ? providersWithoutProxy(props.providers) : []));
const displayName = (p: InstalledProvider) =>
  (p.catalogId && catalogEntry(p.catalogId)?.displayName) || p.name;

const shape = OutboundProxySchema.shape;
const editOpen = ref(false);
const valid = ref(false);
const form = ref({ httpsProxy: '', httpProxy: '', noProxy: '', caCert: '' });
const saving = ref(false);
const saveError = ref<unknown>(null);
const serverFieldErrors = computed(() =>
  saveError.value instanceof ApiError ? saveError.value.fieldErrors : undefined,
);

function edit(): void {
  form.value = {
    httpsProxy: proxy.value?.httpsProxy ?? '',
    httpProxy: proxy.value?.httpProxy ?? '',
    noProxy: proxy.value?.noProxy ?? '',
    caCert: proxy.value?.caCert ?? '',
  };
  saveError.value = null;
  editOpen.value = true;
}

async function save(settings: OutboundProxy | null): Promise<void> {
  saving.value = true;
  saveError.value = null;
  try {
    await connections.update(connections.activeName!, { outboundProxy: settings });
    editOpen.value = false;
  } catch (err) {
    saveError.value = err;
  } finally {
    saving.value = false;
  }
}

function submit(): Promise<void> {
  const f = form.value;
  const noProxy = f.noProxy.replace(/\s+/g, '');
  return save({
    httpsProxy: f.httpsProxy.trim(),
    ...(f.httpProxy.trim() ? { httpProxy: f.httpProxy.trim() } : {}),
    ...(noProxy ? { noProxy } : {}),
    ...(f.caCert.trim() ? { caCert: f.caCert.trim() } : {}),
  });
}
</script>

<template>
  <v-card border class="mb-6" data-testid="outbound-proxy-panel">
    <v-card-item>
      <v-card-title class="text-body-large">{{ t('providers.proxy.title') }}</v-card-title>
      <v-card-subtitle>{{ t('providers.proxy.subtitle') }}</v-card-subtitle>
      <template #append>
        <v-btn
          v-if="isAdmin"
          size="small"
          variant="text"
          prepend-icon="mdi-pencil"
          data-testid="edit-outbound-proxy"
          @click="edit"
          >{{ t('providers.proxy.change') }}</v-btn
        >
      </template>
    </v-card-item>
    <v-card-text>
      <div v-if="!proxy" class="text-body-medium text-medium-emphasis">
        {{ t('providers.proxy.none') }}
      </div>
      <v-table v-else density="compact" class="proxy-table">
        <tbody>
          <tr>
            <td>{{ t('providers.proxy.httpsProxy') }}</td>
            <td class="mono">{{ proxy.httpsProxy }}</td>
          </tr>
          <tr>
            <td>{{ t('providers.proxy.httpProxy') }}</td>
            <td class="mono">{{ proxy.httpProxy ?? proxy.httpsProxy }}</td>
          </tr>
          <tr>
            <td>{{ t('providers.proxy.noProxy') }}</td>
            <td class="mono">{{ proxy.noProxy || '–' }}</td>
          </tr>
          <tr>
            <td>{{ t('providers.proxy.caCert') }}</td>
            <td>{{ proxy.caCert ? t('providers.proxy.caSet') : '–' }}</td>
          </tr>
        </tbody>
      </v-table>
      <v-alert
        v-if="withoutProxy.length"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-3"
        data-testid="outbound-proxy-unused"
      >
        {{ t('providers.proxy.unusedHint', { names: withoutProxy.map(displayName).join(', ') }) }}
      </v-alert>
      <v-alert
        v-if="outdated.length"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-3"
        data-testid="outbound-proxy-outdated"
      >
        {{ t('providers.proxy.outdatedHint', { names: outdated.map(displayName).join(', ') }) }}
      </v-alert>
    </v-card-text>
  </v-card>

  <v-dialog v-model="editOpen" max-width="680">
    <v-card :title="t('providers.proxy.editTitle')">
      <v-card-text>
        <p class="text-body-medium mb-4">{{ t('providers.proxy.editInfo') }}</p>
        <v-form v-model="valid" @submit.prevent="submit">
          <v-text-field
            v-model="form.httpsProxy"
            :label="t('providers.proxy.httpsProxy')"
            placeholder="http://proxy.example.com:3128"
            :rules="[zodRule(shape.httpsProxy)]"
            :error-messages="fieldErrors(serverFieldErrors, 'outboundProxy.httpsProxy')"
            data-testid="proxy-https"
          >
            <template #append-inner>
              <span class="text-body-small text-medium-emphasis">HTTPS_PROXY</span>
              <FieldHelp :text="t('providers.proxy.httpsProxyHint')" />
            </template>
          </v-text-field>
          <v-text-field
            v-model="form.httpProxy"
            :label="t('providers.proxy.httpProxy')"
            :rules="[(v: string) => !v.trim() || zodRule(shape.httpsProxy)(v.trim())]"
          >
            <template #append-inner>
              <span class="text-body-small text-medium-emphasis">HTTP_PROXY</span>
              <FieldHelp :text="t('providers.proxy.httpProxyHint')" />
            </template>
          </v-text-field>
          <v-textarea
            v-model="form.noProxy"
            :label="t('providers.proxy.noProxy')"
            rows="2"
            auto-grow
            placeholder="10.20.0.0/24,.example.internal"
            class="mono-input"
            data-testid="proxy-no-proxy"
          >
            <template #append-inner>
              <FieldHelp :text="t('providers.proxy.noProxyHint')" />
            </template>
          </v-textarea>
          <v-textarea
            v-model="form.caCert"
            :label="t('providers.proxy.caCert')"
            rows="3"
            placeholder="-----BEGIN CERTIFICATE-----"
            :rules="[zodRule(shape.caCert)]"
            class="mono-input"
            data-testid="proxy-ca"
          >
            <template #append-inner>
              <FieldHelp :text="t('providers.proxy.caCertHint')" />
            </template>
          </v-textarea>
        </v-form>
        <ErrorAlert v-if="saveError" :error="saveError" class="mt-3" />
      </v-card-text>
      <v-card-actions>
        <v-btn
          v-if="proxy"
          color="error"
          variant="text"
          :loading="saving"
          data-testid="remove-outbound-proxy"
          @click="save(null)"
          >{{ t('providers.proxy.remove') }}</v-btn
        >
        <v-spacer />
        <v-btn variant="text" @click="editOpen = false">{{ t('common.cancel') }}</v-btn>
        <v-btn
          color="primary"
          :loading="saving"
          :disabled="!valid"
          data-testid="save-outbound-proxy"
          @click="submit"
          >{{ t('common.save') }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.mono,
.mono-input :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
}
.proxy-table td:first-child {
  width: 180px;
  color: rgb(var(--v-theme-on-surface), 0.7);
}
.mono {
  word-break: break-all;
}
</style>
