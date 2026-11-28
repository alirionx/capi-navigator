<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ManagementBackupPreview } from '@capi-navigator/shared';
import ErrorAlert from '../ErrorAlert.vue';
import FieldHelp from '../FieldHelp.vue';
import { useBackupStore } from '../../stores/backup.js';
import { useConnectionsStore } from '../../stores/connections.js';

/**
 * Backup of a management cluster (FP39-F-09): preview and download per connection. The app only
 * reads the cluster; the archive is restored with kubectl and `clusterctl move --from-directory`
 * (ADR-0047). `canDownload` comes from the page: saved keys, no unsaved changes.
 */
const props = defineProps<{ canDownload: boolean }>();
const { t } = useI18n();
const store = useBackupStore();
const connections = useConnectionsStore();

const connection = ref<string | null>(
  connections.activeName ?? connections.connections[0]?.name ?? null,
);
const preview = ref<ManagementBackupPreview | null>(null);
const previewError = ref<unknown>(null);
const loading = ref(false);
const downloading = ref(false);
const downloadError = ref<unknown>(null);
const downloaded = ref<string | null>(null);

const items = computed(() => connections.connections.map((c) => c.name));

async function loadPreview(): Promise<void> {
  preview.value = null;
  previewError.value = null;
  downloaded.value = null;
  downloadError.value = null;
  if (!connection.value) return;
  loading.value = true;
  try {
    preview.value = await store.managementPreview(connection.value);
  } catch (err) {
    previewError.value = err;
  } finally {
    loading.value = false;
  }
}
watch(connection, loadPreview, { immediate: true });
watch(
  () => connections.connections.length,
  () => {
    if (!connection.value && items.value[0]) connection.value = items.value[0];
  },
);

async function download(): Promise<void> {
  if (!connection.value) return;
  downloading.value = true;
  downloadError.value = null;
  downloaded.value = null;
  try {
    downloaded.value = await store.downloadManagement(connection.value);
  } catch (err) {
    downloadError.value = err;
  } finally {
    downloading.value = false;
  }
}

const ready = computed(
  () =>
    props.canDownload && !!preview.value && preview.value.unreadable.length === 0 && !loading.value,
);

/** FP39-F-08: the restore steps of RESTORE.md, with file and clusterctl version filled in. */
const restoreSteps = computed(() => {
  const file =
    downloaded.value ??
    `capi-navigator-mgmt-${connection.value ?? 'NAME'}-YYYYMMDDTHHMMSSZ.tar.gz.gpg`;
  const capi = preview.value?.versions.find((v) => v.name === 'cluster-api')?.version;
  const minor = capi?.replace(/^v?(\d+\.\d+).*$/, 'v$1') ?? 'vX.Y';
  return [
    { text: t('backup.mgmt.restoreBefore') },
    {
      text: t('backup.mgmt.restoreDecrypt'),
      command: `mkdir restore && gpg -d ${file} | tar xz -C restore && cd restore`,
    },
    { text: t('backup.mgmt.restorePrerequisites') },
    {
      text: t('backup.mgmt.restoreProviders'),
      command: `kubectl apply --server-side -f providers/\nkubectl get coreproviders,bootstrapproviders,controlplaneproviders,infrastructureproviders -A -w\nkubectl apply --server-side -f identities/   # if the folder exists`,
    },
    {
      text: t('backup.mgmt.restoreCapi', { version: `${minor}.x` }),
      command: `clusterctl move --from-directory capi/ --to-kubeconfig NEW-MANAGEMENT-CLUSTER.kubeconfig`,
    },
    { text: t('backup.mgmt.restoreConnection', { connection: connection.value ?? '' }) },
  ];
});
const copied = ref<number | null>(null);
async function copy(i: number, text: string): Promise<void> {
  await navigator.clipboard?.writeText(text);
  copied.value = i;
}
</script>

<template>
  <v-card border class="pa-6 mb-6" data-testid="backup-mgmt">
    <div class="d-flex align-center mb-1">
      <h2 class="text-title-large">{{ t('backup.mgmt.title') }}</h2>
      <FieldHelp :text="t('backup.mgmt.titleHint')" />
    </div>
    <p class="text-body-medium text-medium-emphasis mb-4">{{ t('backup.mgmt.intro') }}</p>

    <p v-if="items.length === 0" class="text-body-medium" data-testid="backup-mgmt-none">
      {{ t('backup.mgmt.noConnections') }}
    </p>
    <template v-else>
      <v-select
        v-model="connection"
        :items="items"
        :label="t('backup.mgmt.connection')"
        density="comfortable"
        class="mb-2"
        style="max-width: 420px"
        data-testid="backup-mgmt-connection"
      />
      <v-progress-linear v-if="loading" indeterminate class="mb-4" />
      <ErrorAlert v-if="previewError" :error="previewError" class="mb-4" />

      <template v-if="preview">
        <v-alert
          v-if="preview.unreadable.length"
          type="error"
          variant="tonal"
          density="compact"
          class="mb-4"
          data-testid="backup-mgmt-unreadable"
        >
          <div>{{ t('backup.mgmt.unreadable') }}</div>
          <ul class="ms-4 mt-1">
            <li v-for="u in preview.unreadable" :key="u.resource">
              <code>{{ u.resource }}</code>
            </li>
          </ul>
        </v-alert>
        <v-alert
          v-if="preview.excluded.length"
          type="warning"
          variant="tonal"
          density="compact"
          class="mb-4"
          data-testid="backup-mgmt-excluded"
        >
          <div>{{ t('backup.mgmt.excluded') }}</div>
          <ul class="ms-4 mt-1">
            <li v-for="e in preview.excluded" :key="`${e.namespace}/${e.name}`">
              {{ e.namespace }}/{{ e.name }}
            </li>
          </ul>
        </v-alert>
        <v-alert
          v-if="preview.warnings.length"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-4"
          data-testid="backup-mgmt-warnings"
        >
          <div>{{ t('backup.mgmt.warnings') }}</div>
          <ul class="ms-4 mt-1">
            <li v-for="(w, i) in preview.warnings" :key="i">
              {{ w.kind }} {{ w.namespace ? `${w.namespace}/` : '' }}{{ w.name }}: {{ w.message }}
            </li>
          </ul>
        </v-alert>

        <v-row dense class="mb-2">
          <v-col cols="12" md="6">
            <h3 class="text-title-small mb-1">
              {{ t('backup.mgmt.capiPart') }}
              <FieldHelp :text="t('backup.mgmt.capiPartHint')" />
            </h3>
            <v-table density="compact" data-testid="backup-mgmt-capi">
              <tbody>
                <tr v-for="item in preview.capi" :key="item.kind">
                  <td>{{ item.kind }}</td>
                  <td class="text-end">{{ item.count }}</td>
                </tr>
                <tr v-if="preview.capi.length === 0">
                  <td colspan="2" class="text-medium-emphasis">{{ t('backup.mgmt.empty') }}</td>
                </tr>
              </tbody>
            </v-table>
          </v-col>
          <v-col cols="12" md="6">
            <h3 class="text-title-small mb-1">
              {{ t('backup.mgmt.providerPart') }}
              <FieldHelp :text="t('backup.mgmt.providerPartHint')" />
            </h3>
            <v-table density="compact" data-testid="backup-mgmt-providers">
              <tbody>
                <tr v-for="item in preview.providers" :key="item.kind">
                  <td>{{ item.kind }}</td>
                  <td class="text-end">{{ item.count }}</td>
                </tr>
                <tr v-if="preview.providers.length === 0">
                  <td colspan="2" class="text-medium-emphasis">{{ t('backup.mgmt.empty') }}</td>
                </tr>
              </tbody>
            </v-table>
          </v-col>
        </v-row>
        <p class="text-body-small text-medium-emphasis mb-4">
          {{
            t('backup.mgmt.summary', {
              total: preview.total,
              namespaces: preview.namespaces.join(', ') || '–',
            })
          }}
          <span v-if="preview.versions.length">
            · {{ preview.versions.map((v) => `${v.name} ${v.version}`).join(', ') }}
          </span>
        </p>
      </template>

      <v-alert type="warning" variant="tonal" density="compact" class="mb-4">{{
        t('backup.mgmt.downloadWarning')
      }}</v-alert>
      <p v-if="!canDownload" class="text-body-small text-medium-emphasis mb-2">
        {{ t('backup.mgmt.keysFirst') }}
      </p>
      <ErrorAlert v-if="downloadError" :error="downloadError" class="mb-4" />
      <v-alert
        v-if="downloaded"
        type="success"
        variant="tonal"
        density="compact"
        class="mb-4"
        data-testid="backup-mgmt-downloaded"
        >{{ t('backup.downloaded', { file: downloaded }) }}</v-alert
      >

      <v-expansion-panels variant="accordion" class="mb-4" data-testid="backup-mgmt-restore-howto">
        <v-expansion-panel>
          <v-expansion-panel-title>
            <v-icon icon="mdi-help-circle-outline" size="small" class="me-2" />
            {{ t('backup.mgmt.restoreTitle') }}
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <ol class="howto">
              <li v-for="(step, i) in restoreSteps" :key="i" class="mb-3">
                <div class="text-body-medium mb-1">{{ step.text }}</div>
                <div v-if="step.command" class="d-flex align-center ga-1">
                  <pre class="command flex-grow-1">{{ step.command }}</pre>
                  <v-btn
                    :icon="copied === i ? 'mdi-check' : 'mdi-content-copy'"
                    size="small"
                    variant="text"
                    :aria-label="t('common.copy')"
                    @click="copy(i, step.command)"
                  />
                </div>
              </li>
            </ol>
            <div class="text-body-small text-medium-emphasis">
              {{ t('backup.mgmt.restoreNote') }}
            </div>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>

      <v-btn
        color="primary"
        prepend-icon="mdi-download-lock"
        :disabled="!ready"
        :loading="downloading"
        data-testid="backup-mgmt-download"
        @click="download"
        >{{ t('backup.mgmt.downloadButton') }}</v-btn
      >
    </template>
  </v-card>
</template>

<style scoped>
.howto {
  padding-left: 1.25rem;
}
.command {
  font-family: monospace;
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-all;
  padding: 6px 10px;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  margin: 0;
}
</style>
