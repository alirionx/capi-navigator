<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  TOKEN_LIFETIME_SECONDS,
  type NamespaceAccount,
  type NamespaceTokenRequest,
  type NamespaceTokenResponse,
} from '@capi-navigator/shared';
import ErrorAlert from '../ErrorAlert.vue';
import YamlViewer from '../YamlViewer.vue';

/**
 * Issues one token (FP36-F-08 to F-10, ADR-0040). The answer stays in this component only and is
 * dropped when the dialog closes.
 */
const props = defineProps<{
  namespace: string;
  account: Pick<NamespaceAccount, 'name' | 'role'>;
  issue: (req: NamespaceTokenRequest) => Promise<NamespaceTokenResponse>;
}>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ issued: [] }>();
const { t } = useI18n();

const HOUR = 3600;
const LIFETIMES = [1, 8, 24, 72, 168].map((h) => ({
  value: h * HOUR,
  title: h < 24 ? t('namespaces.hours', { n: h }, h) : t('namespaces.days', { n: h / 24 }, h / 24),
}));
const lifetime = ref<number>(TOKEN_LIFETIME_SECONDS.default);
const format = ref<'token' | 'kubeconfig'>('kubeconfig');
const result = ref<NamespaceTokenResponse | null>(null);
const error = ref<unknown>(null);
const busy = ref(false);

watch(
  open,
  (o) => {
    result.value = null;
    error.value = null;
    if (o) {
      lifetime.value = TOKEN_LIFETIME_SECONDS.default;
      format.value = 'kubeconfig';
    }
  },
  { immediate: true },
);

async function submit(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    result.value = await props.issue({
      lifetimeSeconds: lifetime.value,
      format: format.value,
    });
    emit('issued');
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" :max-width="result ? 820 : 520" scrollable :persistent="!!result">
    <v-card
      :title="t('namespaces.tokenTitle', { account: account.name, namespace })"
      data-testid="token-dialog"
    >
      <v-card-text>
        <template v-if="!result">
          <p class="text-body-medium mb-3">
            {{ t('namespaces.tokenText', { role: t(`namespaces.roles.${account.role}`) }) }}
          </p>
          <v-select
            v-model="lifetime"
            :items="LIFETIMES"
            :label="t('namespaces.lifetime')"
            :hint="t('namespaces.lifetimeHint')"
            persistent-hint
            data-testid="token-lifetime"
          />
          <v-radio-group v-model="format" class="mt-3" hide-details>
            <v-radio :label="t('namespaces.formatKubeconfig')" value="kubeconfig" />
            <v-radio
              :label="t('namespaces.formatToken')"
              value="token"
              data-testid="token-format-token"
            />
          </v-radio-group>
        </template>
        <template v-else>
          <v-alert type="warning" variant="tonal" density="compact" class="mb-3">
            {{ t('namespaces.tokenOnce', { date: new Date(result.expiresAt).toLocaleString() }) }}
          </v-alert>
          <YamlViewer
            :value="result.content"
            :filename="result.fileName"
            :height="result.format === 'token' ? '160px' : '360px'"
            data-testid="token-content"
          />
        </template>
        <ErrorAlert v-if="error" :error="error" class="mt-3" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn data-testid="token-close" @click="open = false">{{
          result ? t('common.close') : t('common.cancel')
        }}</v-btn>
        <v-btn
          v-if="!result"
          color="primary"
          variant="flat"
          :loading="busy"
          data-testid="token-issue"
          @click="submit"
          >{{ t('namespaces.issue') }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
