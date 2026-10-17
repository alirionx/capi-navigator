<script setup lang="ts">
import ManagementNodesDialog from '../components/shell/ManagementNodesDialog.vue';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Connection } from '@capi-navigator/shared';
import ConnectionDialog from '../components/ConnectionDialog.vue';
import ConnectionStatusChip from '../components/ConnectionStatusChip.vue';
import ErrorAlert from '../components/ErrorAlert.vue';
import { useAuthStore } from '../stores/auth.js';
import { useConnectionsStore } from '../stores/connections.js';

const { t, d } = useI18n();
const store = useConnectionsStore();
const auth = useAuthStore();
const isAdmin = computed(() => auth.can('admin'));

const loadError = ref<unknown>(null);
const actionError = ref<unknown>(null);
const testing = ref<string | null>(null);
const expanded = ref<string[]>([]);

const dialog = ref<'edit' | 'delete' | null>(null);
const target = ref<Connection | null>(null);
const deleting = ref(false);

const headers = computed(() => [
  { title: t('connections.name'), key: 'name' },
  { title: t('connections.authType'), key: 'authType' },
  { title: t('connections.server'), key: 'server' },
  { title: t('connections.status'), key: 'status', sortable: false },
  { title: t('connections.version'), key: 'version', sortable: false },
  { title: t('connections.lastChecked'), key: 'lastChecked', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
  { title: '', key: 'data-table-expand' },
]);

async function reload(): Promise<void> {
  loadError.value = null;
  try {
    await store.load();
  } catch (err) {
    loadError.value = err;
  }
}
onMounted(reload);

function open(kind: 'edit' | 'delete', conn: Connection | null): void {
  target.value = conn;
  actionError.value = null;
  dialog.value = kind;
}

async function test(conn: Connection): Promise<void> {
  testing.value = conn.name;
  actionError.value = null;
  try {
    const result = await store.test(conn.name);
    if (result.status.message && !expanded.value.includes(conn.name)) {
      expanded.value = [...expanded.value, conn.name];
    }
  } catch (err) {
    actionError.value = err;
  } finally {
    testing.value = null;
  }
}

async function confirmDelete(): Promise<void> {
  if (!target.value) return;
  deleting.value = true;
  try {
    await store.remove(target.value.name);
    dialog.value = null;
  } catch (err) {
    actionError.value = err;
  } finally {
    deleting.value = false;
  }
}

function saved(conn: Connection): void {
  dialog.value = null;
  if (conn.status.message) expanded.value = [...expanded.value, conn.name];
}

async function download(variant: 'full' | 'minimal'): Promise<void> {
  try {
    await store.downloadAccessManifest(variant);
  } catch (err) {
    actionError.value = err;
  }
}

const missingRequired = (c: Connection) =>
  c.status.permissions?.filter((p) => !p.allowed && p.level === 'required').length ?? 0;

// FP-17: nodes of the management cluster, with a node shell for admins.
const nodesOf = ref<string | null>(null);
const nodesOpen = ref(false);
function showNodes(name: string): void {
  nodesOf.value = name;
  nodesOpen.value = true;
}
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <div>
        <h1 class="page-title">{{ t('connections.title') }}</h1>
        <p class="text-body-2 text-medium-emphasis mt-1">{{ t('connections.subtitle') }}</p>
      </div>
      <v-spacer />
      <v-menu v-if="isAdmin">
        <template #activator="{ props }">
          <v-btn v-bind="props" variant="outlined" prepend-icon="mdi-download">
            {{ t('connections.accessManifest') }}
          </v-btn>
        </template>
        <v-list density="compact" max-width="420">
          <v-list-item
            :title="t('connections.manifestFull')"
            :subtitle="t('connections.manifestFullHint')"
            lines="two"
            @click="download('full')"
          />
          <v-list-item
            :title="t('connections.manifestMinimal')"
            :subtitle="t('connections.manifestMinimalHint')"
            lines="two"
            @click="download('minimal')"
          />
        </v-list>
      </v-menu>
      <v-btn
        v-if="isAdmin"
        color="primary"
        prepend-icon="mdi-lan-connect"
        data-testid="add-connection"
        @click="open('edit', null)"
      >
        {{ t('connections.add') }}
      </v-btn>
    </div>

    <ErrorAlert v-if="loadError" :error="loadError" class="mb-4" />
    <ErrorAlert v-if="actionError" :error="actionError" class="mb-4" />

    <v-alert
      v-if="!store.loading && store.connections.length === 0 && !loadError"
      type="info"
      variant="tonal"
      class="mb-4"
    >
      <div class="font-weight-medium">{{ t('connections.emptyTitle') }}</div>
      <div class="text-body-2">
        {{ isAdmin ? t('connections.emptyAdmin') : t('connections.emptyViewer') }}
      </div>
    </v-alert>

    <v-card v-else border class="table-card">
      <v-data-table
        v-model:expanded="expanded"
        :headers="headers"
        :items="store.connections"
        :loading="store.loading"
        item-value="name"
        show-expand
        data-testid="connections-table"
      >
        <template #[`item.name`]="{ item }">
          <div class="font-weight-medium">{{ item.displayName || item.name }}</div>
          <div v-if="item.displayName" class="text-caption text-medium-emphasis">
            {{ item.name }}
          </div>
        </template>
        <template #[`item.authType`]="{ item }">
          {{ t(`connections.auth.${item.authType}`) }}
          <div v-if="item.context" class="text-caption text-medium-emphasis">
            {{ item.context }}
          </div>
        </template>
        <template #[`item.server`]="{ item }">
          <span class="text-caption font-monospace">{{ item.server }}</span>
        </template>
        <template #[`item.status`]="{ item }">
          <ConnectionStatusChip :connection="item" />
        </template>
        <template #[`item.version`]="{ item }">{{ item.status.kubernetesVersion ?? '–' }}</template>
        <template #[`item.lastChecked`]="{ item }">
          <span class="text-caption">
            {{ item.status.lastCheckedAt ? d(new Date(item.status.lastCheckedAt), 'short') : '–' }}
          </span>
        </template>
        <template #[`item.actions`]="{ item }">
          <div class="text-no-wrap">
            <v-btn
              icon="mdi-server-outline"
              variant="text"
              size="small"
              :title="t('shell.nodes')"
              :aria-label="t('shell.nodes')"
              :data-testid="`nodes-${item.name}`"
              @click="showNodes(item.name)"
            />
            <template v-if="isAdmin">
              <v-btn
                icon="mdi-connection"
                variant="text"
                size="small"
                :title="t('connections.test')"
                :aria-label="t('connections.test')"
                :loading="testing === item.name"
                data-testid="test-connection"
                @click="test(item)"
              />
              <v-btn
                icon="mdi-pencil"
                variant="text"
                size="small"
                :title="t('connections.edit')"
                :aria-label="t('connections.edit')"
                @click="open('edit', item)"
              />
              <v-btn
                icon="mdi-delete"
                variant="text"
                size="small"
                color="error"
                :title="t('common.delete')"
                :aria-label="t('common.delete')"
                @click="open('delete', item)"
              />
            </template>
          </div>
        </template>
        <template #expanded-row="{ columns, item }">
          <tr>
            <td :colspan="columns.length" class="py-4">
              <v-alert
                v-if="item.status.message"
                :type="item.status.phase === 'Reachable' ? 'warning' : 'error'"
                variant="tonal"
                density="comfortable"
                class="mb-3"
              >
                <div class="font-weight-medium">{{ item.status.message }}</div>
                <div v-if="item.status.hint" class="text-body-2">{{ item.status.hint }}</div>
                <details v-if="item.status.details" class="text-caption mt-1">
                  <summary>{{ t('errors.details') }}</summary>
                  <pre class="details">{{ item.status.details }}</pre>
                </details>
              </v-alert>
              <div v-if="item.status.permissions?.length">
                <div class="text-subtitle-2 mb-1">
                  {{ t('connections.permissions') }}
                  <span class="text-medium-emphasis">
                    ({{ t('connections.missingRequired', { n: missingRequired(item) }) }})
                  </span>
                </div>
                <v-table density="compact">
                  <tbody>
                    <tr
                      v-for="p in item.status.permissions"
                      :key="`${p.group}/${p.resource}/${p.verb}`"
                    >
                      <td style="width: 32px">
                        <v-icon
                          :icon="p.allowed ? 'mdi-check' : 'mdi-close'"
                          :color="
                            p.allowed ? 'success' : p.level === 'required' ? 'error' : 'warning'
                          "
                          size="small"
                        />
                      </td>
                      <td class="font-monospace text-caption">
                        {{ p.verb }} {{ p.group ? `${p.resource}.${p.group}` : p.resource }}
                      </td>
                      <td class="text-caption">{{ p.purpose }}</td>
                      <td class="text-caption text-medium-emphasis">
                        {{ t(`connections.level.${p.level}`) }}
                      </td>
                    </tr>
                  </tbody>
                </v-table>
              </div>
              <div v-else-if="!item.status.message" class="text-medium-emphasis">
                {{ t('connections.notTested') }}
              </div>
            </td>
          </tr>
        </template>
      </v-data-table>
    </v-card>

    <v-dialog :model-value="dialog === 'edit'" max-width="640" @update:model-value="dialog = null">
      <ConnectionDialog
        v-if="dialog === 'edit'"
        :connection="target"
        @close="dialog = null"
        @saved="saved"
      />
    </v-dialog>

    <v-dialog
      :model-value="dialog === 'delete'"
      max-width="480"
      @update:model-value="dialog = null"
    >
      <v-card v-if="target">
        <v-card-title class="pt-4 px-6">
          {{ t('connections.deleteTitle', { name: target.name }) }}
        </v-card-title>
        <v-card-text>{{ t('connections.deleteText') }}</v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="dialog = null">{{ t('common.cancel') }}</v-btn>
          <v-btn color="error" variant="flat" :loading="deleting" @click="confirmDelete">
            {{ t('common.delete') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <ManagementNodesDialog v-if="nodesOf" v-model="nodesOpen" :connection="nodesOf" />
  </v-container>
</template>

<style scoped>
.details {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
