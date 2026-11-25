<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  DASHBOARD_REFRESH_SECONDS,
  type DashboardWorkload,
  type MyNamespace,
  type NamespaceDashboard,
} from '@capi-navigator/shared';
import ErrorAlert from '../ErrorAlert.vue';
import { useMyNamespacesStore } from '../../stores/my-namespaces.js';

/** FP37-F-08: read-only dashboard of one assigned namespace, refreshed while it is open. */
const props = defineProps<{ entry: MyNamespace }>();
const { t } = useI18n();
const store = useMyNamespacesStore();

const data = ref<NamespaceDashboard | null>(null);
const error = ref<unknown>(null);
async function load(): Promise<void> {
  try {
    data.value = await store.dashboard(props.entry);
    error.value = null;
  } catch (err) {
    error.value = err;
  }
}
void load();
const timer = setInterval(() => void load(), DASHBOARD_REFRESH_SECONDS * 1000);
onBeforeUnmount(() => clearInterval(timer));

const COLORS: Record<DashboardWorkload['status'], string> = {
  ok: 'success',
  progressing: 'info',
  degraded: 'error',
};
const date = (value?: string) => (value ? new Date(value).toLocaleString() : '–');
</script>

<template>
  <div :data-testid="`my-dashboard-${entry.namespace}`">
    <ErrorAlert v-if="error" :error="error" class="mb-3" />
    <v-progress-linear v-if="!data && !error" indeterminate class="mb-3" />
    <template v-if="data">
      <div class="text-title-small mb-1">{{ t('myNamespaces.workloads') }}</div>
      <p v-if="!data.workloads.length" class="text-body-medium text-medium-emphasis mb-4">
        {{ t('myNamespaces.noWorkloads') }}
      </p>
      <v-table v-else density="compact" class="mb-4">
        <tbody>
          <tr v-for="w in data.workloads" :key="w.kind + w.name">
            <td class="font-weight-medium">{{ w.name }}</td>
            <td>{{ w.kind }}</td>
            <td class="text-right">
              <v-chip size="small" variant="tonal" :color="COLORS[w.status]">{{
                t('myNamespaces.readyOf', { ready: w.ready, desired: w.desired })
              }}</v-chip>
            </td>
          </tr>
        </tbody>
      </v-table>

      <div class="text-title-small mb-1">{{ t('myNamespaces.pods') }}</div>
      <p v-if="!data.pods.length" class="text-body-medium text-medium-emphasis mb-4">
        {{ t('myNamespaces.noPods') }}
      </p>
      <v-table v-else density="compact" class="mb-4">
        <thead>
          <tr>
            <th>{{ t('myNamespaces.pod') }}</th>
            <th>{{ t('myNamespaces.status') }}</th>
            <th>{{ t('myNamespaces.containers') }}</th>
            <th>{{ t('myNamespaces.restarts') }}</th>
            <th>{{ t('myNamespaces.started') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in data.pods" :key="p.name">
            <td class="font-weight-medium text-no-wrap">{{ p.name }}</td>
            <td>
              <v-chip
                size="small"
                variant="tonal"
                :color="p.reason ? 'error' : p.ready < p.containers ? 'info' : 'success'"
                >{{ p.reason ?? p.phase }}</v-chip
              >
              <div v-if="p.message" class="text-body-small text-medium-emphasis">
                {{ p.message }}
              </div>
            </td>
            <td>{{ p.ready }} / {{ p.containers }}</td>
            <td>{{ p.restarts }}</td>
            <td class="text-no-wrap">{{ date(p.createdAt) }}</td>
          </tr>
        </tbody>
      </v-table>

      <div class="text-title-small mb-1">{{ t('myNamespaces.events') }}</div>
      <p v-if="!data.events.length" class="text-body-medium text-medium-emphasis mb-4">
        {{ t('myNamespaces.noEvents') }}
      </p>
      <v-table v-else density="compact" class="mb-4">
        <tbody>
          <tr v-for="(e, i) in data.events.slice(0, 10)" :key="i">
            <td class="text-no-wrap">{{ date(e.lastSeen) }}</td>
            <td>
              <v-chip
                size="x-small"
                variant="tonal"
                :color="e.type === 'Warning' ? 'warning' : undefined"
                >{{ e.reason }}</v-chip
              >
            </td>
            <td class="text-no-wrap">{{ e.object.name }}</td>
            <td>{{ e.message }}</td>
          </tr>
        </tbody>
      </v-table>
    </template>
  </div>
</template>
