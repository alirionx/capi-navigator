<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { DashboardSchema, type Dashboard, type ResourceUse } from '@capi-navigator/shared';
import { liveStream } from '../../api/live.js';
import { formatAge, useNow } from '../../composables/age.js';
import UsageBar from './UsageBar.vue';

/**
 * Read-only dashboard of a workload cluster (FP-18): usage, workloads, network and events,
 * refreshed every 15 s while it is shown (ADR-0009).
 */
const props = defineProps<{ connection: string; namespace: string; name: string }>();
const { t } = useI18n();
const now = useNow(5000);

const d = ref<Dashboard | null>(null);
const error = ref<string | null>(null);
const live = ref(false);
let stop: (() => void) | null = null;

watch(
  () => [props.connection, props.namespace, props.name] as const,
  ([c, ns, n]) => {
    stop?.();
    d.value = null;
    stop = liveStream(
      `/api/connections/${encodeURIComponent(c)}/clusters/${encodeURIComponent(ns)}/${encodeURIComponent(n)}/dashboard/events`,
      DashboardSchema,
      {
        state: (s) => {
          d.value = s;
          error.value = null;
        },
        error: (m) => (error.value = m),
        live: (on) => (live.value = on),
      },
    );
  },
  { immediate: true },
);
onBeforeUnmount(() => stop?.());

// ---- filters ----
const namespaces = computed(() =>
  [
    ...new Set([
      ...(d.value?.workloads.map((w) => w.namespace) ?? []),
      ...(d.value?.events.map((e) => e.namespace) ?? []),
    ]),
  ].sort(),
);
const ns = ref<string | null>(null);
const onlyProblems = ref(false);
const onlyWarnings = ref(false);
const inNs = (x: { namespace: string }) => !ns.value || x.namespace === ns.value;

const workloads = computed(
  () =>
    d.value?.workloads.filter((w) => inNs(w) && (!onlyProblems.value || w.status !== 'ok')) ?? [],
);
const events = computed(
  () =>
    d.value?.events.filter((e) => inNs(e) && (!onlyWarnings.value || e.type === 'Warning')) ?? [],
);
const warningCount = computed(
  () => d.value?.events.filter((e) => e.type === 'Warning').length ?? 0,
);

const sum = (pick: (n: Dashboard['nodes'][number]) => ResourceUse): ResourceUse => {
  const nodes = d.value?.nodes ?? [];
  const add = (k: keyof ResourceUse) => nodes.reduce((s, n) => s + (pick(n)[k] ?? 0), 0);
  return {
    capacity: add('capacity'),
    allocatable: add('allocatable'),
    requests: add('requests'),
    limits: add('limits'),
    ...(d.value?.metricsAvailable ? { usage: add('usage') } : {}),
  };
};
const totalCpu = computed(() => sum((n) => n.cpu));
const totalMem = computed(() => sum((n) => n.memory));

const statusColor = (s: string) => (s === 'ok' ? 'success' : s === 'degraded' ? 'error' : 'info');
const phaseColor = (p: string) =>
  p === 'Running' || p === 'Succeeded' ? 'success' : p === 'Failed' ? 'error' : 'info';
const when = (iso?: string) => (iso ? formatAge(iso, now.value) : '–');
</script>

<template>
  <div data-testid="cluster-dashboard">
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-progress-linear v-if="!d && !error" indeterminate />

    <template v-if="d">
      <!-- Summary -->
      <div class="d-flex flex-wrap align-center ga-2 mb-4">
        <v-chip
          v-if="d.kubernetesVersion"
          size="small"
          variant="tonal"
          prepend-icon="mdi-kubernetes"
          >{{ d.kubernetesVersion }}</v-chip
        >
        <v-chip
          size="small"
          variant="tonal"
          :color="d.totals.readyNodes === d.totals.nodes ? 'success' : 'warning'"
          >{{ d.totals.readyNodes }}/{{ d.totals.nodes }} {{ t('dashboard.nodesReady') }}</v-chip
        >
        <v-chip size="small" variant="tonal"
          >{{ d.totals.namespaces }} {{ t('dashboard.namespaces') }}</v-chip
        >
        <v-chip
          v-for="(n, phase) in d.totals.podPhases"
          :key="phase"
          size="small"
          variant="tonal"
          :color="phaseColor(String(phase))"
          >{{ n }} {{ phase }}</v-chip
        >
        <v-chip v-for="(n, type) in d.totals.services" :key="type" size="small" variant="outlined"
          >{{ n }} {{ type }}</v-chip
        >
        <v-spacer />
        <span class="text-caption text-medium-emphasis">
          {{ t('dashboard.updated', { age: when(d.generatedAt) }) }}
        </span>
        <v-chip
          :color="live ? 'success' : 'grey'"
          variant="tonal"
          size="small"
          prepend-icon="mdi-access-point"
          >{{ live ? t('providers.live') : t('providers.connecting') }}</v-chip
        >
      </div>
      <v-alert
        v-for="w in d.warnings"
        :key="w"
        type="info"
        variant="tonal"
        density="compact"
        class="mb-2"
        >{{ w }}</v-alert
      >

      <!-- Usage -->
      <v-row>
        <v-col cols="12" md="4">
          <v-card border class="fill-height" data-testid="dash-total">
            <v-card-item :title="t('dashboard.cluster')" :subtitle="t('dashboard.clusterHint')" />
            <v-card-text class="d-flex flex-column ga-4">
              <UsageBar :label="t('dashboard.cpu')" :use="totalCpu" kind="cpu" />
              <UsageBar :label="t('dashboard.memory')" :use="totalMem" kind="memory" />
            </v-card-text>
          </v-card>
        </v-col>
        <v-col v-for="n in d.nodes" :key="n.name" cols="12" md="4">
          <v-card border class="fill-height" :data-testid="`dash-node-${n.name}`">
            <v-card-item>
              <v-card-title class="text-body-1 font-weight-medium text-truncate" :title="n.name">{{
                n.name
              }}</v-card-title>
              <v-card-subtitle
                >{{ n.roles.join(', ') || 'worker' }} · {{ n.pods.count }}/{{
                  n.pods.capacity
                }}
                pods</v-card-subtitle
              >
              <template #append>
                <v-chip size="x-small" variant="tonal" :color="n.ready ? 'success' : 'error'">{{
                  n.ready ? t('clusters.ready') : t('shell.notReady')
                }}</v-chip>
                <v-chip
                  v-if="n.unschedulable"
                  size="x-small"
                  variant="tonal"
                  color="warning"
                  class="ml-1"
                  >{{ t('dashboard.cordoned') }}</v-chip
                >
              </template>
            </v-card-item>
            <v-card-text class="d-flex flex-column ga-4">
              <UsageBar :label="t('dashboard.cpu')" :use="n.cpu" kind="cpu" />
              <UsageBar :label="t('dashboard.memory')" :use="n.memory" kind="memory" />
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- Problem pods -->
      <v-card v-if="d.problemPods.length" border class="mt-4" data-testid="dash-problems">
        <v-card-item :title="t('dashboard.problemPods')">
          <template #prepend><v-icon icon="mdi-alert" color="warning" /></template>
        </v-card-item>
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ t('dashboard.pod') }}</th>
              <th>{{ t('dashboard.reason') }}</th>
              <th>{{ t('dashboard.restarts') }}</th>
              <th>{{ t('clusters.node') }}</th>
              <th>{{ t('clusters.eventMessage') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in d.problemPods" :key="p.namespace + p.name">
              <td class="text-no-wrap">
                <span class="text-medium-emphasis">{{ p.namespace }}/</span>{{ p.name }}
              </td>
              <td>
                <v-chip size="x-small" variant="tonal" color="warning">{{ p.reason }}</v-chip>
              </td>
              <td>{{ p.restarts }}</td>
              <td class="text-caption">{{ p.node ?? '–' }}</td>
              <td class="text-caption">{{ p.message ?? '' }}</td>
            </tr>
          </tbody>
        </v-table>
      </v-card>

      <!-- Filters -->
      <div class="d-flex flex-wrap align-center ga-3 mt-6 mb-2">
        <v-select
          v-model="ns"
          :items="namespaces"
          :label="t('clusters.namespace')"
          clearable
          hide-details
          style="max-width: 18rem"
          data-testid="dash-namespace"
        />
      </div>

      <v-row>
        <!-- Workloads -->
        <v-col cols="12" lg="6">
          <v-card border class="fill-height" data-testid="dash-workloads">
            <v-card-item :title="t('dashboard.workloads')">
              <template #append>
                <v-switch
                  v-model="onlyProblems"
                  :label="t('dashboard.onlyProblems')"
                  hide-details
                  density="compact"
                />
              </template>
            </v-card-item>
            <v-table density="compact" class="scroll">
              <thead>
                <tr>
                  <th>{{ t('dashboard.kind') }}</th>
                  <th>{{ t('clusters.name') }}</th>
                  <th>{{ t('dashboard.ready') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="w in workloads" :key="w.kind + w.namespace + w.name">
                  <td class="text-caption">{{ w.kind }}</td>
                  <td class="text-no-wrap">
                    <span class="text-medium-emphasis">{{ w.namespace }}/</span>{{ w.name }}
                  </td>
                  <td>
                    <v-chip size="x-small" variant="tonal" :color="statusColor(w.status)"
                      >{{ w.ready }}/{{ w.desired }}</v-chip
                    >
                  </td>
                </tr>
                <tr v-if="!workloads.length">
                  <td colspan="3" class="text-medium-emphasis">{{ t('dashboard.none') }}</td>
                </tr>
              </tbody>
            </v-table>
          </v-card>
        </v-col>

        <!-- Network -->
        <v-col cols="12" lg="6">
          <v-card border class="fill-height" data-testid="dash-network">
            <v-card-item :title="t('dashboard.network')" />
            <v-card-text>
              <div class="text-subtitle-2 mb-1">{{ t('dashboard.exposedServices') }}</div>
              <v-table density="compact" class="mb-4">
                <tbody>
                  <tr v-for="s in d.services.filter(inNs)" :key="s.namespace + s.name">
                    <td class="text-no-wrap">
                      <span class="text-medium-emphasis">{{ s.namespace }}/</span>{{ s.name }}
                    </td>
                    <td>
                      <v-chip size="x-small" variant="outlined">{{ s.type }}</v-chip>
                    </td>
                    <td class="font-monospace text-caption">
                      {{
                        s.external.join(', ') ||
                        (s.type === 'LoadBalancer' ? t('dashboard.pendingIP') : '')
                      }}
                    </td>
                    <td class="text-caption">{{ s.ports.join(', ') }}</td>
                  </tr>
                  <tr v-if="!d.services.filter(inNs).length">
                    <td class="text-medium-emphasis">{{ t('dashboard.noExposed') }}</td>
                  </tr>
                </tbody>
              </v-table>
              <div class="text-subtitle-2 mb-1">{{ t('dashboard.ingresses') }}</div>
              <v-table density="compact">
                <tbody>
                  <tr v-for="i in d.ingresses.filter(inNs)" :key="i.kind + i.namespace + i.name">
                    <td class="text-no-wrap">
                      <span class="text-medium-emphasis">{{ i.namespace }}/</span>{{ i.name }}
                      <div class="text-caption text-medium-emphasis">
                        {{ i.kind }}{{ i.className ? ` · ${i.className}` : '' }}
                      </div>
                    </td>
                    <td>
                      <div v-for="h in i.hosts" :key="h" class="text-caption">
                        <v-icon v-if="i.tls" icon="mdi-lock" size="x-small" class="mr-1" />{{ h }}
                      </div>
                    </td>
                    <td class="text-caption">→ {{ i.backends.join(', ') || '–' }}</td>
                    <td class="font-monospace text-caption">{{ i.addresses.join(', ') }}</td>
                  </tr>
                  <tr v-if="!d.ingresses.filter(inNs).length">
                    <td class="text-medium-emphasis">{{ t('dashboard.noIngresses') }}</td>
                  </tr>
                </tbody>
              </v-table>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- Events -->
      <v-card border class="mt-4" data-testid="dash-events">
        <v-card-item :title="t('dashboard.events')">
          <template #append>
            <v-switch
              v-model="onlyWarnings"
              :label="t('dashboard.onlyWarnings', { n: warningCount })"
              hide-details
              density="compact"
            />
          </template>
        </v-card-item>
        <v-table density="compact" class="scroll">
          <tbody>
            <tr v-for="(e, i) in events" :key="i">
              <td style="width: 2rem">
                <v-icon
                  :icon="e.type === 'Warning' ? 'mdi-alert' : 'mdi-information-outline'"
                  :color="e.type === 'Warning' ? 'warning' : undefined"
                  size="small"
                />
              </td>
              <td class="text-no-wrap text-caption">
                <span class="text-medium-emphasis">{{ e.namespace }}/</span>{{ e.object.kind }}/{{
                  e.object.name
                }}
              </td>
              <td class="text-caption">{{ e.reason }}</td>
              <td class="text-caption">
                {{ e.message }}<span v-if="e.count > 1"> (×{{ e.count }})</span>
              </td>
              <td class="text-caption text-no-wrap">{{ when(e.lastSeen) }}</td>
            </tr>
            <tr v-if="!events.length">
              <td colspan="5" class="text-medium-emphasis">{{ t('clusters.noEvents') }}</td>
            </tr>
          </tbody>
        </v-table>
      </v-card>
    </template>
  </div>
</template>

<style scoped>
.scroll {
  max-height: 420px;
  overflow-y: auto;
}
</style>
