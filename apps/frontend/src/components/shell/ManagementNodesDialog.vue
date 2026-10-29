<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ClusterNodeListSchema, type ClusterNode } from '@capi-navigator/shared';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import ErrorAlert from '../ErrorAlert.vue';
import NodeShellDialog from './NodeShellDialog.vue';

/** Nodes of a management cluster with a node shell for admins (FP-17). */
const props = defineProps<{ connection: string }>();
const open = defineModel<boolean>({ required: true });
const { t } = useI18n();
const auth = useAuthStore();
const nodes = ref<ClusterNode[]>([]);
const loading = ref(false);
const error = ref<unknown>(null);
const shellNode = ref<string | null>(null);
const shellOpen = ref(false);

watch(
  open,
  async (o) => {
    if (!o) return;
    loading.value = true;
    error.value = null;
    try {
      nodes.value = await api(
        'GET',
        `/api/connections/${encodeURIComponent(props.connection)}/nodes`,
        ClusterNodeListSchema,
      );
    } catch (err) {
      error.value = err;
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

function openShell(node: string): void {
  shellNode.value = node;
  shellOpen.value = true;
}
</script>

<template>
  <v-dialog v-model="open" max-width="900">
    <v-card :title="t('shell.nodesTitle', { name: connection })" data-testid="management-nodes">
      <v-card-text>
        <ErrorAlert v-if="error" :error="error" class="mb-2" />
        <v-progress-linear v-if="loading" indeterminate />
        <v-table v-else density="comfortable">
          <thead>
            <tr>
              <th>{{ t('clusters.name') }}</th>
              <th>{{ t('shell.roles') }}</th>
              <th>{{ t('clusters.version') }}</th>
              <th>{{ t('bastion.privateIP') }}</th>
              <th>{{ t('clusters.phase') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in nodes" :key="n.name">
              <td class="font-weight-medium">{{ n.name }}</td>
              <td>{{ n.roles.join(', ') || '–' }}</td>
              <td>{{ n.kubeletVersion ?? '–' }}</td>
              <td class="font-monospace text-body-small">{{ n.internalIP ?? '–' }}</td>
              <td>
                <v-chip size="small" variant="tonal" :color="n.ready ? 'success' : 'warning'">{{
                  n.ready ? t('clusters.ready') : t('shell.notReady')
                }}</v-chip>
              </td>
              <td class="text-right">
                <v-btn
                  v-if="auth.can('managementNodes.shell')"
                  size="small"
                  variant="tonal"
                  prepend-icon="mdi-console"
                  :data-testid="`mgmt-shell-${n.name}`"
                  @click="openShell(n.name)"
                  >{{ t('shell.open') }}</v-btn
                >
              </td>
            </tr>
          </tbody>
        </v-table>
        <div
          v-if="!auth.can('managementNodes.shell')"
          class="text-body-small text-medium-emphasis mt-2"
        >
          {{ t('shell.adminOnly') }}
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">{{ t('common.close') }}</v-btn>
      </v-card-actions>
    </v-card>
    <NodeShellDialog
      v-if="shellNode"
      v-model="shellOpen"
      :title="t('shell.title', { node: shellNode })"
      :path="`/api/connections/${encodeURIComponent(connection)}/nodes/${encodeURIComponent(shellNode)}/shell`"
    />
  </v-dialog>
</template>
