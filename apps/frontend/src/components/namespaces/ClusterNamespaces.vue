<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAMESPACE_QUOTA_RESOURCES,
  type ManagedNamespaces,
  type ManagedNamespaceView,
  type NamespaceAccount,
  type NamespaceToken,
} from '@capi-navigator/shared';
import ChangeDialog from '../ChangeDialog.vue';
import ErrorAlert from '../ErrorAlert.vue';
import { useAuthStore } from '../../stores/auth.js';
import { useNamespacesStore } from '../../stores/namespaces.js';
import ConfirmNamespaceDialog from './ConfirmNamespaceDialog.vue';
import NamespaceDialog from './NamespaceDialog.vue';
import TokenDialog from './TokenDialog.vue';

/** Managed namespaces of one cluster with accounts, tokens, quota and drift (FP36-F-11). */
const props = defineProps<{ connection: string; namespace: string; name: string }>();
const { t } = useI18n();
const store = useNamespacesStore();
const auth = useAuthStore();
const cluster = computed(() => ({
  connection: props.connection,
  namespace: props.namespace,
  name: props.name,
}));
const canManage = computed(() =>
  auth.can('clusters.access', { connection: props.connection, namespace: props.namespace }),
);

const data = ref<ManagedNamespaces | null>(null);
const error = ref<unknown>(null);
const REFRESH_MS = 10_000;
async function load(): Promise<void> {
  const key = cluster.value;
  try {
    const list = await store.list(key);
    // An answer for a cluster the user has left meanwhile is dropped.
    if (key === cluster.value) {
      data.value = list;
      error.value = null;
    }
  } catch (err) {
    if (key === cluster.value) error.value = err;
  }
}
watch(
  cluster,
  () => {
    data.value = null;
    void load();
  },
  { immediate: true },
);
const timer = setInterval(() => void load(), REFRESH_MS);
onBeforeUnmount(() => clearInterval(timer));

const editOpen = ref(false);
const editing = ref<ManagedNamespaceView | null>(null);
function openForm(n: ManagedNamespaceView | null): void {
  editing.value = n;
  editOpen.value = true;
}

const restoreOpen = ref(false);
const restoring = ref<ManagedNamespaceView | null>(null);
/** FP36-F-06: the next revision makes CAAPH upgrade the release, which restores the objects. */
const restored = () => ({
  ...restoring.value!.spec!,
  revision: restoring.value!.spec!.revision + 1,
});

const tokenOpen = ref(false);
const tokenFor = ref<{ namespace: string; account: NamespaceAccount } | null>(null);
function openToken(namespace: string, account: NamespaceAccount): void {
  tokenFor.value = { namespace, account };
  tokenOpen.value = true;
}
const revokeError = ref<unknown>(null);
async function revoke(namespace: string, token: NamespaceToken): Promise<void> {
  revokeError.value = null;
  try {
    await store.revokeToken(cluster.value, namespace, token.id);
  } catch (err) {
    revokeError.value = err;
  }
  await load();
}

const confirmOpen = ref(false);
const confirming = ref<{ view: ManagedNamespaceView; kind: 'end' | 'delete' } | null>(null);
function openConfirm(view: ManagedNamespaceView, kind: 'end' | 'delete'): void {
  confirming.value = { view, kind };
  confirmOpen.value = true;
}
const confirmAction = () => {
  const { view, kind } = confirming.value!;
  return kind === 'end'
    ? store.endAccess(cluster.value, view.name)
    : store.deleteNamespace(cluster.value, view.name, view.name);
};

const state = (n: ManagedNamespaceView): { color: string; text: string } =>
  n.leftOver
    ? { color: 'grey', text: t('namespaces.leftOver') }
    : data.value?.unreachable
      ? { color: 'grey', text: t('namespaces.unknown') }
      : !n.addon?.ready
        ? { color: 'info', text: t('namespaces.installing') }
        : n.drift.length
          ? { color: 'warning', text: t('namespaces.drift') }
          : { color: 'success', text: t('namespaces.ready') };
/** Label of a resource of the quota; the GiB of the form would double the unit here. */
const quotaLabel = (resource: string) => {
  const key = Object.entries(NAMESPACE_QUOTA_RESOURCES).find(([, r]) => r === resource)?.[0];
  return key ? t(`namespaces.quota.${key}`).replace(/ \(GiB\)$/, '') : resource;
};
const date = (value?: string) => (value ? new Date(value).toLocaleString() : '–');
</script>

<template>
  <div data-testid="cluster-namespaces">
    <div class="d-flex align-center flex-wrap ga-3 mb-4">
      <p class="text-body-medium text-medium-emphasis flex-grow-1">{{ t('namespaces.intro') }}</p>
      <v-btn
        v-if="canManage && data && !data.unsupported"
        color="primary"
        prepend-icon="mdi-plus"
        data-testid="new-namespace"
        @click="openForm(null)"
        >{{ t('namespaces.new') }}</v-btn
      >
    </div>
    <ErrorAlert v-if="error" :error="error" class="mb-3" />
    <ErrorAlert v-if="revokeError" :error="revokeError" class="mb-3" />
    <v-progress-linear v-if="!data && !error" indeterminate />
    <template v-if="data">
      <!-- FP36-F-03a, F-14: not selectable for this cluster -->
      <v-alert
        v-if="data.unsupported"
        type="info"
        variant="tonal"
        class="mb-3"
        data-testid="namespaces-unsupported"
        >{{ t('namespaces.unsupported', { reason: data.unsupported }) }}</v-alert
      >
      <v-alert v-if="data.unreachable" type="warning" variant="tonal" class="mb-3">{{
        t('namespaces.unreachable', { reason: data.unreachable })
      }}</v-alert>
      <v-alert v-if="!data.namespaces.length && !data.unsupported" type="info" variant="tonal">{{
        t('namespaces.none')
      }}</v-alert>

      <v-card
        v-for="n in data.namespaces"
        :key="n.name"
        border
        class="mb-4"
        :data-testid="`namespace-${n.name}`"
      >
        <v-card-item>
          <v-card-title class="d-flex align-center flex-wrap ga-2">
            {{ n.name }}
            <v-chip size="small" variant="tonal" :color="state(n).color">{{
              state(n).text
            }}</v-chip>
            <v-chip v-if="n.spec" size="small" variant="outlined">{{
              t(`namespaces.profiles.${n.spec.profile}`)
            }}</v-chip>
          </v-card-title>
          <template v-if="canManage" #append>
            <v-btn
              v-if="n.drift.length"
              size="small"
              variant="tonal"
              color="warning"
              prepend-icon="mdi-restore"
              class="mr-2"
              :data-testid="`restore-namespace-${n.name}`"
              @click="
                restoring = n;
                restoreOpen = true;
              "
              >{{ t('namespaces.restore') }}</v-btn
            >
            <template v-if="n.spec">
              <v-btn
                icon="mdi-pencil"
                size="small"
                variant="text"
                :aria-label="t('common.edit')"
                :data-testid="`edit-namespace-${n.name}`"
                @click="openForm(n)"
              />
              <v-btn
                size="small"
                variant="text"
                color="error"
                prepend-icon="mdi-account-cancel"
                :data-testid="`end-namespace-${n.name}`"
                @click="openConfirm(n, 'end')"
                >{{ t('namespaces.endAccess') }}</v-btn
              >
            </template>
            <template v-else>
              <v-btn
                v-if="!data.unsupported"
                size="small"
                variant="text"
                prepend-icon="mdi-account-plus"
                :data-testid="`take-over-namespace-${n.name}`"
                @click="openForm(n)"
                >{{ t('namespaces.takeOver') }}</v-btn
              >
              <v-btn
                size="small"
                variant="text"
                color="error"
                prepend-icon="mdi-delete"
                :data-testid="`delete-namespace-${n.name}`"
                @click="openConfirm(n, 'delete')"
                >{{ t('namespaces.delete') }}</v-btn
              >
            </template>
          </template>
        </v-card-item>
        <v-card-text>
          <v-alert v-if="n.leftOver" type="info" variant="tonal" density="compact" class="mb-3">{{
            t('namespaces.leftOverText')
          }}</v-alert>
          <v-alert
            v-if="n.addon?.message"
            type="info"
            variant="tonal"
            density="compact"
            class="mb-3"
            >{{ n.addon.message }}</v-alert
          >
          <v-alert
            v-if="n.drift.length"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-3"
            :data-testid="`drift-${n.name}`"
          >
            <div v-for="d in n.drift" :key="d.kind + d.name">
              {{ d.kind }} {{ d.name }}:
              {{ d.missing ? t('namespaces.missing') : d.fields.join(', ') }}
            </div>
          </v-alert>

          <template v-if="n.quota.length">
            <div class="text-title-small mb-1">{{ t('namespaces.usage') }}</div>
            <div class="mb-4">
              <v-chip
                v-for="q in n.quota"
                :key="q.resource"
                size="small"
                variant="outlined"
                class="mr-1 mb-1"
                >{{ quotaLabel(q.resource) }}: {{ q.used }} / {{ q.hard }}</v-chip
              >
            </div>
          </template>

          <template v-if="n.accounts.length">
            <div class="text-title-small mb-1">{{ t('namespaces.accounts') }}</div>
            <v-table density="compact" class="mb-4">
              <tbody>
                <tr v-for="a in n.accounts" :key="a.name">
                  <td class="font-weight-medium">{{ a.name }}</td>
                  <td>{{ t(`namespaces.roles.${a.role}`) }}</td>
                  <td class="text-right">
                    <v-btn
                      v-if="canManage"
                      size="small"
                      variant="tonal"
                      prepend-icon="mdi-key-plus"
                      :disabled="!a.exists"
                      :data-testid="`issue-${n.name}-${a.name}`"
                      @click="openToken(n.name, a)"
                      >{{ t('namespaces.getAccess') }}</v-btn
                    >
                  </td>
                </tr>
              </tbody>
            </v-table>
          </template>

          <template v-if="n.tokens.length">
            <div class="text-title-small mb-1">{{ t('namespaces.tokens') }}</div>
            <v-table density="compact">
              <thead>
                <tr>
                  <th>{{ t('namespaces.account') }}</th>
                  <th>{{ t('namespaces.createdBy') }}</th>
                  <th>{{ t('namespaces.created') }}</th>
                  <th>{{ t('namespaces.expires') }}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr v-for="k in n.tokens" :key="k.id" :data-testid="`token-${k.id}`">
                  <td>{{ k.account }}</td>
                  <td>{{ k.createdBy ?? '–' }}</td>
                  <td class="text-no-wrap">{{ date(k.createdAt) }}</td>
                  <td class="text-no-wrap">
                    {{ date(k.expiresAt) }}
                    <v-chip v-if="k.expired" size="x-small" variant="tonal" class="ml-1">{{
                      t('namespaces.expired')
                    }}</v-chip>
                  </td>
                  <td class="text-right">
                    <v-btn
                      v-if="canManage"
                      size="small"
                      variant="text"
                      color="error"
                      :data-testid="`revoke-${k.id}`"
                      @click="revoke(n.name, k)"
                      >{{ t('namespaces.revoke') }}</v-btn
                    >
                  </td>
                </tr>
              </tbody>
            </v-table>
            <p class="text-body-small text-medium-emphasis mt-1">
              {{ t('namespaces.revokeHint') }}
            </p>
          </template>
        </v-card-text>
      </v-card>
    </template>

    <NamespaceDialog
      v-model="editOpen"
      :cluster="cluster"
      :initial="editing?.spec"
      :take-over-name="editing && !editing.spec ? editing.name : undefined"
      @applied="load"
    />
    <ChangeDialog
      v-if="restoring?.spec"
      v-model="restoreOpen"
      :title="t('namespaces.restoreTitle', { name: restoring.name })"
      :valid="true"
      :preview="() => store.preview(cluster, { spec: restored() })"
      :apply="(takeOver) => store.apply(cluster, { spec: restored(), takeOver })"
      @applied="load"
    >
      <p class="text-body-medium">{{ t('namespaces.restoreText') }}</p>
    </ChangeDialog>
    <TokenDialog
      v-if="tokenFor"
      v-model="tokenOpen"
      :cluster="cluster"
      :namespace="tokenFor.namespace"
      :account="tokenFor.account"
      @issued="load"
    />
    <ConfirmNamespaceDialog
      v-if="confirming"
      v-model="confirmOpen"
      :name="confirming.view.name"
      :title="
        t(confirming.kind === 'end' ? 'namespaces.endTitle' : 'namespaces.deleteTitle', {
          name: confirming.view.name,
        })
      "
      :text="t(confirming.kind === 'end' ? 'namespaces.endText' : 'namespaces.deleteText')"
      :confirm-label="t(confirming.kind === 'end' ? 'namespaces.endAccess' : 'namespaces.delete')"
      :action="confirmAction"
      @done="load"
    />
  </div>
</template>
