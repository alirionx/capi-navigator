<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { LOG_TAIL_CHOICES, WorkloadLogsSchema, type WorkloadLogs } from '@capi-navigator/shared';
import { getJson } from '../../api/client.js';
import ErrorAlert from '../ErrorAlert.vue';
import { logLines } from './log-lines.js';

/**
 * Logs of a workload (FP18-F-07, ADR-0036): fetched only while the dialog is open, kept in this
 * component and dropped on close. Every fetch is audited by the backend.
 */
export interface LogTarget {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'Pod';
  namespace: string;
  name: string;
}
const props = defineProps<{
  connection: string;
  namespace: string;
  name: string;
  target: LogTarget | null;
}>();
const open = defineModel<boolean>({ required: true });
const { t } = useI18n();

const logs = ref<WorkloadLogs | null>(null);
const loading = ref(false);
const error = ref<unknown>(null);
const pod = ref<string | undefined>();
const container = ref<string | undefined>();
const tailChoices: number[] = [...LOG_TAIL_CHOICES];
const tailLines = ref<number>(500);
const previous = ref(false);
const timestamps = ref(false);
const wrap = ref(true);
const filter = ref('');
const box = ref<HTMLElement | null>(null);

async function load(): Promise<void> {
  if (!props.target) return;
  loading.value = true;
  error.value = null;
  const q = new URLSearchParams({
    kind: props.target.kind,
    workloadNamespace: props.target.namespace,
    workload: props.target.name,
    tailLines: String(tailLines.value),
    previous: String(previous.value),
    ...(pod.value ? { pod: pod.value } : {}),
    ...(container.value ? { container: container.value } : {}),
  });
  try {
    logs.value = await getJson(
      `/api/connections/${encodeURIComponent(props.connection)}/clusters/${encodeURIComponent(
        props.namespace,
      )}/${encodeURIComponent(props.name)}/logs?${q}`,
      WorkloadLogsSchema,
    );
    pod.value = logs.value.pod;
    container.value = logs.value.container;
    await nextTick();
    // The newest lines are at the bottom, as in a terminal.
    if (box.value) box.value.scrollTop = box.value.scrollHeight;
  } catch (err) {
    error.value = err;
  } finally {
    loading.value = false;
  }
}

watch(
  [open, () => props.target],
  ([isOpen]) => {
    logs.value = null;
    error.value = null;
    pod.value = undefined;
    container.value = undefined;
    previous.value = false;
    filter.value = '';
    if (isOpen) void load();
  },
  { immediate: true },
);

const currentPod = computed(() => logs.value?.pods.find((p) => p.name === pod.value));
function choosePod(name: string): void {
  pod.value = name;
  container.value = undefined;
  previous.value = false;
  void load();
}

const lines = computed(() => logLines(logs.value?.text ?? '', filter.value, timestamps.value));
const shown = computed(() => lines.value.filter((l) => l.match));

function download(): void {
  const blob = new Blob([logs.value?.text ?? ''], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${pod.value ?? props.target?.name}-${container.value ?? 'logs'}${previous.value ? '-previous' : ''}.log`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <v-dialog v-model="open" max-width="1200" scrollable>
    <v-card data-testid="logs-dialog">
      <v-card-item>
        <v-card-title>
          {{ t('logs.title') }} ·
          <span class="text-medium-emphasis">{{ target?.kind }}</span>
          {{ target?.namespace }}/{{ target?.name }}
        </v-card-title>
        <v-card-subtitle>{{ t('logs.hint') }}</v-card-subtitle>
      </v-card-item>
      <!-- Room above the first row: the outlined fields' labels float above their border. -->
      <v-card-text class="pt-2 pb-0">
        <div class="d-flex flex-wrap align-center ga-3 mb-3">
          <v-select
            :model-value="pod"
            :items="logs?.pods ?? []"
            item-title="name"
            item-value="name"
            :label="t('logs.pod')"
            hide-details
            density="compact"
            style="max-width: 22rem"
            data-testid="logs-pod"
            @update:model-value="choosePod"
          >
            <template #item="{ props: itemProps, item }">
              <v-list-item v-bind="itemProps">
                <template #append>
                  <v-chip
                    size="x-small"
                    variant="tonal"
                    :color="item.ready ? 'success' : 'warning'"
                    >{{ item.ready ? t('clusters.ready') : item.phase }}</v-chip
                  >
                  <v-chip
                    v-if="item.restarts"
                    size="x-small"
                    variant="tonal"
                    color="warning"
                    class="ml-1"
                    >{{ t('logs.restarts', { n: item.restarts }) }}</v-chip
                  >
                </template>
              </v-list-item>
            </template>
          </v-select>
          <v-select
            v-model="container"
            :items="currentPod?.containers ?? []"
            :label="t('logs.container')"
            hide-details
            density="compact"
            style="max-width: 14rem"
            data-testid="logs-container"
            @update:model-value="load"
          />
          <v-select
            v-model="tailLines"
            :items="tailChoices"
            :label="t('logs.lines')"
            hide-details
            density="compact"
            style="max-width: 8rem"
            @update:model-value="load"
          />
          <v-switch
            v-model="previous"
            :label="t('logs.previous')"
            :disabled="!currentPod?.restarts && !previous"
            hide-details
            density="compact"
            data-testid="logs-previous"
            @update:model-value="load"
          />
          <v-spacer />
          <v-btn
            icon="mdi-refresh"
            variant="text"
            size="small"
            :loading="loading"
            :title="t('logs.refresh')"
            data-testid="logs-refresh"
            @click="load"
          />
          <v-btn
            icon="mdi-download"
            variant="text"
            size="small"
            :disabled="!logs?.text"
            :title="t('yaml.download')"
            @click="download"
          />
        </div>
        <div class="d-flex flex-wrap align-center ga-3 mb-2">
          <v-text-field
            v-model="filter"
            :label="t('logs.filter')"
            prepend-inner-icon="mdi-magnify"
            clearable
            hide-details
            density="compact"
            style="max-width: 22rem"
            data-testid="logs-filter"
          />
          <span v-if="filter" class="text-body-small text-medium-emphasis">{{
            t('logs.matches', { n: shown.length, total: lines.length })
          }}</span>
          <v-spacer />
          <v-switch
            v-model="timestamps"
            :label="t('logs.timestamps')"
            hide-details
            density="compact"
          />
          <v-switch v-model="wrap" :label="t('logs.wrap')" hide-details density="compact" />
        </div>
        <ErrorAlert v-if="error" :error="error" class="mb-2" />
        <v-progress-linear v-if="loading && !logs" indeterminate />
        <v-alert
          v-if="logs?.hint"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-2"
          data-testid="logs-info"
          >{{ logs.hint }}</v-alert
        >
        <div v-if="logs?.truncated" class="text-body-small text-medium-emphasis mb-1">
          {{ t('logs.truncated', { n: tailLines }) }}
        </div>
        <div v-if="logs?.text" ref="box" class="log-box" :class="{ wrap }" data-testid="logs-text">
          <div v-for="l in shown" :key="l.n" class="log-line" :class="`level-${l.level}`">
            <span class="line-no">{{ l.n }}</span
            ><span v-if="l.time" class="time">{{ l.time }} </span>{{ l.text }}
          </div>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">{{ t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.log-box {
  height: 60vh;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 0.8125rem;
  line-height: 1.5;
  overflow: auto;
  padding: 8px 0;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.04);
  white-space: pre;
}
.log-box.wrap {
  white-space: pre-wrap;
  word-break: break-all;
}
.log-line {
  padding: 0 12px 0 0;
}
.line-no {
  display: inline-block;
  min-width: 4em;
  padding: 0 12px 0 8px;
  text-align: right;
  user-select: none;
  opacity: 0.45;
}
.time {
  opacity: 0.6;
}
.level-error {
  color: rgb(var(--v-theme-error));
}
.level-warn {
  color: rgb(var(--v-theme-warning));
}
</style>
