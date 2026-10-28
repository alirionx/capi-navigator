<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MissingArtifact } from '@capi-navigator/shared';

/**
 * FP29-F-12: Kubernetes binaries the internal registry lacks, as a short guide: log in with oras,
 * run the commands (download from the upstream release, push), allow anonymous pulls, check again.
 */
const props = defineProps<{ artifacts: MissingArtifact[]; retry?: () => void }>();
const { t } = useI18n();
const copied = ref<string | null>(null);
const host = computed(() => props.artifacts[0]?.reference.split('/')[0] ?? '');

async function copy(text: string): Promise<void> {
  await navigator.clipboard?.writeText(text);
  copied.value = text;
}
</script>

<template>
  <v-card border data-testid="missing-artifacts">
    <v-card-item>
      <v-card-title class="text-subtitle-1">{{ t('missingArtifacts.title') }}</v-card-title>
      <v-card-subtitle class="text-wrap">{{ t('missingArtifacts.subtitle') }}</v-card-subtitle>
    </v-card-item>
    <v-card-text>
      <ol class="steps">
        <li>
          {{ t('missingArtifacts.login') }}
          <pre class="command">oras login {{ host }}</pre>
        </li>
        <li>
          {{ t('missingArtifacts.push') }}
          <div v-for="a in artifacts" :key="a.reference" class="mt-2">
            <div class="d-flex align-center">
              <span class="mono">{{ a.reference }}</span>
              <v-spacer />
              <v-btn
                size="small"
                variant="text"
                :prepend-icon="copied === a.commands ? 'mdi-check' : 'mdi-content-copy'"
                data-testid="copy-push-commands"
                @click="copy(a.commands)"
                >{{ t('common.copy') }}</v-btn
              >
            </div>
            <pre class="command" data-testid="push-commands">{{ a.commands }}</pre>
          </div>
        </li>
        <li>{{ t('missingArtifacts.anonymous') }}</li>
        <li>
          {{ t('missingArtifacts.again') }}
          <v-btn
            v-if="retry"
            size="small"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-refresh"
            class="ml-2"
            data-testid="check-artifacts-again"
            @click="retry()"
            >{{ t('missingArtifacts.checkAgain') }}</v-btn
          >
        </li>
      </ol>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.steps {
  padding-left: 1.25rem;
}
.steps li {
  margin-bottom: 0.75rem;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  word-break: break-all;
}
.command {
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  padding: 6px 8px;
  border-radius: 4px;
  margin-top: 4px;
}
</style>
