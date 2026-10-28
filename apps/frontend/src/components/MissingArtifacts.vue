<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MissingArtifact } from '@capi-navigator/shared';

/**
 * FP29-F-12: artifacts the internal registry lacks, each with the commands that download it from
 * the upstream release and push it, to run on a machine with internet access and oras.
 */
defineProps<{ artifacts: MissingArtifact[] }>();
const { t } = useI18n();
const copied = ref<string | null>(null);

async function copy(a: MissingArtifact): Promise<void> {
  await navigator.clipboard?.writeText(a.commands);
  copied.value = a.reference;
}
</script>

<template>
  <v-card border data-testid="missing-artifacts">
    <v-card-item>
      <v-card-title class="text-subtitle-1">{{ t('missingArtifacts.title') }}</v-card-title>
      <v-card-subtitle class="text-wrap">{{ t('missingArtifacts.subtitle') }}</v-card-subtitle>
    </v-card-item>
    <v-card-text>
      <div v-for="a in artifacts" :key="a.reference" class="mb-3">
        <div class="d-flex align-center">
          <span class="mono">{{ a.reference }}</span>
          <v-spacer />
          <v-btn
            size="small"
            variant="text"
            :prepend-icon="copied === a.reference ? 'mdi-check' : 'mdi-content-copy'"
            data-testid="copy-push-commands"
            @click="copy(a)"
            >{{ t('common.copy') }}</v-btn
          >
        </div>
        <pre class="command" data-testid="push-commands">{{ a.commands }}</pre>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
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
}
</style>
