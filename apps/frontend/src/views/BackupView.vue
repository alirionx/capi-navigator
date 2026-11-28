<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  BackupPublicKeySchema,
  MAX_BACKUP_RECIPIENTS,
  type BackupKey,
} from '@capi-navigator/shared';
import BackupS3Card from '../components/backup/BackupS3Card.vue';
import ManagementBackupCard from '../components/backup/ManagementBackupCard.vue';
import { s3Body, s3Dirty, s3Draft, s3Target, type S3Draft } from '../components/backup/s3-draft.js';
import ErrorAlert from '../components/ErrorAlert.vue';
import FieldHelp from '../components/FieldHelp.vue';
import { zodRule } from '../forms/zod-rules.js';
import { useBackupStore } from '../stores/backup.js';

/**
 * Backup page (FP38-F-09): the OpenPGP public keys of the recipients, what a backup contains, and
 * the download. The backend encrypts before anything leaves it (FP38-F-05); this page never sees
 * the content.
 */
const { t, d } = useI18n();
const store = useBackupStore();

const loadError = ref<unknown>(null);
const saveError = ref<unknown>(null);
const downloadError = ref<unknown>(null);
const saving = ref(false);
const downloading = ref(false);
const downloaded = ref<string | null>(null);
const confirmOpen = ref(false);
const newKey = ref('');

/** Edited state: stored keys stay as BackupKey, pasted ones as armored text until saved. */
const keys = ref<{ publicKey: string; info?: BackupKey }[]>([]);
const includeAuditEvents = ref(true);
const s3 = ref<S3Draft>(s3Draft(null));

function reset(): void {
  const s = store.settings;
  s3.value = s3Draft(s);
  keys.value = (s?.recipients ?? []).map((info) => ({ publicKey: info.publicKey, info }));
  includeAuditEvents.value = s?.includeAuditEvents ?? true;
  newKey.value = '';
}

onMounted(async () => {
  try {
    await store.load();
    reset();
  } catch (err) {
    loadError.value = err;
  }
});

const stored = computed(() => store.settings);
const dirty = computed(() => {
  const s = stored.value;
  if (!s) return false;
  const before = s.recipients.map((r) => r.publicKey).join('\n');
  const after = keys.value.map((k) => k.publicKey).join('\n');
  return (
    before !== after || s.includeAuditEvents !== includeAuditEvents.value || s3Dirty(s3.value, s)
  );
});
const keyRule = zodRule(BackupPublicKeySchema);
const canAdd = computed(
  () => keyRule(newKey.value) === true && keys.value.length < MAX_BACKUP_RECIPIENTS,
);
const problems = computed(() => (stored.value?.recipients ?? []).filter((k) => k.problem));
const canDownload = computed(
  () =>
    !!stored.value &&
    stored.value.recipients.length > 0 &&
    problems.value.length === 0 &&
    !dirty.value,
);

/** Changes for the confirmation (hard rule 6): keys by fingerprint, pasted ones as "new key". */
const changes = computed(() => {
  const s = stored.value;
  if (!s) return [];
  const label = (k: { publicKey: string; info?: BackupKey }) =>
    k.info ? `${fingerprint(k.info.fingerprint)} ${k.info.userIds[0] ?? ''}` : t('backup.newKey');
  const before = new Set(s.recipients.map((r) => r.publicKey));
  const after = new Set(keys.value.map((k) => k.publicKey));
  const rows = [
    ...keys.value
      .filter((k) => !before.has(k.publicKey))
      .map((k) => ({ change: t('backup.keyAdded'), what: label(k) })),
    ...s.recipients
      .filter((r) => !after.has(r.publicKey))
      .map((r) => ({
        change: t('backup.keyRemoved'),
        what: label({ publicKey: r.publicKey, info: r }),
      })),
  ];
  if (s.includeAuditEvents !== includeAuditEvents.value) {
    rows.push({
      change: t('backup.includeAuditEvents'),
      what: includeAuditEvents.value ? t('common.yes') : t('common.no'),
    });
  }
  const d3 = s3.value;
  const before3 = s3Draft(s);
  if (!d3.enabled && before3.enabled)
    rows.push({ change: t('backup.s3.title'), what: t('backup.s3.removed') });
  if (d3.enabled) {
    const target =
      `${d3.endpoint || 'AWS'} · ${d3.bucket}/${d3.prefix}` +
      (d3.insecureSkipTLSVerify ? ` · ${t('backup.s3.insecureShort')}` : '');
    const changed = JSON.stringify(s3Target(d3)) !== JSON.stringify(s3Target(before3));
    if (changed || !before3.enabled) rows.push({ change: t('backup.s3.title'), what: target });
    if (d3.accessKeyId || d3.secretAccessKey)
      rows.push({ change: t('backup.s3.accessKeyId'), what: t('backup.s3.keyReplaced') });
    if (JSON.stringify(d3.schedule) !== JSON.stringify(before3.schedule))
      rows.push({
        change: t('backup.s3.schedule'),
        what: d3.schedule.enabled
          ? `${d3.schedule.cron} (UTC), ${t('backup.s3.keep')}: ${d3.schedule.keep}`
          : t('common.no'),
      });
  }
  return rows;
});

function addKey(): void {
  if (!canAdd.value) return;
  keys.value.push({ publicKey: newKey.value.trim() });
  newKey.value = '';
}

function removeKey(i: number): void {
  keys.value.splice(i, 1);
}

async function save(): Promise<void> {
  saving.value = true;
  saveError.value = null;
  try {
    await store.save({
      recipients: keys.value.map((k) => ({ publicKey: k.publicKey })),
      includeAuditEvents: includeAuditEvents.value,
      ...s3Body(s3.value),
    });
    reset();
  } catch (err) {
    saveError.value = err;
  } finally {
    saving.value = false;
    confirmOpen.value = false;
  }
}

async function download(): Promise<void> {
  downloading.value = true;
  downloadError.value = null;
  downloaded.value = null;
  try {
    downloaded.value = await store.download();
  } catch (err) {
    downloadError.value = err;
  } finally {
    downloading.value = false;
  }
}

/**
 * How to create a fitting key (FP38-F-02): gpg's defaults (ed25519 with a cv25519 encryption
 * subkey), one command per step, each with a copy button. The private key never leaves the host.
 */
const HOWTO_EMAIL = 'ops-backup@example.com';
const howTo = computed(() => [
  {
    text: t('backup.howToCreate'),
    command: `gpg --quick-gen-key ${HOWTO_EMAIL} future-default default never`,
  },
  { text: t('backup.howToExport'), command: `gpg --armor --export ${HOWTO_EMAIL}` },
  {
    text: t('backup.howToKeepPrivate'),
    command: `gpg --armor --export-secret-keys ${HOWTO_EMAIL} > capi-navigator-backup-key.asc`,
  },
]);
const copied = ref<string | null>(null);
async function copy(id: string, text: string): Promise<void> {
  await navigator.clipboard?.writeText(text);
  copied.value = id;
}

/**
 * How to restore (FP38-F-08): the steps of RESTORE.md with namespace, version and file name filled
 * in. Restoring stays outside the app; it needs gpg, helm and kubectl.
 */
const CHART = 'oci://ghcr.io/alirionx/charts/capi-navigator';
const restoreSteps = computed(() => {
  const ns = store.preview?.namespace ?? 'capi-navigator-system';
  const version = store.preview?.appVersion ?? 'VERSION';
  const file = downloaded.value ?? 'capi-navigator-home-YYYYMMDDTHHMMSSZ.tar.gz.gpg';
  return [
    {
      text: t('backup.restoreInstall'),
      command: `helm install capi-navigator ${CHART} --version ${version} \\\n  -n ${ns} --create-namespace -f values.yaml --set replicaCount=0`,
    },
    {
      text: t('backup.restoreDecrypt'),
      command: `mkdir restore && gpg -d ${file} | tar xz -C restore\nkubectl apply --server-side -n ${ns} -f restore/resources/\nrm -rf restore`,
    },
    {
      text: t('backup.restoreScaleUp'),
      command: `helm upgrade capi-navigator ${CHART} --version ${version} \\\n  -n ${ns} --reuse-values --set replicaCount=1`,
    },
  ];
});

/** Fingerprint in blocks of four, as gpg prints it. */
function fingerprint(fp: string): string {
  return fp.replace(/(.{4})/g, '$1 ').trim();
}
</script>

<template>
  <v-container class="settings">
    <h1 class="page-title">{{ t('backup.title') }}</h1>
    <p class="text-body-medium text-medium-emphasis mt-1 mb-4">{{ t('backup.subtitle') }}</p>

    <ErrorAlert v-if="loadError" :error="loadError" class="mb-4" />

    <template v-if="store.settings">
      <v-card border class="pa-6 mb-6" data-testid="backup-keys">
        <div class="d-flex align-center mb-1">
          <h2 class="text-title-large">{{ t('backup.keys') }}</h2>
          <FieldHelp :text="t('backup.keysHint')" />
        </div>
        <p class="text-body-medium text-medium-emphasis mb-4">{{ t('backup.keysIntro') }}</p>

        <v-alert
          v-if="keys.length === 0"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-4"
          data-testid="backup-no-keys"
          >{{ t('backup.noKeys') }}</v-alert
        >
        <v-list v-else density="compact" class="mb-4" data-testid="backup-key-list">
          <v-list-item v-for="(k, i) in keys" :key="k.publicKey" border class="mb-2 rounded">
            <template v-if="k.info">
              <v-list-item-title class="font-weight-medium">
                {{ k.info.userIds.join(', ') || t('backup.noUserId') }}
              </v-list-item-title>
              <v-list-item-subtitle>
                <code data-testid="backup-key-fingerprint">{{
                  fingerprint(k.info.fingerprint)
                }}</code>
              </v-list-item-subtitle>
              <div class="text-body-small text-medium-emphasis mt-1">
                {{
                  k.info.expiresAt
                    ? t('backup.expires', { at: d(new Date(k.info.expiresAt), 'short') })
                    : t('backup.noExpiry')
                }}
              </div>
              <v-chip
                v-if="k.info.problem"
                color="error"
                size="small"
                class="mt-1"
                data-testid="backup-key-problem"
                >{{ k.info.problem }}</v-chip
              >
              <v-chip
                v-else-if="k.info.expiresSoon"
                color="warning"
                size="small"
                class="mt-1"
                data-testid="backup-key-expires-soon"
                >{{ t('backup.expiresSoon') }}</v-chip
              >
            </template>
            <template v-else>
              <v-list-item-title>{{ t('backup.newKey') }}</v-list-item-title>
              <v-list-item-subtitle>{{ t('backup.newKeyHint') }}</v-list-item-subtitle>
            </template>
            <template #append>
              <v-btn
                icon="mdi-delete-outline"
                variant="text"
                size="small"
                :aria-label="t('backup.removeKey')"
                data-testid="backup-key-remove"
                @click="removeKey(i)"
              />
            </template>
          </v-list-item>
        </v-list>

        <v-textarea
          v-model="newKey"
          :label="t('backup.pasteKey')"
          :rules="newKey ? [keyRule] : []"
          rows="4"
          auto-grow
          class="key-input"
          spellcheck="false"
          data-testid="backup-key-input"
        >
          <template #append-inner>
            <FieldHelp :text="t('backup.pasteKeyHint')" />
          </template>
        </v-textarea>
        <div class="d-flex ga-2 mb-4">
          <v-btn
            variant="tonal"
            prepend-icon="mdi-key-plus"
            :disabled="!canAdd"
            data-testid="backup-key-add"
            @click="addKey"
            >{{ t('backup.addKey') }}</v-btn
          >
        </div>
        <v-expansion-panels variant="accordion" class="mb-4" data-testid="backup-howto">
          <v-expansion-panel>
            <v-expansion-panel-title>
              <v-icon icon="mdi-help-circle-outline" size="small" class="me-2" />
              {{ t('backup.howToTitle') }}
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <ol class="howto">
                <li v-for="(step, i) in howTo" :key="i" class="mb-3">
                  <div class="text-body-medium mb-1">{{ step.text }}</div>
                  <div class="d-flex align-center ga-1">
                    <pre class="command flex-grow-1" data-testid="backup-howto-command">{{
                      step.command
                    }}</pre>
                    <v-btn
                      :icon="copied === `key-${i}` ? 'mdi-check' : 'mdi-content-copy'"
                      size="small"
                      variant="text"
                      :aria-label="t('common.copy')"
                      @click="copy(`key-${i}`, step.command)"
                    />
                  </div>
                </li>
              </ol>
              <div class="text-body-small text-medium-emphasis">{{ t('backup.howToNote') }}</div>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>

        <v-switch v-model="includeAuditEvents" color="primary" data-testid="backup-audit">
          <template #label>
            {{ t('backup.includeAuditEvents') }}
            <FieldHelp :text="t('backup.includeAuditEventsHint')" />
          </template>
        </v-switch>

        <ErrorAlert v-if="saveError" :error="saveError" class="mb-4" />
        <div class="d-flex ga-2">
          <v-btn
            color="primary"
            :disabled="!dirty"
            :loading="saving"
            data-testid="backup-save"
            @click="confirmOpen = true"
            >{{ t('common.save') }}</v-btn
          >
          <v-btn variant="text" :disabled="!dirty" @click="reset">{{ t('common.reset') }}</v-btn>
        </div>
      </v-card>

      <BackupS3Card
        v-model="s3"
        :stored="store.settings"
        :dirty="dirty"
        :saving="saving"
        @save="confirmOpen = true"
      />

      <v-card border class="pa-6 mb-6" data-testid="backup-download">
        <h2 class="text-title-large mb-1">{{ t('backup.download') }}</h2>
        <p class="text-body-medium text-medium-emphasis mb-4">{{ t('backup.downloadIntro') }}</p>
        <v-table v-if="store.preview" density="compact" class="mb-4" data-testid="backup-preview">
          <tbody>
            <tr v-for="item in store.preview.items" :key="item.kind">
              <td>{{ item.kind }}</td>
              <td class="text-end">{{ item.count }}</td>
            </tr>
            <tr class="font-weight-medium">
              <td>{{ t('backup.total') }}</td>
              <td class="text-end">{{ store.preview.total }}</td>
            </tr>
          </tbody>
        </v-table>
        <v-alert type="warning" variant="tonal" density="compact" class="mb-4">{{
          t('backup.downloadWarning')
        }}</v-alert>
        <p v-if="dirty" class="text-body-small text-medium-emphasis mb-2">
          {{ t('backup.saveFirst') }}
        </p>
        <ErrorAlert v-if="downloadError" :error="downloadError" class="mb-4" />
        <v-alert
          v-if="downloaded"
          type="success"
          variant="tonal"
          density="compact"
          class="mb-4"
          data-testid="backup-downloaded"
          >{{ t('backup.downloaded', { file: downloaded }) }}</v-alert
        >
        <v-expansion-panels variant="accordion" class="mb-4" data-testid="backup-restore-howto">
          <v-expansion-panel>
            <v-expansion-panel-title>
              <v-icon icon="mdi-help-circle-outline" size="small" class="me-2" />
              {{ t('backup.restoreTitle') }}
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <p class="text-body-medium mb-3">{{ t('backup.restoreIntro') }}</p>
              <ol class="howto">
                <li v-for="(step, i) in restoreSteps" :key="i" class="mb-3">
                  <div class="text-body-medium mb-1">{{ step.text }}</div>
                  <div class="d-flex align-center ga-1">
                    <pre class="command flex-grow-1" data-testid="backup-restore-command">{{
                      step.command
                    }}</pre>
                    <v-btn
                      :icon="copied === `restore-${i}` ? 'mdi-check' : 'mdi-content-copy'"
                      size="small"
                      variant="text"
                      :aria-label="t('common.copy')"
                      @click="copy(`restore-${i}`, step.command)"
                    />
                  </div>
                </li>
                <li class="mb-1">
                  <div class="text-body-medium">{{ t('backup.restoreTest') }}</div>
                </li>
              </ol>
              <div class="text-body-small text-medium-emphasis">{{ t('backup.restoreNote') }}</div>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
        <v-btn
          color="primary"
          prepend-icon="mdi-download-lock"
          :disabled="!canDownload"
          :loading="downloading"
          data-testid="backup-download-button"
          @click="download"
          >{{ t('backup.downloadButton') }}</v-btn
        >
      </v-card>

      <ManagementBackupCard :can-download="canDownload" />
    </template>

    <v-dialog v-model="confirmOpen" max-width="640">
      <v-card :title="t('backup.confirmTitle')">
        <v-card-text>
          <p class="mb-3">{{ t('backup.confirmText') }}</p>
          <v-table density="compact" data-testid="backup-changes">
            <tbody>
              <tr v-for="(c, i) in changes" :key="i">
                <td>{{ c.change }}</td>
                <td class="text-body-small">{{ c.what }}</td>
              </tr>
            </tbody>
          </v-table>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmOpen = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="saving" data-testid="backup-confirm" @click="save">{{
            t('common.save')
          }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<style scoped>
.settings {
  max-width: 960px;
}
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
}
.key-input :deep(textarea) {
  font-family: monospace;
  font-size: 0.8rem;
}
</style>
