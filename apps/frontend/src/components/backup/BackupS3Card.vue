<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  BackupCronSchema,
  BackupS3TargetSchema,
  BackupScheduleSchema,
  nextBackupRuns,
  type BackupS3TestResult,
  type BackupSettings,
} from '@capi-navigator/shared';
import ErrorAlert from '../ErrorAlert.vue';
import FieldHelp from '../FieldHelp.vue';
import { zodRule } from '../../forms/zod-rules.js';
import { useBackupStore } from '../../stores/backup.js';
import { useConnectionsStore } from '../../stores/connections.js';
import { s3Target, type S3Draft } from './s3-draft.js';

/**
 * Scheduled backups to S3 (FP38-F-10 to F-14): target, access key (write-only), schedule,
 * connection test, "Back up now" and the last runs. Saving goes through the page, which sends the
 * whole settings with the keys.
 */
const props = defineProps<{ stored: BackupSettings; dirty: boolean; saving: boolean }>();
const draft = defineModel<S3Draft>({ required: true });
const emit = defineEmits<{ save: [] }>();
const { t, d } = useI18n();
const store = useBackupStore();
const connections = useConnectionsStore();
/** FP39-F-11: connections to choose from, plus stored ones that no longer exist. */
const connectionItems = computed(() => [
  ...new Set([...connections.connections.map((c) => c.name), ...draft.value.managementClusters]),
]);

const testing = ref(false);
const testResult = ref<BackupS3TestResult | null>(null);
const running = ref(false);
const runError = ref<unknown>(null);

const shape = BackupS3TargetSchema.shape;
const cronRule = zodRule(BackupCronSchema);
const keepRule = zodRule(BackupScheduleSchema.shape.keep);
const targetValid = computed(() => BackupS3TargetSchema.safeParse(s3Target(draft.value)).success);
const credentialsSet = computed(() => !!props.stored.s3?.credentialsSet);
const credentialsGiven = computed(() => !!draft.value.accessKeyId && !!draft.value.secretAccessKey);

/** Next runs of the cron expression as entered, in the browser's time zone. */
const nextRuns = computed(() => {
  if (cronRule(draft.value.schedule.cron) !== true) return [];
  try {
    return nextBackupRuns(draft.value.schedule.cron, new Date(), 3);
  } catch {
    return [];
  }
});

async function test(): Promise<void> {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await store.testS3({
      s3: BackupS3TargetSchema.parse(s3Target(draft.value)),
      ...(credentialsGiven.value
        ? {
            s3Credentials: {
              accessKeyId: draft.value.accessKeyId,
              secretAccessKey: draft.value.secretAccessKey,
            },
          }
        : {}),
    });
  } catch (err) {
    testResult.value = { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    testing.value = false;
  }
}

async function runNow(): Promise<void> {
  running.value = true;
  runError.value = null;
  try {
    await store.runS3();
  } catch (err) {
    runError.value = err;
  } finally {
    running.value = false;
  }
}

function size(bytes?: number): string {
  if (bytes === undefined) return '';
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <v-card border class="pa-6 mb-6" data-testid="backup-s3">
    <div class="d-flex align-center mb-1">
      <h2 class="text-title-large">{{ t('backup.s3.title') }}</h2>
      <FieldHelp :text="t('backup.s3.titleHint')" />
    </div>
    <p class="text-body-medium text-medium-emphasis mb-4">{{ t('backup.s3.intro') }}</p>

    <v-switch v-model="draft.enabled" color="primary" data-testid="backup-s3-enabled">
      <template #label>{{ t('backup.s3.enabled') }}</template>
    </v-switch>

    <template v-if="draft.enabled">
      <v-row dense>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="draft.bucket"
            :label="t('backup.s3.bucket')"
            :rules="[zodRule(shape.bucket)]"
            data-testid="backup-s3-bucket"
          >
            <template #append-inner><FieldHelp :text="t('backup.s3.bucketHint')" /></template>
          </v-text-field>
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="draft.prefix"
            :label="t('backup.s3.prefix')"
            :rules="[zodRule(shape.prefix)]"
            data-testid="backup-s3-prefix"
          >
            <template #append-inner><FieldHelp :text="t('backup.s3.prefixHint')" /></template>
          </v-text-field>
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="draft.endpoint"
            :label="t('backup.s3.endpoint')"
            :rules="draft.endpoint ? [zodRule(shape.endpoint)] : []"
            placeholder="https://minio.example.com:9000"
            data-testid="backup-s3-endpoint"
          >
            <template #append-inner><FieldHelp :text="t('backup.s3.endpointHint')" /></template>
          </v-text-field>
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="draft.region"
            :label="t('backup.s3.region')"
            :rules="[zodRule(shape.region)]"
            data-testid="backup-s3-region"
          >
            <template #append-inner><FieldHelp :text="t('backup.s3.regionHint')" /></template>
          </v-text-field>
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="draft.accessKeyId"
            :label="t('backup.s3.accessKeyId')"
            :placeholder="credentialsSet ? '••••••••' : ''"
            persistent-placeholder
            autocomplete="off"
            data-testid="backup-s3-access-key"
          >
            <template #append-inner><FieldHelp :text="t('backup.s3.accessKeyHint')" /></template>
          </v-text-field>
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="draft.secretAccessKey"
            :label="t('backup.s3.secretAccessKey')"
            type="password"
            autocomplete="new-password"
            :placeholder="credentialsSet ? '••••••••' : ''"
            persistent-placeholder
            data-testid="backup-s3-secret-key"
          />
        </v-col>
      </v-row>
      <v-switch v-model="draft.forcePathStyle" color="primary" density="compact">
        <template #label>
          {{ t('backup.s3.forcePathStyle') }}
          <FieldHelp :text="t('backup.s3.forcePathStyleHint')" />
        </template>
      </v-switch>
      <v-switch
        v-model="draft.insecureSkipTLSVerify"
        color="warning"
        density="compact"
        data-testid="backup-s3-insecure"
      >
        <template #label>
          {{ t('backup.s3.insecure') }}
          <FieldHelp :text="t('backup.s3.insecureHint')" />
        </template>
      </v-switch>
      <v-alert
        v-if="draft.insecureSkipTLSVerify"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-4"
        data-testid="backup-s3-insecure-warning"
        >{{ t('backup.s3.insecureWarning') }}</v-alert
      >
      <v-textarea
        v-else
        v-model="draft.caCertificate"
        :label="t('backup.s3.caCertificate')"
        :rules="draft.caCertificate ? [zodRule(shape.caCertificate)] : []"
        rows="2"
        auto-grow
        class="mono"
        spellcheck="false"
      >
        <template #append-inner><FieldHelp :text="t('backup.s3.caCertificateHint')" /></template>
      </v-textarea>

      <div class="d-flex align-center ga-2 mb-2">
        <v-btn
          variant="tonal"
          prepend-icon="mdi-connection"
          :loading="testing"
          :disabled="!targetValid || (!credentialsSet && !credentialsGiven)"
          data-testid="backup-s3-test"
          @click="test"
          >{{ t('backup.s3.test') }}</v-btn
        >
      </div>
      <v-alert
        v-if="testResult"
        :type="testResult.ok ? 'success' : 'error'"
        variant="tonal"
        density="compact"
        class="mb-4"
        data-testid="backup-s3-test-result"
      >
        <div>{{ testResult.message }}</div>
        <div v-if="testResult.hint" class="text-body-small">{{ testResult.hint }}</div>
        <details v-if="testResult.details" class="text-body-small mt-1">
          <summary>{{ t('errors.details') }}</summary>
          <pre class="mono">{{ testResult.details }}</pre>
        </details>
      </v-alert>

      <v-select
        v-model="draft.managementClusters"
        :items="connectionItems"
        :label="t('backup.s3.managementClusters')"
        multiple
        chips
        closable-chips
        class="mt-2"
        data-testid="backup-s3-mgmt"
      >
        <template #append-inner
          ><FieldHelp :text="t('backup.s3.managementClustersHint')"
        /></template>
      </v-select>

      <v-divider class="my-4" />
      <v-switch v-model="draft.schedule.enabled" color="primary" data-testid="backup-schedule">
        <template #label>
          {{ t('backup.s3.schedule') }}
          <FieldHelp :text="t('backup.s3.scheduleHint')" />
        </template>
      </v-switch>
      <v-row v-if="draft.schedule.enabled" dense>
        <v-col cols="12" md="6">
          <v-text-field
            v-model="draft.schedule.cron"
            :label="t('backup.s3.cron')"
            :rules="[cronRule]"
            class="mono"
            data-testid="backup-schedule-cron"
          >
            <template #append-inner><FieldHelp :text="t('backup.s3.cronHint')" /></template>
          </v-text-field>
          <div v-if="nextRuns.length" class="text-body-small text-medium-emphasis mb-2">
            {{ t('backup.s3.nextRuns') }}:
            {{ nextRuns.map((r) => d(r, 'short')).join(' · ') }}
          </div>
        </v-col>
        <v-col cols="12" md="6">
          <v-text-field
            v-model.number="draft.schedule.keep"
            type="number"
            :label="t('backup.s3.keep')"
            :rules="[keepRule]"
            data-testid="backup-schedule-keep"
          >
            <template #append-inner><FieldHelp :text="t('backup.s3.keepHint')" /></template>
          </v-text-field>
        </v-col>
      </v-row>
    </template>

    <div class="d-flex flex-wrap ga-2 mt-2">
      <v-btn
        color="primary"
        :disabled="!dirty"
        :loading="saving"
        data-testid="backup-s3-save"
        @click="emit('save')"
        >{{ t('common.save') }}</v-btn
      >
      <v-btn
        v-if="stored.s3"
        variant="tonal"
        prepend-icon="mdi-cloud-upload"
        :disabled="dirty || stored.recipients.length === 0"
        :loading="running"
        data-testid="backup-s3-run"
        @click="runNow"
        >{{ t('backup.s3.runNow') }}</v-btn
      >
    </div>
    <p v-if="stored.nextRun" class="text-body-small text-medium-emphasis mt-2">
      {{ t('backup.s3.nextRun', { at: d(new Date(stored.nextRun), 'short') }) }}
    </p>
    <ErrorAlert v-if="runError" :error="runError" class="mt-4" />

    <template v-if="stored.runs.length">
      <h3 class="text-title-medium mt-6 mb-2">{{ t('backup.s3.runs') }}</h3>
      <v-table density="compact" data-testid="backup-s3-runs">
        <tbody>
          <tr v-for="run in stored.runs" :key="run.startedAt">
            <td style="width: 32px">
              <v-icon
                :icon="run.outcome === 'success' ? 'mdi-check' : 'mdi-close'"
                :color="run.outcome === 'success' ? 'success' : 'error'"
                size="small"
              />
            </td>
            <td class="text-body-small text-no-wrap">{{ d(new Date(run.startedAt), 'short') }}</td>
            <td class="text-body-small">{{ t(`backup.s3.trigger.${run.trigger}`) }}</td>
            <td class="text-body-small">
              <template v-if="run.outcome === 'success'">
                <code>{{ run.objectKey }}</code> · {{ size(run.size) }}
                <span v-if="run.deleted"> · {{ t('backup.s3.deleted', { n: run.deleted }) }}</span>
              </template>
              <template v-else>
                {{ run.message }}
                <div v-if="run.hint" class="text-medium-emphasis">{{ run.hint }}</div>
              </template>
              <div
                v-for="target in run.targets ?? []"
                :key="target.connection"
                class="d-flex align-start ga-1 mt-1"
                data-testid="backup-s3-run-target"
              >
                <v-icon
                  :icon="target.outcome === 'success' ? 'mdi-check' : 'mdi-close'"
                  :color="target.outcome === 'success' ? 'success' : 'error'"
                  size="x-small"
                  class="mt-1"
                />
                <div>
                  <span class="font-weight-medium">{{ target.connection }}</span>
                  <template v-if="target.outcome === 'success'">
                    · <code>{{ target.objectKey }}</code> · {{ size(target.size) }}
                    <span v-if="target.deleted">
                      · {{ t('backup.s3.deleted', { n: target.deleted }) }}</span
                    >
                  </template>
                  <template v-else>
                    · {{ target.message }}
                    <div v-if="target.hint" class="text-medium-emphasis">{{ target.hint }}</div>
                  </template>
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </v-table>
    </template>
  </v-card>
</template>

<style scoped>
.mono :deep(textarea),
.mono :deep(input),
pre.mono {
  font-family: monospace;
  font-size: 0.85rem;
}
</style>
