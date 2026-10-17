<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Condition, MachineStatus } from '@capi-navigator/shared';
import KubeconfigDialog from '../components/KubeconfigDialog.vue';
import ResourceTree from '../components/ResourceTree.vue';
import { useAuthStore } from '../stores/auth.js';
import { useClustersStore } from '../stores/clusters.js';
import { useConnectionsStore } from '../stores/connections.js';

/** Live status of a cluster (US-07, FP6-F-02): overview, machines and events. */
const props = defineProps<{ namespace: string; name: string }>();
const { t } = useI18n();
const connections = useConnectionsStore();
const store = useClustersStore();
const tab = ref('overview');
const auth = useAuthStore();
const showKubeconfig = ref(false);

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
const machineColor = (m: MachineStatus) =>
  m.phase === 'Running'
    ? 'success'
    : m.phase === 'Failed'
      ? 'error'
      : m.phase === 'Deleting'
        ? 'warning'
        : 'info';
const warnings = computed(() => s.value?.events.filter((e) => e.type === 'Warning').length ?? 0);
const when = (iso?: string) =>
  iso
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(
        new Date(iso),
      )
    : '–';

const machineHeaders = computed(() => [
  { title: t('clusters.name'), key: 'name' },
  { title: t('clusters.role'), key: 'role' },
  { title: t('clusters.phase'), key: 'phase' },
  { title: t('clusters.size'), key: 'size' },
  { title: t('clusters.image'), key: 'image' },
  { title: t('clusters.rootDisk'), key: 'rootVolumeGB' },
  { title: t('clusters.node'), key: 'nodeName' },
  { title: 'providerID', key: 'providerID' },
  { title: '', key: 'data-table-expand' },
]);
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
        <p class="text-body-2 text-medium-emphasis mt-1">
          {{ namespace }}
          <template v-if="s">
            · {{ s.summary.provider ?? '–' }} · {{ s.summary.flavor ?? '–' }}
            {{ s.summary.version ? '· ' + s.summary.version : '' }}
          </template>
        </p>
      </div>
      <v-chip
        v-if="s && !s.summary.managed"
        size="small"
        variant="tonal"
        class="ml-2"
        :title="t('clusters.externalHint')"
        >{{ t('clusters.external') }}</v-chip
      >
      <v-spacer />
      <v-btn
        v-if="s?.kubeconfigAvailable && auth.can('operator')"
        variant="tonal"
        prepend-icon="mdi-file-key-outline"
        data-testid="show-kubeconfig"
        @click="showKubeconfig = true"
        >{{ t('kubeconfig.show') }}</v-btn
      >
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
      <v-tabs v-model="tab" class="mb-4">
        <v-tab value="overview">{{ t('clusters.overview') }}</v-tab>
        <v-tab value="tree" data-testid="tab-tree">{{ t('clusters.tree') }}</v-tab>
        <v-tab value="machines">
          {{ t('clusters.machines') }}
          <v-chip size="x-small" class="ml-2" variant="tonal">{{ s.machines.length }}</v-chip>
        </v-tab>
        <v-tab value="events" data-testid="tab-events">
          {{ t('clusters.events') }}
          <v-chip v-if="warnings" size="x-small" class="ml-2" color="warning" variant="tonal">{{
            warnings
          }}</v-chip>
        </v-tab>
      </v-tabs>

      <v-window v-model="tab">
        <!-- Overview -->
        <v-window-item value="overview">
          <v-row>
            <v-col cols="12" md="3">
              <v-card border class="fill-height" data-testid="cluster-phase">
                <v-card-item
                  :title="t('clusters.phase')"
                  :subtitle="
                    s.summary.provider + (s.summary.version ? ' · ' + s.summary.version : '')
                  "
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
        </v-window-item>

        <!-- Resource tree (FP6-F-03) -->
        <v-window-item value="tree">
          <ResourceTree :status="s" />
        </v-window-item>

        <!-- Machines -->
        <v-window-item value="machines">
          <v-card border class="table-card">
            <v-data-table
              :headers="machineHeaders"
              :items="s.machines"
              item-value="name"
              show-expand
              density="comfortable"
              :items-per-page="-1"
              hide-default-footer
              :no-data-text="t('clusters.noMachines')"
              data-testid="machines"
            >
              <template #[`item.role`]="{ item }">
                {{ item.role === 'control-plane' ? 'control plane' : (item.pool ?? 'worker') }}
              </template>
              <template #[`item.phase`]="{ item }">
                <v-chip size="small" variant="tonal" :color="machineColor(item)">{{
                  item.phase
                }}</v-chip>
              </template>
              <template #[`item.size`]="{ item }">{{ item.size ?? '–' }}</template>
              <template #[`item.image`]="{ item }">
                <span class="text-caption font-monospace" :title="item.image">{{
                  item.image && item.image.length > 20
                    ? item.image.slice(0, 8) + '…' + item.image.slice(-4)
                    : (item.image ?? '–')
                }}</span>
              </template>
              <template #[`item.rootVolumeGB`]="{ item }">{{
                item.rootVolumeGB ? `${item.rootVolumeGB} GB` : '–'
              }}</template>
              <template #[`item.nodeName`]="{ item }">{{ item.nodeName ?? '–' }}</template>
              <template #[`item.providerID`]="{ item }">
                <span class="text-caption font-monospace">{{ item.providerID ?? '–' }}</span>
              </template>
              <template #expanded-row="{ columns, item }">
                <tr>
                  <td :colspan="columns.length" class="py-3">
                    <div class="text-subtitle-2 mb-2">{{ t('clusters.conditions') }}</div>
                    <v-table density="compact">
                      <tbody>
                        <tr v-for="c in item.conditions" :key="c.type">
                          <td style="width: 14rem">{{ c.type }}</td>
                          <td style="width: 5rem">
                            <v-icon
                              :color="c.status === 'True' ? 'success' : 'warning'"
                              :icon="c.status === 'True' ? 'mdi-check-circle' : 'mdi-alert-circle'"
                              size="small"
                            />
                          </td>
                          <td class="text-caption">
                            {{ c.reason }}{{ c.message ? ': ' + c.message : '' }}
                          </td>
                        </tr>
                      </tbody>
                    </v-table>
                  </td>
                </tr>
              </template>
            </v-data-table>
          </v-card>
        </v-window-item>

        <!-- Events -->
        <v-window-item value="events">
          <v-card border class="table-card">
            <v-table density="comfortable" data-testid="events">
              <thead>
                <tr>
                  <th style="width: 2rem"></th>
                  <th>{{ t('clusters.eventObject') }}</th>
                  <th>{{ t('clusters.eventReason') }}</th>
                  <th>{{ t('clusters.eventMessage') }}</th>
                  <th>{{ t('clusters.eventLastSeen') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(e, i) in s.events"
                  :key="`${e.object.kind}/${e.object.name}/${e.reason}/${i}`"
                >
                  <td>
                    <v-icon
                      :icon="e.type === 'Warning' ? 'mdi-alert' : 'mdi-information-outline'"
                      :color="e.type === 'Warning' ? 'warning' : undefined"
                      size="small"
                    />
                  </td>
                  <td class="text-no-wrap">
                    {{ e.object.kind }}/<span class="font-weight-medium">{{ e.object.name }}</span>
                  </td>
                  <td>{{ e.reason }}</td>
                  <td class="text-caption">
                    {{ e.message }}<span v-if="e.count > 1"> (×{{ e.count }})</span>
                  </td>
                  <td class="text-no-wrap text-caption">{{ when(e.lastSeen) }}</td>
                </tr>
                <tr v-if="s.events.length === 0">
                  <td colspan="5" class="text-medium-emphasis">{{ t('clusters.noEvents') }}</td>
                </tr>
              </tbody>
            </v-table>
          </v-card>
        </v-window-item>
      </v-window>
    </template>
    <KubeconfigDialog
      v-if="connections.activeName"
      v-model="showKubeconfig"
      :connection="connections.activeName"
      :namespace="namespace"
      :name="name"
    />
  </v-container>
</template>
