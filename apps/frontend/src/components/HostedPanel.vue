<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { HostView, TenantView } from '@capi-navigator/shared';
import ErrorAlert from './ErrorAlert.vue';
import { useClustersStore } from '../stores/clusters.js';

/**
 * FP24-F-11: where a hosted control plane runs (tenant), or which control planes a host carries
 * (host). Read with the host's kubeconfig, read-only.
 */
const props = defineProps<{
  connection: string;
  namespace: string;
  name: string;
  role: 'tenant' | 'host';
}>();
const { t } = useI18n();
const clusters = useClustersStore();

const tenant = ref<TenantView | null>(null);
const host = ref<HostView | null>(null);
const error = ref<unknown>(null);

async function load(): Promise<void> {
  error.value = null;
  try {
    if (props.role === 'tenant') {
      tenant.value = await clusters.hostedControlPlane(
        props.connection,
        props.namespace,
        props.name,
      );
    } else {
      host.value = await clusters.hostedTenants(props.connection, props.namespace, props.name);
    }
  } catch (err) {
    error.value = err;
  }
}
watch(() => [props.connection, props.namespace, props.name, props.role], load, { immediate: true });

const cpu = (m: number) => (m / 1000).toFixed(2);
const memory = (m: number) => `${(m / 1024).toFixed(1)} GiB`;
const requested = computed(() => {
  const list = host.value?.tenants ?? [];
  return {
    cpu: cpu(list.reduce((s, x) => s + x.cpuMillis, 0)),
    memory: memory(list.reduce((s, x) => s + x.memoryMiB, 0)),
  };
});
</script>

<template>
  <v-card border class="mt-4" :data-testid="`hosted-panel-${role}`">
    <template v-if="role === 'tenant'">
      <v-card-item
        :title="t('day2.hosted.title')"
        :subtitle="t('day2.hosted.subtitle', { host: tenant?.host.name ?? '…' })"
      >
        <template #append>
          <v-btn
            v-if="tenant"
            size="small"
            variant="tonal"
            prepend-icon="mdi-open-in-app"
            :to="{
              name: 'cluster',
              params: { namespace: tenant.host.namespace, name: tenant.host.name },
            }"
            >{{ t('day2.hosted.openHost') }}</v-btn
          >
        </template>
      </v-card-item>
      <v-card-text v-if="tenant">
        <div class="text-body-medium mb-2" data-testid="hosted-service">
          <strong>{{ t('day2.hosted.service') }}:</strong>
          {{
            tenant.service
              ? `${tenant.service.name} · ${tenant.service.address ?? '…'} · ${tenant.service.ports.join(', ')}`
              : t('day2.hosted.none')
          }}
        </div>
        <v-table density="compact" class="mb-2">
          <thead>
            <tr>
              <th>{{ t('day2.hosted.pods') }}</th>
              <th></th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in tenant.pods" :key="p.name">
              <td class="font-monospace text-body-small">{{ p.name }}</td>
              <td>{{ p.component }}</td>
              <td class="text-body-small">{{ p.node ?? '–' }}</td>
              <td>
                <v-chip size="small" variant="tonal" :color="p.ready ? 'success' : 'info'">{{
                  p.ready ? t('clusters.ready') : p.phase
                }}</v-chip>
              </td>
            </tr>
            <tr v-if="tenant.pods.length === 0">
              <td colspan="4" class="text-medium-emphasis">{{ t('day2.hosted.none') }}</td>
            </tr>
          </tbody>
        </v-table>
        <div class="text-body-medium">
          <strong>{{ t('day2.hosted.volumes') }}:</strong>
          {{
            tenant.volumes.length
              ? tenant.volumes.map((v) => `${v.name} (${v.size ?? '?'}, ${v.phase})`).join(', ')
              : t('day2.hosted.none')
          }}
        </div>
        <div
          v-for="w in tenant.warnings"
          :key="w"
          class="text-body-small text-medium-emphasis mt-1"
        >
          {{ w }}
        </div>
      </v-card-text>
    </template>
    <template v-else>
      <v-card-item
        :title="t('day2.hosted.tenants')"
        :subtitle="
          host
            ? t('day2.hosted.tenantsSubtitle', {
                n: host.tenants.length,
                cpu: requested.cpu,
                memory: requested.memory,
                nodes: host.schedulableNodes,
              })
            : ''
        "
      />
      <v-card-text v-if="host">
        <v-table v-if="host.tenants.length" density="compact">
          <tbody>
            <tr v-for="x in host.tenants" :key="x.name">
              <td>
                <router-link
                  :to="{ name: 'cluster', params: { namespace: x.namespace, name: x.name } }"
                  >{{ x.name }}</router-link
                >
              </td>
              <td>{{ x.replicas }}×</td>
              <td class="text-body-small">
                {{
                  t('day2.hosted.requests', { cpu: cpu(x.cpuMillis), memory: memory(x.memoryMiB) })
                }}
              </td>
            </tr>
          </tbody>
        </v-table>
        <div v-else class="text-medium-emphasis">{{ t('day2.hosted.noTenants') }}</div>
        <div v-for="w in host.warnings" :key="w" class="text-body-small text-medium-emphasis mt-1">
          {{ w }}
        </div>
      </v-card-text>
    </template>
    <v-card-text v-if="error"><ErrorAlert :error="error" /></v-card-text>
  </v-card>
</template>
