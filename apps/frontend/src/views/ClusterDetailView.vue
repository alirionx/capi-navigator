<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Condition } from '@capi-navigator/shared';
import { useClustersStore } from '../stores/clusters.js';
import { useConnectionsStore } from '../stores/connections.js';

/** Live status of a cluster (US-07): cluster, infrastructure, control plane, pools, machines. */
const props = defineProps<{ namespace: string; name: string }>();
const { t } = useI18n();
const connections = useConnectionsStore();
const store = useClustersStore();

watch(
  () => [connections.activeName, props.namespace, props.name] as const,
  ([conn, ns, name]) => {
    store.status = null;
    if (conn) store.watch(conn, ns, name);
  },
  { immediate: true },
);
onBeforeUnmount(() => store.unwatch());

const s = computed(() => store.status);
const failing = (conds: Condition[]) => conds.filter((c) => c.status !== 'True' && c.message);
const color = (ok: boolean) => (ok ? 'success' : 'info');
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <v-btn
        icon="mdi-arrow-left"
        variant="text"
        :to="{ name: 'clusters' }"
        :aria-label="t('common.back')"
      />
      <div>
        <h1 class="page-title">{{ name }}</h1>
        <p class="text-body-2 text-medium-emphasis mt-1">{{ namespace }}</p>
      </div>
      <v-spacer />
      <v-chip
        :color="store.live ? 'success' : 'grey'"
        variant="tonal"
        prepend-icon="mdi-access-point"
      >
        {{ store.live ? t('providers.live') : t('providers.connecting') }}
      </v-chip>
    </div>

    <v-alert v-if="store.statusError" type="error" variant="tonal" class="mb-4">{{
      store.statusError
    }}</v-alert>
    <v-progress-linear v-if="!s && !store.statusError" indeterminate />

    <template v-if="s">
      <v-row>
        <v-col cols="12" md="3">
          <v-card border class="fill-height" data-testid="cluster-phase">
            <v-card-item
              :title="t('clusters.phase')"
              :subtitle="s.summary.provider + (s.summary.version ? ' · ' + s.summary.version : '')"
            />
            <v-card-text>
              <v-chip :color="s.summary.ready ? 'success' : 'info'" variant="tonal">{{
                s.summary.ready ? t('clusters.ready') : s.summary.phase
              }}</v-chip>
              <div v-if="s.kubeconfigAvailable" class="text-caption mt-2">
                {{ t('clusters.kubeconfigReady') }}
              </div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col v-if="s.infrastructure" cols="12" md="3">
          <v-card border class="fill-height">
            <v-card-item :title="s.infrastructure.kind" :subtitle="s.infrastructure.name" />
            <v-card-text>
              <v-chip :color="color(s.infrastructure.ready)" variant="tonal">{{
                s.infrastructure.ready ? t('clusters.provisioned') : t('clusters.provisioning')
              }}</v-chip>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col v-if="s.controlPlane" cols="12" md="3">
          <v-card border class="fill-height">
            <v-card-item :title="s.controlPlane.kind" :subtitle="s.controlPlane.version" />
            <v-card-text>
              <v-chip
                :color="color(s.controlPlane.ready === s.controlPlane.replicas)"
                variant="tonal"
                >{{ s.controlPlane.ready }}/{{ s.controlPlane.replicas }}
                {{ t('clusters.available') }}</v-chip
              >
            </v-card-text>
          </v-card>
        </v-col>
        <v-col v-for="md in s.machineDeployments" :key="md.name" cols="12" md="3">
          <v-card border class="fill-height">
            <v-card-item
              :title="t('wizard.poolTitle', { name: md.pool ?? md.name })"
              subtitle="MachineDeployment"
            />
            <v-card-text>
              <v-chip :color="color(md.ready === md.replicas)" variant="tonal"
                >{{ md.ready }}/{{ md.replicas }} {{ t('clusters.ready') }}</v-chip
              >
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-alert
        v-for="c in failing(s.conditions)"
        :key="c.type"
        type="info"
        variant="tonal"
        density="compact"
        class="mt-4"
      >
        <strong>{{ c.type }}</strong> ({{ c.reason }}): {{ c.message }}
      </v-alert>

      <h2 class="text-h6 mt-6 mb-2">{{ t('clusters.machines') }}</h2>
      <v-card border class="table-card">
        <v-table density="comfortable" data-testid="machines">
          <thead>
            <tr>
              <th>{{ t('clusters.name') }}</th>
              <th>{{ t('clusters.role') }}</th>
              <th>{{ t('clusters.phase') }}</th>
              <th>{{ t('clusters.node') }}</th>
              <th>providerID</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in s.machines" :key="m.name">
              <td>{{ m.name }}</td>
              <td>{{ m.role === 'control-plane' ? 'control plane' : (m.pool ?? 'worker') }}</td>
              <td>
                <v-chip
                  size="small"
                  variant="tonal"
                  :color="
                    m.phase === 'Running' ? 'success' : m.phase === 'Failed' ? 'error' : 'info'
                  "
                  >{{ m.phase }}</v-chip
                >
              </td>
              <td>{{ m.nodeName ?? '–' }}</td>
              <td class="text-caption font-monospace">{{ m.providerID ?? '–' }}</td>
            </tr>
            <tr v-if="s.machines.length === 0">
              <td colspan="5" class="text-medium-emphasis">{{ t('clusters.noMachines') }}</td>
            </tr>
          </tbody>
        </v-table>
      </v-card>
    </template>
  </v-container>
</template>
