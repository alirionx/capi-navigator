<script setup lang="ts">
import YamlButton from '../components/YamlButton.vue';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  LOOKUP_KINDS,
  type Credential,
  type CredentialProvider,
  type LookupResponse,
} from '@capi-navigator/shared';
import CredentialDialog from '../components/CredentialDialog.vue';
import ErrorAlert from '../components/ErrorAlert.vue';
import { useAuthStore } from '../stores/auth.js';
import { useConnectionsStore } from '../stores/connections.js';
import { useCredentialsStore } from '../stores/credentials.js';

const { t, d } = useI18n();
const auth = useAuthStore();
const connections = useConnectionsStore();
const store = useCredentialsStore();
const isAdmin = computed(() => auth.can('credentials.manage'));
// Cloud lookups serve the wizard and day-2 changes (FP19-F-05).
const isOperator = computed(() => {
  const scope = { connection: connections.activeName ?? '' };
  return auth.can('clusters.create', scope) || auth.can('clusters.change', scope);
});

const loadError = ref<unknown>(null);
const actionError = ref<unknown>(null);
const testing = ref<string | null>(null);
const expanded = ref<string[]>([]);

async function reload(): Promise<void> {
  if (!connections.activeName) return;
  loadError.value = null;
  try {
    await store.load(connections.activeName);
  } catch (err) {
    loadError.value = err;
  }
}
watch(() => connections.activeName, reload, { immediate: true });

const key = (c: Credential) => `${c.provider}/${c.name}`;

/** Valid credentials with missing one-time setup (e.g. CAPA IAM) are not "failed". */
function testState(c: Credential): { key: 'ok' | 'setup' | 'failed'; color: string; icon: string } {
  const r = c.lastTest;
  if (r?.ok) return { key: 'ok', color: 'success', icon: 'mdi-check-circle' };
  if (r?.fixCommand && r.checks[0]?.ok)
    return { key: 'setup', color: 'warning', icon: 'mdi-wrench' };
  return { key: 'failed', color: 'error', icon: 'mdi-alert-circle' };
}
const headers = computed(() => [
  { title: t('credentials.name'), key: 'name' },
  { title: t('credentials.provider'), key: 'provider' },
  { title: t('credentials.target'), key: 'target', sortable: false },
  { title: t('credentials.allowedNamespaces'), key: 'allowedNamespaces', sortable: false },
  { title: t('credentials.lastTest'), key: 'lastTest', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
  { title: '', key: 'data-table-expand' },
]);

type Dialog =
  | { kind: 'edit'; provider: CredentialProvider; credential: Credential | null }
  | { kind: 'delete'; credential: Credential };
const dialog = ref<Dialog | null>(null);
const deleting = ref(false);

async function test(c: Credential): Promise<void> {
  testing.value = key(c);
  actionError.value = null;
  try {
    await store.test(c);
    if (!expanded.value.includes(key(c))) expanded.value = [...expanded.value, key(c)];
  } catch (err) {
    actionError.value = err;
  } finally {
    testing.value = null;
  }
}

function saved(c: Credential): void {
  dialog.value = null;
  expanded.value = [...expanded.value.filter((k) => k !== key(c)), key(c)];
}

async function confirmDelete(): Promise<void> {
  if (dialog.value?.kind !== 'delete') return;
  deleting.value = true;
  actionError.value = null;
  try {
    await store.remove(dialog.value.credential);
    dialog.value = null;
  } catch (err) {
    actionError.value = err;
  } finally {
    deleting.value = false;
  }
}

// Selection lists (FP4-F-05, FP4-F-10), shown to check what the wizard will offer.
const lookupKind = ref<Record<string, string>>({});
const lookupResult = ref<Record<string, LookupResponse | null>>({});
const lookupError = ref<Record<string, unknown>>({});
const lookupLoading = ref<string | null>(null);
async function loadLookup(c: Credential): Promise<void> {
  const k = key(c);
  const kind = lookupKind.value[k];
  if (!kind) return;
  lookupLoading.value = k;
  lookupError.value[k] = null;
  try {
    lookupResult.value[k] = await store.lookup(c, kind);
  } catch (err) {
    lookupError.value[k] = err;
    lookupResult.value[k] = null;
  } finally {
    lookupLoading.value = null;
  }
}
</script>

<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <div>
        <h1 class="page-title">{{ t('credentials.title') }}</h1>
        <p class="text-body-2 text-medium-emphasis mt-1">{{ t('credentials.subtitle') }}</p>
      </div>
      <v-spacer />
      <template v-if="isAdmin && connections.active">
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="mdi-plus"
          data-testid="add-openstack"
          @click="dialog = { kind: 'edit', provider: 'openstack', credential: null }"
        >
          {{ t('credentials.addOpenStack') }}
        </v-btn>
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="mdi-plus"
          data-testid="add-aws"
          @click="dialog = { kind: 'edit', provider: 'aws', credential: null }"
        >
          {{ t('credentials.addAws') }}
        </v-btn>
      </template>
    </div>

    <v-alert v-if="!connections.active" type="info" variant="tonal">{{
      t('providers.noConnection')
    }}</v-alert>
    <template v-else>
      <ErrorAlert v-if="loadError" :error="loadError" class="mb-4" />
      <ErrorAlert v-if="actionError && !dialog" :error="actionError" class="mb-4" />

      <v-card border class="table-card">
        <v-data-table
          v-model:expanded="expanded"
          :headers="headers"
          :items="store.credentials"
          :item-value="key"
          :loading="store.loading"
          show-expand
          :no-data-text="t('credentials.empty')"
          data-testid="credentials-table"
        >
          <template #[`item.name`]="{ item }">
            <div class="font-weight-medium">{{ item.displayName || item.name }}</div>
            <div class="text-caption text-medium-emphasis">
              {{ item.identity.kind }}/{{ item.name }}
            </div>
          </template>
          <template #[`item.provider`]="{ item }">{{
            t(`credentials.providers.${item.provider}`)
          }}</template>
          <template #[`item.target`]="{ item }">
            <div class="text-caption">
              <template v-if="item.provider === 'openstack'">
                {{ item.summary.authUrl }}<br />{{ t('credentials.regionLabel') }}:
                {{ item.summary.region ?? '–' }} · {{ item.summary.authType }}
              </template>
              <template v-else>
                {{ t('credentials.regionLabel') }}: {{ item.summary.region }}<br />{{
                  t('credentials.keyEnding', { suffix: item.summary.accessKeyIdSuffix })
                }}
              </template>
            </div>
          </template>
          <template #[`item.allowedNamespaces`]="{ item }">
            <v-chip v-for="ns in item.allowedNamespaces" :key="ns" size="x-small" class="mr-1">{{
              ns
            }}</v-chip>
          </template>
          <template #[`item.lastTest`]="{ item }">
            <v-chip
              v-if="item.lastTest"
              :color="testState(item).color"
              size="small"
              variant="tonal"
              :prepend-icon="testState(item).icon"
            >
              {{ t(`credentials.state.${testState(item).key}`) }}
            </v-chip>
            <span v-else class="text-caption">–</span>
          </template>
          <template #[`item.actions`]="{ item }">
            <YamlButton
              :target="{
                apiVersion: item.identity.apiVersion,
                kind: item.identity.kind,
                name: item.identity.name,
              }"
            />
            <YamlButton
              :target="{
                apiVersion: 'v1',
                kind: 'Secret',
                namespace: item.secret.namespace,
                name: item.secret.name,
              }"
            />
            <div v-if="isAdmin" class="text-no-wrap d-inline-flex">
              <v-btn
                icon="mdi-connection"
                variant="text"
                size="small"
                :title="t('credentials.test')"
                :aria-label="t('credentials.test')"
                :loading="testing === key(item)"
                data-testid="test-credential"
                @click="test(item)"
              />
              <v-btn
                icon="mdi-pencil"
                variant="text"
                size="small"
                :title="t('credentials.edit')"
                :aria-label="t('credentials.edit')"
                @click="dialog = { kind: 'edit', provider: item.provider, credential: item }"
              />
              <v-btn
                icon="mdi-delete"
                variant="text"
                size="small"
                color="error"
                :title="t('common.delete')"
                :aria-label="t('common.delete')"
                @click="dialog = { kind: 'delete', credential: item }"
              />
            </div>
          </template>
          <template #expanded-row="{ columns, item }">
            <tr>
              <td :colspan="columns.length" class="py-4">
                <template v-if="item.lastTest">
                  <div class="text-subtitle-2 mb-1">
                    {{
                      t('credentials.lastTestAt', {
                        at: d(new Date(item.lastTest.testedAt), 'short'),
                      })
                    }}
                    <span v-if="item.lastTest.identity" class="text-medium-emphasis">
                      · {{ item.lastTest.identity }}</span
                    >
                  </div>
                  <v-alert
                    v-if="item.lastTest.message"
                    :type="testState(item).key === 'failed' ? 'error' : 'warning'"
                    variant="tonal"
                    density="comfortable"
                    class="mb-2"
                  >
                    <div class="font-weight-medium">{{ item.lastTest.message }}</div>
                    <div v-if="item.lastTest.hint" class="text-body-2">
                      {{ item.lastTest.hint }}
                    </div>
                    <pre
                      v-if="item.lastTest.fixCommand"
                      class="command mt-2"
                      data-testid="fix-command"
                      >{{ item.lastTest.fixCommand }}</pre>
                    <details v-if="item.lastTest.details" class="text-caption mt-1">
                      <summary>{{ t('errors.details') }}</summary>
                      <pre class="command">{{ item.lastTest.details }}</pre>
                    </details>
                  </v-alert>
                  <v-table density="compact" class="mb-3">
                    <tbody>
                      <tr v-for="c in item.lastTest.checks" :key="c.name">
                        <td style="width: 32px">
                          <v-icon
                            :icon="c.ok ? 'mdi-check' : c.warning ? 'mdi-alert' : 'mdi-close'"
                            :color="c.ok ? 'success' : c.warning ? 'warning' : 'error'"
                            size="small"
                          />
                        </td>
                        <td class="text-caption">{{ c.name }}</td>
                        <td class="text-caption text-medium-emphasis">{{ c.message }}</td>
                      </tr>
                    </tbody>
                  </v-table>
                </template>

                <div v-if="isOperator" class="d-flex align-center ga-2" style="max-width: 520px">
                  <v-select
                    v-model="lookupKind[key(item)]"
                    :items="
                      LOOKUP_KINDS[item.provider].map((k) => ({
                        title: t(`credentials.lookups.${k}`),
                        value: k,
                      }))
                    "
                    :label="t('credentials.lookupLabel')"
                    density="compact"
                    hide-details
                    :data-testid="`lookup-kind-${item.name}`"
                  />
                  <v-btn
                    :loading="lookupLoading === key(item)"
                    :disabled="!lookupKind[key(item)]"
                    variant="tonal"
                    @click="loadLookup(item)"
                  >
                    {{ t('credentials.lookupLoad') }}
                  </v-btn>
                </div>
                <ErrorAlert
                  v-if="lookupError[key(item)]"
                  :error="lookupError[key(item)]"
                  class="mt-2"
                />
                <div
                  v-if="lookupResult[key(item)]"
                  class="mt-2"
                  :data-testid="`lookup-result-${item.name}`"
                >
                  <div class="text-caption mb-1">
                    {{
                      t('credentials.lookupCount', { n: lookupResult[key(item)]!.options.length })
                    }}
                  </div>
                  <v-chip
                    v-for="o in lookupResult[key(item)]!.options.slice(0, 30)"
                    :key="o.value"
                    size="small"
                    class="mr-1 mb-1"
                    >{{ o.label }}</v-chip
                  >
                </div>
              </td>
            </tr>
          </template>
        </v-data-table>
      </v-card>
    </template>

    <v-dialog
      :model-value="dialog?.kind === 'edit'"
      max-width="680"
      scrollable
      @update:model-value="dialog = null"
    >
      <CredentialDialog
        v-if="dialog?.kind === 'edit'"
        :provider="dialog.provider"
        :credential="dialog.credential"
        @close="dialog = null"
        @saved="saved"
      />
    </v-dialog>

    <v-dialog
      :model-value="dialog?.kind === 'delete'"
      max-width="480"
      @update:model-value="dialog = null"
    >
      <v-card v-if="dialog?.kind === 'delete'">
        <v-card-title class="pt-4 px-6">{{
          t('credentials.deleteTitle', { name: dialog.credential.name })
        }}</v-card-title>
        <v-card-text>
          {{ t('credentials.deleteText') }}
          <ErrorAlert v-if="actionError" :error="actionError" class="mt-3" />
        </v-card-text>
        <v-card-actions class="px-6 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="dialog = null">{{ t('common.cancel') }}</v-btn>
          <v-btn color="error" variant="flat" :loading="deleting" @click="confirmDelete">{{
            t('common.delete')
          }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<style scoped>
.command {
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  padding: 6px 8px;
  border-radius: 4px;
}
</style>
