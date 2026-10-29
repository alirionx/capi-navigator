<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  catalogEntry,
  ProviderInstallRequestSchema,
  type InstalledProvider,
  type ManifestPreview,
  type ProviderCatalogEntry,
} from '@capi-navigator/shared';
import { ApiError } from '../api/client.js';
import { fieldErrors, zodRule } from '../forms/zod-rules.js';
import { useConnectionsStore } from '../stores/connections.js';
import { useOperatorStore } from '../stores/operator.js';
import ErrorAlert from './ErrorAlert.vue';
import { proxySwitchDefault } from './outbound-proxy.js';
import YamlViewer from './YamlViewer.vue';

/**
 * Install (FP3-F-09) or upgrade/configure (FP3-F-12) a provider. Two steps: form, then the
 * generated YAML as preview; applied only after confirmation (FP3-F-10, hard rule 6).
 */
const props = defineProps<{ entry?: ProviderCatalogEntry; provider?: InstalledProvider }>();
const emit = defineEmits<{ close: []; done: [] }>();
const { t } = useI18n();
const store = useOperatorStore();

const upgrade = computed(() => !!props.provider);
const entry = computed(
  () =>
    props.entry ?? (props.provider?.catalogId ? catalogEntry(props.provider.catalogId) : undefined),
);

const step = ref<'form' | 'preview'>('form');
const version = ref(
  props.provider?.installedVersion ??
    props.provider?.version ??
    entry.value?.recommendedVersion ??
    '',
);
const namespace = ref(props.provider?.namespace ?? entry.value?.defaultNamespace ?? '');
const versions = ref<string[]>([]);
const versionsLive = ref(true);
const variables = ref<{ key: string; value: string }[]>(
  props.provider
    ? []
    : Object.entries(entry.value?.defaultVariables ?? {}).map(([key, value]) => ({ key, value })),
);
const existingVariables = ref<string[]>([]);
const replaceVariables = ref(!props.provider);
const featureGates = ref<{ key: string; value: boolean }[]>(
  Object.entries(props.provider?.featureGates ?? {}).map(([key, value]) => ({ key, value })),
);
const fetchConfigUrl = ref('');
// FP-29: outbound proxy of the management cluster; the catalog decides the default on install.
const hasProxy = computed(() => !!useConnectionsStore().active?.outboundProxy);
const proxyDefault = computed(() =>
  props.provider ? proxySwitchDefault(props.provider) : !!entry.value?.outboundProxyDefault,
);
const useProxy = ref(hasProxy.value && proxyDefault.value);
/** Uses a proxy that was removed from the connection: the update switches it off. */
const proxyRemoved = computed(() => !hasProxy.value && !!props.provider?.outboundProxy);
const valid = ref(false);
const busy = ref(false);
const error = ref<unknown>(null);
const preview = ref<ManifestPreview | null>(null);
const serverFieldErrors = computed(() =>
  error.value instanceof ApiError ? error.value.fieldErrors : undefined,
);
const shape = ProviderInstallRequestSchema.shape;

onMounted(async () => {
  if (!entry.value) return;
  try {
    const list = await store.releases(entry.value.id);
    versions.value = list.versions;
    versionsLive.value = list.live;
  } catch {
    versions.value = [entry.value.recommendedVersion];
    versionsLive.value = false;
  }
  if (props.provider?.configSecret) {
    existingVariables.value = await store.variableNames(props.provider).catch(() => []);
  }
});

function payloadVariables(): Record<string, string> {
  return Object.fromEntries(
    variables.value.filter((v) => v.key).map((v) => [v.key.trim(), v.value]),
  );
}
function payloadGates(): Record<string, boolean> {
  return Object.fromEntries(
    featureGates.value.filter((g) => g.key).map((g) => [g.key.trim(), g.value]),
  );
}
function installRequest() {
  return {
    catalogId: entry.value!.id,
    version: version.value.trim(),
    namespace: namespace.value.trim(),
    variables: payloadVariables(),
    featureGates: payloadGates(),
    ...(fetchConfigUrl.value.trim() ? { fetchConfigUrl: fetchConfigUrl.value.trim() } : {}),
    outboundProxy: hasProxy.value && useProxy.value,
  };
}
function updateRequest() {
  return {
    version: version.value.trim(),
    featureGates: payloadGates(),
    ...(replaceVariables.value ? { variables: payloadVariables() } : {}),
    outboundProxy: hasProxy.value && useProxy.value,
  };
}

async function showPreview(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    preview.value = upgrade.value
      ? await store.previewUpdate(props.provider!, updateRequest())
      : await store.previewInstall(installRequest());
    step.value = 'preview';
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}

async function apply(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    if (upgrade.value) await store.update(props.provider!, updateRequest());
    else await store.install(installRequest());
    emit('done');
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
        upgrade
          ? t('providers.upgradeTitle', { name: entry?.displayName ?? provider?.name })
          : t('providers.installTitle', { name: entry?.displayName })
      }}
    </v-card-title>
    <v-card-subtitle v-if="entry" class="px-6">{{ entry.description }}</v-card-subtitle>

    <v-card-text v-if="step === 'form'">
      <v-form v-model="valid" @submit.prevent="showPreview">
        <v-combobox
          v-model="version"
          :items="versions"
          :label="t('providers.version')"
          :rules="[zodRule(shape.version)]"
          :hint="
            t('providers.versionHint', { version: entry?.recommendedVersion }) +
            (versionsLive ? '' : ' ' + t('providers.versionsOffline'))
          "
          persistent-hint
          :error-messages="fieldErrors(serverFieldErrors, 'version')"
          class="mb-3"
          name="version"
        >
          <template #append-inner>
            <span class="text-body-small text-medium-emphasis">spec.version</span>
          </template>
        </v-combobox>

        <v-text-field
          v-model="namespace"
          :label="t('providers.namespace')"
          :disabled="upgrade"
          :rules="[zodRule(shape.namespace)]"
          :hint="t('providers.namespaceHint', { ns: entry?.defaultNamespace })"
          persistent-hint
          :error-messages="fieldErrors(serverFieldErrors, 'namespace')"
          class="mb-3"
          name="namespace"
        />

        <v-switch
          v-if="hasProxy"
          v-model="useProxy"
          :label="t('providers.useProxy')"
          :hint="
            t('providers.useProxyHint', {
              default: proxyDefault ? t('providers.proxyOn') : t('providers.proxyOff'),
            })
          "
          persistent-hint
          color="primary"
          class="mb-3"
          data-testid="provider-use-proxy"
        />
        <v-alert
          v-else-if="proxyRemoved"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-3"
        >
          {{ t('providers.proxyRemoved') }}
        </v-alert>

        <v-expansion-panels variant="accordion" class="mb-2">
          <v-expansion-panel>
            <v-expansion-panel-title>
              {{ t('providers.variables') }}
              <span
                v-if="existingVariables.length"
                class="text-body-small text-medium-emphasis ml-2"
              >
                ({{ t('providers.storedVariables', { names: existingVariables.join(', ') }) }})
              </span>
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <p class="text-body-small text-medium-emphasis mb-2">
                {{ t('providers.variablesHint') }}
              </p>
              <v-alert
                v-if="entry?.variablesHint"
                type="info"
                variant="tonal"
                density="compact"
                class="mb-2"
              >
                {{ entry.variablesHint }}
              </v-alert>
              <v-switch
                v-if="upgrade && existingVariables.length"
                v-model="replaceVariables"
                :label="t('providers.replaceVariables')"
                color="primary"
                density="compact"
                hide-details
                class="mb-2"
              />
              <template v-if="replaceVariables">
                <div v-for="(v, i) in variables" :key="i" class="d-flex ga-2 align-start">
                  <v-text-field
                    v-model="v.key"
                    :label="t('providers.variableName')"
                    density="compact"
                    :rules="[
                      (x: string) =>
                        !x || /^[A-Z_][A-Z0-9_]*$/.test(x) || t('providers.variableNameRule'),
                    ]"
                  />
                  <v-text-field
                    v-model="v.value"
                    :label="t('providers.variableValue')"
                    type="password"
                    autocomplete="off"
                    density="compact"
                  />
                  <v-btn
                    icon="mdi-close"
                    variant="text"
                    size="small"
                    @click="variables.splice(i, 1)"
                  />
                </div>
                <v-btn
                  size="small"
                  variant="text"
                  prepend-icon="mdi-plus"
                  @click="variables.push({ key: '', value: '' })"
                >
                  {{ t('providers.addVariable') }}
                </v-btn>
              </template>
            </v-expansion-panel-text>
          </v-expansion-panel>

          <v-expansion-panel>
            <v-expansion-panel-title>{{ t('providers.featureGates') }}</v-expansion-panel-title>
            <v-expansion-panel-text>
              <p class="text-body-small text-medium-emphasis mb-2">
                {{ t('providers.featureGatesHint') }}
              </p>
              <div v-for="(g, i) in featureGates" :key="i" class="d-flex ga-2 align-center">
                <v-text-field
                  v-model="g.key"
                  :label="t('providers.featureGate')"
                  density="compact"
                  hide-details
                />
                <v-switch v-model="g.value" color="primary" density="compact" hide-details />
                <v-btn
                  icon="mdi-close"
                  variant="text"
                  size="small"
                  @click="featureGates.splice(i, 1)"
                />
              </div>
              <v-btn
                size="small"
                variant="text"
                prepend-icon="mdi-plus"
                @click="featureGates.push({ key: '', value: true })"
              >
                {{ t('providers.addFeatureGate') }}
              </v-btn>
            </v-expansion-panel-text>
          </v-expansion-panel>

          <v-expansion-panel v-if="!upgrade">
            <v-expansion-panel-title>{{ t('providers.advanced') }}</v-expansion-panel-title>
            <v-expansion-panel-text>
              <v-text-field
                v-model="fetchConfigUrl"
                :label="t('providers.fetchConfig')"
                :hint="t('providers.fetchConfigHint')"
                persistent-hint
                placeholder="https://…/infrastructure-components.yaml"
              />
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>

        <ErrorAlert v-if="error" :error="error" class="mt-3" />
      </v-form>
    </v-card-text>

    <v-card-text v-else-if="preview">
      <p class="mb-2">{{ t('providers.previewText') }}</p>
      <v-alert
        v-for="w in preview.warnings"
        :key="w"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-2"
      >
        {{ w }}
      </v-alert>
      <YamlViewer
        :value="preview.yaml"
        height="320px"
        :filename="`${entry?.id ?? 'provider'}.yaml`"
      />
      <ErrorAlert v-if="error" :error="error" class="mt-3" />
    </v-card-text>

    <v-card-actions class="px-6 pb-4">
      <v-btn
        v-if="step === 'preview'"
        variant="text"
        prepend-icon="mdi-arrow-left"
        @click="step = 'form'"
      >
        {{ t('common.back') }}
      </v-btn>
      <v-spacer />
      <v-btn variant="text" @click="emit('close')">{{ t('common.cancel') }}</v-btn>
      <v-btn
        v-if="step === 'form'"
        color="primary"
        variant="flat"
        :loading="busy"
        :disabled="!valid"
        data-testid="provider-preview"
        @click="showPreview"
      >
        {{ t('providers.showPreview') }}
      </v-btn>
      <v-btn
        v-else
        color="primary"
        variant="flat"
        :loading="busy"
        data-testid="provider-apply"
        @click="apply"
      >
        {{ upgrade ? t('providers.applyUpgrade') : t('providers.applyInstall') }}
      </v-btn>
    </v-card-actions>
  </v-card>
</template>
