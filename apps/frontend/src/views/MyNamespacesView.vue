<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MyNamespace, MyNamespaces } from '@capi-navigator/shared';
import ErrorAlert from '../components/ErrorAlert.vue';
import { quotaKey, withoutUnit } from '../components/namespaces/quota.js';
import TokenDialog from '../components/namespaces/TokenDialog.vue';
import { useMyNamespacesStore } from '../stores/my-namespaces.js';

/** FP37-F-03: the namespaces assigned to the signed-in person, with their own access. */
const { t } = useI18n();
const store = useMyNamespacesStore();

const data = ref<MyNamespaces | null>(null);
const error = ref<unknown>(null);
const REFRESH_MS = 30_000;
async function load(): Promise<void> {
  try {
    data.value = await store.list();
    error.value = null;
  } catch (err) {
    error.value = err;
  }
}
void load();
const timer = setInterval(() => void load(), REFRESH_MS);
onBeforeUnmount(() => clearInterval(timer));

const tokenOpen = ref(false);
const tokenFor = ref<{ entry: MyNamespace; account: MyNamespace['accounts'][number] } | null>(null);
function openToken(entry: MyNamespace, account: MyNamespace['accounts'][number]): void {
  tokenFor.value = { entry, account };
  tokenOpen.value = true;
}
const revokeError = ref<unknown>(null);
async function revoke(entry: MyNamespace, id: string): Promise<void> {
  revokeError.value = null;
  try {
    await store.revokeToken(entry, id);
  } catch (err) {
    revokeError.value = err;
  }
  await load();
}

const key = (n: MyNamespace) =>
  [n.connection, n.clusterNamespace, n.cluster, n.namespace].join('/');
const quotaLabel = (resource: string) => {
  const k = quotaKey(resource);
  return k ? withoutUnit(t(`namespaces.quota.${k}`)) : resource;
};
const date = (value?: string) => (value ? new Date(value).toLocaleString() : '–');
</script>

<template>
  <v-container data-testid="my-namespaces">
    <h1 class="page-title">{{ t('myNamespaces.title') }}</h1>
    <p class="text-body-medium text-medium-emphasis mt-1 mb-6">{{ t('myNamespaces.subtitle') }}</p>

    <ErrorAlert v-if="error" :error="error" class="mb-3" />
    <ErrorAlert v-if="revokeError" :error="revokeError" class="mb-3" />
    <v-progress-linear v-if="!data && !error" indeterminate />
    <template v-if="data">
      <v-alert v-if="data.incomplete" type="warning" variant="tonal" class="mb-3">{{
        t('myNamespaces.incomplete')
      }}</v-alert>
      <v-alert
        v-if="!data.namespaces.length"
        type="info"
        variant="tonal"
        data-testid="my-namespaces-none"
        >{{ t('myNamespaces.none') }}</v-alert
      >

      <v-card
        v-for="n in data.namespaces"
        :key="key(n)"
        border
        class="mb-4"
        :data-testid="`my-namespace-${n.namespace}`"
      >
        <v-card-item>
          <v-card-title class="d-flex align-center flex-wrap ga-2">
            {{ n.namespace }}
            <v-chip v-if="n.unreachable" size="small" variant="tonal" color="warning">{{
              t('myNamespaces.unreachable')
            }}</v-chip>
            <v-chip v-else-if="!n.ready" size="small" variant="tonal" color="info">{{
              t('namespaces.installing')
            }}</v-chip>
          </v-card-title>
          <v-card-subtitle>{{
            t('myNamespaces.inCluster', { cluster: n.cluster })
          }}</v-card-subtitle>
        </v-card-item>
        <v-card-text>
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

          <div class="text-title-small mb-1">{{ t('namespaces.accounts') }}</div>
          <v-table density="compact" class="mb-4">
            <tbody>
              <tr v-for="a in n.accounts" :key="a.name">
                <td class="font-weight-medium">{{ a.name }}</td>
                <td>{{ t(`namespaces.roles.${a.role}`) }}</td>
                <td class="text-right">
                  <v-btn
                    size="small"
                    variant="tonal"
                    prepend-icon="mdi-key-plus"
                    :disabled="!n.ready || n.unreachable"
                    :data-testid="`my-issue-${n.namespace}-${a.name}`"
                    @click="openToken(n, a)"
                    >{{ t('namespaces.getAccess') }}</v-btn
                  >
                </td>
              </tr>
            </tbody>
          </v-table>

          <template v-if="n.tokens.length">
            <div class="text-title-small mb-1">{{ t('myNamespaces.tokens') }}</div>
            <v-table density="compact">
              <thead>
                <tr>
                  <th>{{ t('namespaces.account') }}</th>
                  <th>{{ t('namespaces.created') }}</th>
                  <th>{{ t('namespaces.expires') }}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr v-for="k in n.tokens" :key="k.id" :data-testid="`my-token-${k.id}`">
                  <td>{{ k.account }}</td>
                  <td class="text-no-wrap">{{ date(k.createdAt) }}</td>
                  <td class="text-no-wrap">
                    {{ date(k.expiresAt) }}
                    <v-chip v-if="k.expired" size="x-small" variant="tonal" class="ml-1">{{
                      t('namespaces.expired')
                    }}</v-chip>
                  </td>
                  <td class="text-right">
                    <v-btn
                      size="small"
                      variant="text"
                      color="error"
                      :data-testid="`my-revoke-${k.id}`"
                      @click="revoke(n, k.id)"
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

    <TokenDialog
      v-if="tokenFor"
      v-model="tokenOpen"
      :namespace="tokenFor.entry.namespace"
      :account="tokenFor.account"
      :issue="(req) => store.issueToken(tokenFor!.entry, tokenFor!.account.name, req)"
      @issued="load"
    />
  </v-container>
</template>
