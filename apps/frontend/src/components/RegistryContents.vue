<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RegistryContentsView } from '@capi-navigator/shared';

/**
 * FP29-F-17: what the internal registry must hold for an air-gapped cluster, as a short guide
 * with the commands that copy it from the upstream sources. Needed when the registry has no pull
 * through cache, or to fill it before the cluster is created.
 */
const props = defineProps<{ contents: RegistryContentsView }>();
const { t } = useI18n();
const copied = ref<string | null>(null);
const host = computed(
  () =>
    props.contents.artifacts[0]?.reference.split('/')[0] ??
    props.contents.images.find((i) => i.target)?.target?.split('/')[0] ??
    '',
);
const unmirrored = computed(() => props.contents.images.filter((i) => !i.target));
const showList = ref(false);

async function copy(text: string): Promise<void> {
  await navigator.clipboard?.writeText(text);
  copied.value = text;
}
</script>

<template>
  <div data-testid="registry-contents">
    <p class="text-body-medium mb-3">{{ t('registryContents.intro') }}</p>
    <v-alert
      v-if="contents.unknown.length"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-3"
      >{{ t('registryContents.unknown', { names: contents.unknown.join(', ') }) }}</v-alert
    >
    <v-alert
      v-if="unmirrored.length"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-3"
      data-testid="registry-unmirrored"
    >
      {{ t('registryContents.unmirrored') }}
      <ul class="ml-4 mt-1">
        <li v-for="i in unmirrored" :key="i.source" class="mono">{{ i.source }}</li>
      </ul>
    </v-alert>
    <ol class="steps">
      <li>
        {{ t('registryContents.login') }}
        <pre class="command">
oras login {{ host }}
skopeo login {{ host }}</pre>
      </li>
      <li>
        {{ t('registryContents.binaries') }}
        <div v-for="a in contents.artifacts" :key="a.reference" class="mt-2">
          <div class="d-flex align-center">
            <span class="mono">{{ a.reference }}</span>
            <v-spacer />
            <v-btn
              size="small"
              variant="text"
              :prepend-icon="copied === a.commands ? 'mdi-check' : 'mdi-content-copy'"
              @click="copy(a.commands)"
              >{{ t('common.copy') }}</v-btn
            >
          </div>
          <pre class="command">{{ a.commands }}</pre>
        </div>
      </li>
      <li>
        <div class="d-flex align-center">
          <span>{{
            t('registryContents.images', { n: contents.images.length - unmirrored.length })
          }}</span>
          <v-spacer />
          <v-btn
            size="small"
            variant="text"
            :prepend-icon="copied === contents.imageCommands ? 'mdi-check' : 'mdi-content-copy'"
            data-testid="copy-image-commands"
            @click="copy(contents.imageCommands)"
            >{{ t('common.copy') }}</v-btn
          >
        </div>
        <pre class="command scroll" data-testid="image-commands">{{ contents.imageCommands }}</pre>
        <v-btn size="small" variant="text" class="mt-1 px-0" @click="showList = !showList">{{
          showList ? t('registryContents.hideList') : t('registryContents.showList')
        }}</v-btn>
        <v-table v-if="showList" density="compact" class="mt-1">
          <thead>
            <tr>
              <th>{{ t('registryContents.image') }}</th>
              <th>{{ t('registryContents.usedBy') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in contents.images" :key="i.source">
              <td class="mono">{{ i.source }}</td>
              <td>{{ i.usedBy }}</td>
            </tr>
          </tbody>
        </v-table>
      </li>
      <li>{{ t('registryContents.workloads') }}</li>
    </ol>
  </div>
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
  font-size: 0.8rem;
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
.scroll {
  max-height: 16rem;
  overflow: auto;
}
</style>
