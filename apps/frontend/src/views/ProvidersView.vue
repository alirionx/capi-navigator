<script setup lang="ts">
import YamlButton from '../components/YamlButton.vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  catalogEntry,
  PROVIDER_CATALOG,
  PROVIDER_KINDS,
  type ComponentStatus,
  type InstalledProvider,
  type ProviderCatalogEntry,
  type ProviderUsage,
} from '@capi-navigator/shared';
import ErrorAlert from '../components/ErrorAlert.vue';
import OrcDialog from '../components/OrcDialog.vue';
import ProviderDialog from '../components/ProviderDialog.vue';
import { useAuthStore } from '../stores/auth.js';
import { useConnectionsStore } from '../stores/connections.js';
import { useOperatorStore } from '../stores/operator.js';

const { t } = useI18n();
const auth = useAuthStore();
const connections = useConnectionsStore();
const store = useOperatorStore();
const isAdmin = computed(() => auth.can('admin'));

// Follow the globally active management cluster (FP2-F-05); live updates via SSE (FP3-F-13).
watch(
  () => connections.activeName,
  (name) => (name ? store.connect(name) : store.disconnect()),
  { immediate: true },
);
onBeforeUnmount(() => store.disconnect());

const pre = computed(() => store.state?.prerequisites);
const providers = computed(() => store.state?.providers ?? []);
const operatorReady = computed(() => !!pre.value?.certManager.ready && !!pre.value?.operator.ready);
const coreReady = computed(() =>
  providers.value.some((p) => p.catalogId === 'core' && p.phase === 'Ready'),
);

const installedFor = (entry: ProviderCatalogEntry) =>
  providers.value.find((p) => p.kind === entry.kind && p.name === entry.name);

/** Why a catalog entry cannot be installed right now (FP3-F-11, ORC before CAPO). */
function blocker(entry: ProviderCatalogEntry): string | null {
  if (entry.availableFrom) return t('providers.availableFrom', { pack: entry.availableFrom });
  if (!operatorReady.value) return t('providers.needsOperator');
  if (entry.dependsOn.includes('core') && !coreReady.value) return t('providers.needsCore');
  if (entry.requiresOrc && !pre.value?.orc.ready) return t('providers.needsOrc');
  return null;
}

const groups = computed(() =>
  PROVIDER_KINDS.map((kind) => ({
    kind,
    entries: PROVIDER_CATALOG.filter((e) => e.kind === kind),
  })),
);

function phaseColor(phase: InstalledProvider['phase']): string {
  return {
    Ready: 'success',
    Failed: 'error',
    Deleting: 'grey',
    Installing: 'info',
    Upgrading: 'info',
  }[phase];
}
function componentColor(c: ComponentStatus | undefined): string {
  if (!c?.installed) return 'error';
  return c.ready ? 'success' : 'warning';
}
function componentText(c: ComponentStatus | undefined): string {
  if (!c?.installed) return t('providers.missing');
  return c.ready ? (c.version ?? t('providers.ready')) : (c.message ?? t('providers.notReady'));
}

// ---- dialogs ----
type Dialog =
  | { kind: 'install'; entry: ProviderCatalogEntry }
  | { kind: 'upgrade'; provider: InstalledProvider }
  | { kind: 'remove'; provider: InstalledProvider; usage: ProviderUsage | null }
  | { kind: 'orc' };
const dialog = ref<Dialog | null>(null);
const actionError = ref<unknown>(null);
const removing = ref(false);
const removeConfirm = ref('');

async function openRemove(provider: InstalledProvider): Promise<void> {
  actionError.value = null;
  removeConfirm.value = '';
  dialog.value = { kind: 'remove', provider, usage: null };
  try {
    const usage = await store.usage(provider);
    if (dialog.value?.kind === 'remove') dialog.value = { ...dialog.value, usage };
  } catch (err) {
    actionError.value = err;
  }
}

async function confirmRemove(): Promise<void> {
  if (dialog.value?.kind !== 'remove') return;
  removing.value = true;
  actionError.value = null;
  try {
    await store.remove(dialog.value.provider, (dialog.value.usage?.clusters.length ?? 0) > 0);
    dialog.value = null;
  } catch (err) {
    actionError.value = err;
  } finally {
    removing.value = false;
  }
}

const expanded = ref<string[]>([]);
const headers = computed(() => [
  { title: t('providers.provider'), key: 'name' },
  { title: t('providers.type'), key: 'kind' },
  { title: t('providers.namespace'), key: 'namespace' },
  { title: t('providers.version'), key: 'version', sortable: false },
  { title: t('providers.status'), key: 'phase' },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
  { title: '', key: 'data-table-expand' },
]);
const rowKey = (p: InstalledProvider) => `${p.kind}/${p.namespace}/${p.name}`;
const displayName = (p: InstalledProvider) =>
  (p.catalogId && catalogEntry(p.catalogId)?.displayName) || p.name;
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <div>
        <h1 class="page-title">{{ t('providers.title') }}</h1>
        <p class="text-body-2 text-medium-emphasis mt-1">{{ t('providers.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-chip
        v-if="connections.active"
        :color="store.live ? 'success' : 'grey'"
        variant="tonal"
        prepend-icon="mdi-access-point"
      >
        {{ store.live ? t('providers.live') : t('providers.connecting') }}
      </v-chip>
    </div>

    <v-alert v-if="!connections.active" type="info" variant="tonal">
      {{ t('providers.noConnection') }}
      <template #append>
        <v-btn :to="{ name: 'connections' }" variant="text">{{ t('nav.connections') }}</v-btn>
      </template>
    </v-alert>

    <template v-else>
      <v-alert v-if="store.error" type="error" variant="tonal" class="mb-4">{{
        store.error
      }}</v-alert>
      <v-progress-linear v-if="!store.state && !store.error" indeterminate class="mb-4" />

      <template v-if="pre">
        <!-- Prerequisites (FP3-F-01..04a) -->
        <v-row class="mb-2" data-testid="prerequisites">
          <v-col
            v-for="[key, comp] in [
              ['certManager', pre.certManager],
              ['operator', pre.operator],
              ['orc', pre.orc],
            ] as const"
            :key="key"
            cols="12"
            md="4"
          >
            <v-card border class="fill-height">
              <v-card-item>
                <template #prepend>
                  <v-icon
                    :color="componentColor(comp)"
                    :icon="
                      comp.ready
                        ? 'mdi-check-circle'
                        : comp.installed
                          ? 'mdi-progress-clock'
                          : 'mdi-close-circle'
                    "
                  />
                </template>
                <v-card-title>{{ t(`providers.prereq.${key}`) }}</v-card-title>
                <v-card-subtitle>{{ componentText(comp) }}</v-card-subtitle>
              </v-card-item>
              <v-card-text class="pt-0">
                <div class="text-caption text-medium-emphasis mb-2">
                  {{ t(`providers.prereqHint.${key}`) }}
                </div>
                <template v-if="!comp.installed && key !== 'orc'">
                  <div class="text-caption mb-1">{{ t('providers.installWith') }}</div>
                  <pre class="command" data-testid="install-instructions">{{
                    pre.instructions[key]
                  }}</pre>
                </template>
                <template v-if="key === 'orc'">
                  <v-btn
                    v-if="isAdmin"
                    size="small"
                    variant="tonal"
                    color="primary"
                    :disabled="!operatorReady"
                    data-testid="orc-install"
                    @click="dialog = { kind: 'orc' }"
                  >
                    {{ comp.installed ? t('orc.upgradeButton') : t('orc.installButton') }}
                  </v-btn>
                  <div v-if="!comp.installed" class="text-caption mt-2">
                    {{ t('providers.orcManual') }}
                    <pre class="command">{{ pre.instructions.orc }}</pre>
                  </div>
                </template>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>

        <!-- Installed providers (FP3-F-08) -->
        <h2 class="text-h6 mb-2">{{ t('providers.installed') }}</h2>
        <ErrorAlert v-if="actionError && !dialog" :error="actionError" class="mb-2" />
        <v-card border class="table-card">
          <v-data-table
            v-model:expanded="expanded"
            :headers="headers"
            :items="providers"
            :item-value="rowKey"
            show-expand
            :no-data-text="t('providers.noneInstalled')"
            density="comfortable"
            class="mb-6"
            data-testid="providers-table"
            hide-default-footer
            :items-per-page="-1"
          >
            <template #[`item.name`]="{ item }">
              <div class="font-weight-medium">{{ displayName(item) }}</div>
              <div class="text-caption text-medium-emphasis">{{ item.name }}</div>
            </template>
            <template #[`item.kind`]="{ item }">{{ t(`providers.kinds.${item.kind}`) }}</template>
            <template #[`item.version`]="{ item }">
              {{ item.installedVersion ?? '–' }}
              <span
                v-if="item.version && item.version !== item.installedVersion"
                class="text-caption text-medium-emphasis"
              >
                → {{ item.version }}
              </span>
            </template>
            <template #[`item.phase`]="{ item }">
              <v-chip :color="phaseColor(item.phase)" size="small" variant="tonal">
                <v-progress-circular
                  v-if="item.phase === 'Installing' || item.phase === 'Upgrading'"
                  size="12"
                  width="2"
                  indeterminate
                  class="mr-1"
                />
                {{ t(`providers.phase.${item.phase}`) }}
              </v-chip>
            </template>
            <template #[`item.actions`]="{ item }">
              <YamlButton
                :target="{
                  apiVersion: 'operator.cluster.x-k8s.io/v1alpha2',
                  kind: item.kind,
                  namespace: item.namespace,
                  name: item.name,
                }"
              />
              <div v-if="isAdmin" class="text-no-wrap d-inline-flex">
                <v-btn
                  icon="mdi-arrow-up-bold-circle-outline"
                  variant="text"
                  size="small"
                  :title="t('providers.upgrade')"
                  :aria-label="t('providers.upgrade')"
                  :disabled="!item.catalogId"
                  @click="dialog = { kind: 'upgrade', provider: item }"
                />
                <v-btn
                  icon="mdi-delete"
                  variant="text"
                  size="small"
                  color="error"
                  :title="t('providers.remove')"
                  :aria-label="t('providers.remove')"
                  @click="openRemove(item)"
                />
              </div>
            </template>
            <template #expanded-row="{ columns, item }">
              <tr>
                <td :colspan="columns.length" class="py-3">
                  <div class="text-subtitle-2 mb-1">{{ t('providers.conditions') }}</div>
                  <v-table density="compact">
                    <tbody>
                      <tr v-for="c in item.conditions" :key="c.type">
                        <td style="width: 32px">
                          <v-icon
                            :icon="c.status === 'True' ? 'mdi-check' : 'mdi-alert-circle-outline'"
                            :color="c.status === 'True' ? 'success' : 'warning'"
                            size="small"
                          />
                        </td>
                        <td class="font-monospace text-caption">{{ c.type }}</td>
                        <td class="text-caption">{{ c.reason }}</td>
                        <td class="text-caption">{{ c.message }}</td>
                      </tr>
                      <tr v-if="item.conditions.length === 0">
                        <td class="text-caption text-medium-emphasis">
                          {{ t('providers.noConditions') }}
                        </td>
                      </tr>
                    </tbody>
                  </v-table>
                  <div v-if="item.featureGates" class="text-caption mt-2">
                    {{ t('providers.featureGates') }}:
                    <span class="font-monospace">{{
                      Object.entries(item.featureGates)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ')
                    }}</span>
                  </div>
                </td>
              </tr>
            </template>
          </v-data-table>
        </v-card>

        <!-- Catalog (FP3-F-05, FP3-F-06) -->
        <h2 class="text-h6 mb-2">{{ t('providers.catalog') }}</h2>
        <template v-for="group in groups" :key="group.kind">
          <div class="text-subtitle-2 text-medium-emphasis mt-2 mb-1">
            {{ t(`providers.kinds.${group.kind}`) }}
          </div>
          <v-row dense>
            <v-col v-for="entry in group.entries" :key="entry.id" cols="12" sm="6" lg="4">
              <v-card
                border
                class="fill-height d-flex flex-column"
                :data-testid="`catalog-${entry.id}`"
              >
                <v-card-item>
                  <v-card-title class="text-body-1 font-weight-medium">{{
                    entry.displayName
                  }}</v-card-title>
                  <v-card-subtitle
                    >{{ entry.recommendedVersion }} · {{ entry.contract }}</v-card-subtitle
                  >
                </v-card-item>
                <v-card-text class="pt-0 flex-grow-1 text-body-2">
                  {{ entry.description }}
                  <div
                    v-if="blocker(entry) && !installedFor(entry)"
                    class="text-caption text-warning mt-1"
                  >
                    {{ blocker(entry) }}
                  </div>
                </v-card-text>
                <v-card-actions>
                  <v-btn
                    :href="entry.docsUrl"
                    target="_blank"
                    rel="noopener"
                    size="small"
                    variant="text"
                    append-icon="mdi-open-in-new"
                  >
                    {{ t('providers.docs') }}
                  </v-btn>
                  <v-spacer />
                  <v-chip
                    v-if="installedFor(entry)"
                    size="small"
                    :color="phaseColor(installedFor(entry)!.phase)"
                    variant="tonal"
                  >
                    {{ t(`providers.phase.${installedFor(entry)!.phase}`) }}
                  </v-chip>
                  <v-btn
                    v-else-if="isAdmin"
                    size="small"
                    color="primary"
                    variant="tonal"
                    :disabled="!!blocker(entry)"
                    :data-testid="`install-${entry.id}`"
                    @click="dialog = { kind: 'install', entry }"
                  >
                    {{ t('providers.install') }}
                  </v-btn>
                </v-card-actions>
              </v-card>
            </v-col>
          </v-row>
        </template>
      </template>
    </template>

    <v-dialog
      :model-value="dialog?.kind === 'install' || dialog?.kind === 'upgrade'"
      max-width="760"
      scrollable
      @update:model-value="dialog = null"
    >
      <ProviderDialog
        v-if="dialog?.kind === 'install'"
        :entry="dialog.entry"
        @close="dialog = null"
        @done="dialog = null"
      />
      <ProviderDialog
        v-else-if="dialog?.kind === 'upgrade'"
        :provider="dialog.provider"
        @close="dialog = null"
        @done="dialog = null"
      />
    </v-dialog>

    <v-dialog
      :model-value="dialog?.kind === 'orc'"
      max-width="760"
      scrollable
      @update:model-value="dialog = null"
    >
      <OrcDialog
        v-if="dialog?.kind === 'orc'"
        :installed-version="pre?.orc.version"
        @close="dialog = null"
        @done="dialog = null"
      />
    </v-dialog>

    <v-dialog
      :model-value="dialog?.kind === 'remove'"
      max-width="520"
      @update:model-value="dialog = null"
    >
      <v-card v-if="dialog?.kind === 'remove'">
        <v-card-title class="pt-4 px-6">{{
          t('providers.removeTitle', { name: displayName(dialog.provider) })
        }}</v-card-title>
        <v-card-text>
          <p class="mb-3">{{ t('providers.removeText') }}</p>
          <v-progress-linear v-if="!dialog.usage && !actionError" indeterminate class="mb-3" />
          <v-alert
            v-if="dialog.usage && dialog.usage.clusters.length > 0"
            type="warning"
            variant="tonal"
            class="mb-3"
          >
            {{ t('providers.removeInUse', { n: dialog.usage.clusters.length }) }}
            <div class="text-caption font-monospace">
              {{ dialog.usage.clusters.map((c) => `${c.namespace}/${c.name}`).join(', ') }}
            </div>
          </v-alert>
          <v-text-field
            v-model="removeConfirm"
            :label="t('providers.removeConfirm', { name: dialog.provider.name })"
            density="comfortable"
            data-testid="remove-confirm"
          />
          <ErrorAlert v-if="actionError" :error="actionError" class="mt-2" />
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="dialog = null">{{ t('common.cancel') }}</v-btn>
          <v-btn
            color="error"
            variant="flat"
            :loading="removing"
            :disabled="!dialog.usage || removeConfirm !== dialog.provider.name"
            data-testid="remove-apply"
            @click="confirmRemove"
          >
            {{ t('providers.remove') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<style scoped>
.command {
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  padding: 6px 8px;
  border-radius: 4px;
}
</style>
