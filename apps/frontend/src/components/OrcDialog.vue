<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ORC_FOR_CAPO, type ManifestPreview } from '@capi-navigator/shared';
import { useOperatorStore } from '../stores/operator.js';
import ErrorAlert from './ErrorAlert.vue';
import YamlViewer from './YamlViewer.vue';

/** Install or upgrade ORC from its release manifest, with preview (FP3-F-04a). */
const props = defineProps<{ installedVersion?: string }>();
const emit = defineEmits<{ close: []; done: [] }>();
const { t } = useI18n();
const store = useOperatorStore();

const compat = Object.entries(ORC_FOR_CAPO);
const recommended = compat[0]![1];
const version = ref(recommended);
const versions = ref<string[]>([recommended]);
const preview = ref<ManifestPreview | null>(null);
const busy = ref(false);
const error = ref<unknown>(null);

onMounted(async () => {
  try {
    versions.value = (await store.orcReleases()).versions;
  } catch {
    // keep the catalog version
  }
});

async function showPreview(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    preview.value = await store.previewOrc(version.value);
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}

async function install(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await store.installOrc(version.value);
    emit('done');
  } catch (err) {
    error.value = err;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-card>
    <v-card-title class="pt-4 px-6">
      {{ props.installedVersion ? t('orc.upgradeTitle') : t('orc.installTitle') }}
    </v-card-title>
    <v-card-text>
      <p class="mb-3">{{ t('orc.intro') }}</p>
      <v-table density="compact" class="mb-3">
        <thead>
          <tr>
            <th>{{ t('orc.capoVersion') }}</th>
            <th>{{ t('orc.orcVersion') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="[capo, orc] in compat" :key="capo">
            <td>{{ capo }}.x</td>
            <td>{{ orc }}</td>
          </tr>
        </tbody>
      </v-table>
      <v-select
        v-model="version"
        :items="versions"
        :label="t('orc.version')"
        :hint="t('orc.versionHint', { version: recommended })"
        persistent-hint
        :disabled="!!preview"
        class="mb-3"
        data-testid="orc-version"
      />
      <template v-if="preview">
        <p class="mb-2">{{ t('orc.previewText', { n: preview.objects.length }) }}</p>
        <v-alert
          v-for="w in preview.warnings"
          :key="w"
          type="warning"
          variant="tonal"
          density="compact"
          class="mb-2"
        >
          {{ w }}
        </v-alert>
        <YamlViewer :value="preview.yaml" height="320px" :filename="`orc-${version}.yaml`" />
      </template>
      <ErrorAlert v-if="error" :error="error" class="mt-3" />
    </v-card-text>
    <v-card-actions class="px-6 pb-4">
      <v-btn v-if="preview" variant="text" prepend-icon="mdi-arrow-left" @click="preview = null">
        {{ t('common.back') }}
      </v-btn>
      <v-spacer />
      <v-btn variant="text" @click="emit('close')">{{ t('common.cancel') }}</v-btn>
      <v-btn
        v-if="!preview"
        color="primary"
        variant="flat"
        :loading="busy"
        data-testid="orc-preview"
        @click="showPreview"
      >
        {{ t('providers.showPreview') }}
      </v-btn>
      <v-btn
        v-else
        color="primary"
        variant="flat"
        :loading="busy"
        data-testid="orc-apply"
        @click="install"
      >
        {{ t('orc.apply') }}
      </v-btn>
    </v-card-actions>
  </v-card>
</template>
