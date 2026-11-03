<script setup lang="ts">
import YamlButton from '../YamlButton.vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { DashboardSchema, type Dashboard, type ResourceUse } from '@capi-navigator/shared';
import { liveStream } from '../../api/live.js';
import { formatAge, useNow } from '../../composables/age.js';
import UsageBar from './UsageBar.vue';
import WorkloadLogsDialog, { type LogTarget } from './WorkloadLogsDialog.vue';
import { useAuthStore } from '../../stores/auth.js';

/**
 * Read-only dashboard of a workload cluster (FP-18): usage, workloads, network and events,
 * refreshed every 15 s while it is shown (ADR-0009).
 */
const props = defineProps<{ connection: string; namespace: string; name: string }>();
const { t } = useI18n();
const now = useNow(5000);
const auth = useAuthStore();

/** FP18-F-07: logs need their own permission, since they may contain secrets (ADR-0036). */
const canLogs = computed(() =>
  auth.can('clusters.logs', { connection: props.connection, namespace: props.namespace }),
);
const logTarget = ref<LogTarget | null>(null);
const logsOpen = ref(false);
function showLogs(target: LogTarget): void {
  logTarget.value = target;
  logsOpen.value = true;
}

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
const onlyExposed = ref(false);
const onlyWarnings = ref(false);
const inNs = (x: { namespace: string }) => !ns.value || x.namespace === ns.value;

const workloads = computed(
  () =>
    d.value?.workloads.filter((w) => inNs(w) && (!onlyProblems.value || w.status !== 'ok')) ?? [],
);
/** Reachable from outside the cluster: LoadBalancer, NodePort or behind a route (UX-09). */
const exposed = (s: Dashboard['services'][number]) =>
  s.type === 'LoadBalancer' || s.type === 'NodePort' || s.routes.length > 0;
const services = computed(
  () => d.value?.services.filter((s) => inNs(s) && (!onlyExposed.value || exposed(s))) ?? [],
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

const statusColor = (s: string) =>
  s === 'ok' ? 'success' : s === 'degraded' ? 'error' : s === 'none' ? 'grey' : 'info';
const phaseColor = (p: string) =>
  p === 'Running' || p === 'Succeeded' ? 'success' : p === 'Failed' ? 'error' : 'info';
const when = (iso?: string) => (iso ? formatAge(iso, now.value) : '–');

/** "View YAML" of an object inside the workload cluster (FP7-F-01, FP-18). */
const API_VERSION: Record<string, string> = {
  Node: 'v1',
  Pod: 'v1',
  Service: 'v1',
  Deployment: 'apps/v1',
  StatefulSet: 'apps/v1',
  DaemonSet: 'apps/v1',
  Job: 'batch/v1',
  Ingress: 'networking.k8s.io/v1',
  HTTPRoute: 'gateway.networking.k8s.io/v1',
};
const inCluster = (kind: string, name: string, namespace?: string) => ({
  apiVersion: API_VERSION[kind] ?? 'v1',
  kind,
  name,
  ...(namespace ? { namespace } : {}),
  cluster: { namespace: props.namespace, name: props.name },
});
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
        <span class="text-body-small text-medium-emphasis">
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
              <v-card-title
                class="text-body-large font-weight-medium text-truncate"
                :title="n.name"
                >{{ n.name }}</v-card-title
              >
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
                <YamlButton :target="inCluster('Node', n.name)" />
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
              <td class="text-body-small">{{ p.node ?? '–' }}</td>
              <td class="text-body-small">{{ p.message ?? '' }}</td>
              <td class="text-no-wrap">
                <v-btn
                  v-if="canLogs"
                  icon="mdi-text-box-search-outline"
                  variant="text"
                  size="x-small"
                  :title="t('logs.show')"
                  :data-testid="`logs-Pod-${p.namespace}-${p.name}`"
                  @click="showLogs({ kind: 'Pod', namespace: p.namespace, name: p.name })"
                />
                <YamlButton :target="inCluster('Pod', p.name, p.namespace)" />
              </td>
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
        <v-col cols="12" xl="5">
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
                  <td class="text-body-small">{{ w.kind }}</td>
                  <td class="text-no-wrap">
                    <span class="text-medium-emphasis">{{ w.namespace }}/</span>{{ w.name }}
                  </td>
                  <td>
                    <v-chip size="x-small" variant="tonal" :color="statusColor(w.status)"
                      >{{ w.ready }}/{{ w.desired }}</v-chip
                    >
                    <v-btn
                      v-if="canLogs"
                      icon="mdi-text-box-search-outline"
                      variant="text"
                      size="x-small"
                      :title="t('logs.show')"
                      :data-testid="`logs-${w.kind}-${w.namespace}-${w.name}`"
                      @click="showLogs({ kind: w.kind, namespace: w.namespace, name: w.name })"
                    />
                    <YamlButton :target="inCluster(w.kind, w.name, w.namespace)" />
                  </td>
                </tr>
                <tr v-if="!workloads.length">
                  <td colspan="3" class="text-medium-emphasis">{{ t('dashboard.none') }}</td>
                </tr>
              </tbody>
            </v-table>
          </v-card>
        </v-col>

        <!-- Services: routes → service → ready endpoints → workloads (FP18-F-03, UX-09) -->
        <v-col cols="12" xl="7">
          <v-card border class="fill-height" data-testid="dash-services">
            <v-card-item :title="t('dashboard.services')" :subtitle="t('dashboard.servicesHint')">
              <template #append>
                <v-switch
                  v-model="onlyExposed"
                  :label="t('dashboard.onlyExposed')"
                  hide-details
                  density="compact"
                  data-testid="dash-only-exposed"
                />
              </template>
            </v-card-item>
            <v-table density="compact" class="scroll">
              <thead>
                <tr>
                  <th>{{ t('dashboard.service') }}</th>
                  <th>{{ t('dashboard.access') }}</th>
                  <th>{{ t('dashboard.backend') }}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="s in services"
                  :key="s.namespace + s.name"
                  :data-testid="`dash-service-${s.namespace}-${s.name}`"
                >
                  <td class="text-no-wrap">
                    <span class="text-medium-emphasis">{{ s.namespace }}/</span>{{ s.name }}
                    <div class="text-body-small text-medium-emphasis">
                      <v-chip v-if="s.missing" size="x-small" variant="tonal" color="error">{{
                        t('dashboard.missingService')
                      }}</v-chip>
                      <template v-else>{{ s.type }}</template>
                    </div>
                  </td>
                  <td class="text-body-small">
                    <div
                      v-for="r in s.routes"
                      :key="r.kind + r.name + r.host"
                      class="text-no-wrap"
                      :title="`${r.kind} ${s.namespace}/${r.name}`"
                    >
                      <v-icon
                        :icon="r.tls ? 'mdi-lock' : 'mdi-web'"
                        size="x-small"
                        class="mr-1"
                      />{{ r.host }}
                      <YamlButton :target="inCluster(r.kind, r.name, s.namespace)" />
                    </div>
                    <div v-if="s.external.length" class="font-monospace">
                      {{ s.external.join(', ') }}
                    </div>
                    <div v-else-if="s.type === 'LoadBalancer'" class="text-medium-emphasis">
                      {{ t('dashboard.pendingIP') }}
                    </div>
                    <div class="text-medium-emphasis">{{ s.ports.join(', ') }}</div>
                  </td>
                  <td class="text-body-small">
                    <v-chip
                      v-if="s.endpoints"
                      size="x-small"
                      variant="tonal"
                      :color="statusColor(s.status)"
                      :title="t('dashboard.readyPods')"
                      >{{ s.endpoints.ready }}/{{ s.endpoints.total }}</v-chip
                    >
                    <span v-else-if="!s.missing" class="text-medium-emphasis">{{
                      t('dashboard.noSelector')
                    }}</span>
                    <div v-for="w in s.workloads" :key="w.kind + w.name" class="text-no-wrap">
                      <span class="text-medium-emphasis">{{ w.kind }}</span> {{ w.name }}
                    </div>
                  </td>
                  <td>
                    <YamlButton
                      v-if="!s.missing"
                      :target="inCluster('Service', s.name, s.namespace)"
                    />
                  </td>
                </tr>
                <tr v-if="!services.length">
                  <td colspan="4" class="text-medium-emphasis">{{ t('dashboard.noServices') }}</td>
                </tr>
              </tbody>
            </v-table>
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
              <td class="text-no-wrap text-body-small">
                <span class="text-medium-emphasis">{{ e.namespace }}/</span>{{ e.object.kind }}/{{
                  e.object.name
                }}
              </td>
              <td class="text-body-small">{{ e.reason }}</td>
              <td class="text-body-small">
                {{ e.message }}<span v-if="e.count > 1"> (×{{ e.count }})</span>
              </td>
              <td class="text-body-small text-no-wrap">{{ when(e.lastSeen) }}</td>
            </tr>
            <tr v-if="!events.length">
              <td colspan="5" class="text-medium-emphasis">{{ t('clusters.noEvents') }}</td>
            </tr>
          </tbody>
        </v-table>
      </v-card>
    </template>
    <WorkloadLogsDialog
      v-model="logsOpen"
      :connection="connection"
      :namespace="namespace"
      :name="name"
      :target="logTarget"
    />
  </div>
</template>

<style scoped>
.scroll {
  max-height: 420px;
  overflow-y: auto;
}
</style>
