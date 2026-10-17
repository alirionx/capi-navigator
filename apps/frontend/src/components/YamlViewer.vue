<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTheme } from 'vuetify';
import type * as Monaco from 'monaco-editor/editor/editor.api';

/**
 * Read-only YAML view with syntax highlighting (Monaco), copy and download (NF-07, FP7-F-05).
 * Editing is not possible: YAML is read-only in CAPI Navigator (hard rule 4).
 */
const props = withDefaults(
  defineProps<{
    value: string;
    height?: string;
    filename?: string;
    /** Hide the local download, e.g. when the download must go through an audited endpoint. */
    noDownload?: boolean;
  }>(),
  {
    height: '360px',
    filename: 'manifest.yaml',
    noDownload: false,
  },
);
const { t } = useI18n();
const theme = useTheme();
const container = ref<HTMLElement | null>(null);
const editor = shallowRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
const failed = ref(false);
const copied = ref(false);

const monacoTheme = () => (theme.global.current.value.dark ? 'vs-dark' : 'vs');

onMounted(async () => {
  try {
    const { monaco } = await import('../monaco/setup.js');
    if (!container.value) return;
    editor.value = monaco.editor.create(container.value, {
      value: props.value,
      language: 'yaml',
      readOnly: true,
      domReadOnly: true,
      theme: monacoTheme(),
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      fontSize: 13,
      renderWhitespace: 'none',
      tabSize: 2,
    });
  } catch {
    failed.value = true; // fall back to a plain <pre>
  }
});

watch(
  () => props.value,
  (value) => {
    if (editor.value && editor.value.getValue() !== value) editor.value.setValue(value);
  },
);
watch(
  () => theme.global.current.value.dark,
  async () => {
    if (!editor.value) return;
    const { monaco } = await import('../monaco/setup.js');
    monaco.editor.setTheme(monacoTheme());
  },
);

onBeforeUnmount(() => editor.value?.dispose());

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(props.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

function download(): void {
  const url = URL.createObjectURL(new Blob([props.value], { type: 'application/yaml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = props.filename;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="yaml-viewer">
    <div class="d-flex justify-end ga-1 mb-1">
      <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copy">
        {{ copied ? t('yaml.copied') : t('yaml.copy') }}
      </v-btn>
      <slot name="actions" />
      <v-btn
        v-if="!noDownload"
        size="small"
        variant="text"
        prepend-icon="mdi-download"
        @click="download"
      >
        {{ t('yaml.download') }}
      </v-btn>
    </div>
    <pre v-if="failed" class="fallback" :style="{ height }">{{ value }}</pre>
    <div
      v-else
      ref="container"
      class="editor"
      :style="{ height }"
      data-testid="yaml-viewer"
      :aria-label="t('yaml.label')"
    />
  </div>
</template>

<style scoped>
.editor,
.fallback {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
}
.fallback {
  overflow: auto;
  padding: 8px;
  font-size: 13px;
}
</style>
