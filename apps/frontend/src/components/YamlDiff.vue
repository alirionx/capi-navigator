<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTheme } from 'vuetify';
import type * as Monaco from 'monaco-editor/editor/editor.api';

/** Read-only side-by-side YAML diff (Monaco diff editor) for change previews (hard rule 6). */
const props = withDefaults(defineProps<{ before: string; after: string; height?: string }>(), {
  height: '320px',
});
const { t } = useI18n();
const theme = useTheme();
const container = ref<HTMLElement | null>(null);
const editor = shallowRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
const failed = ref(false);
let models: Monaco.editor.ITextModel[] = [];

const monacoTheme = () => (theme.global.current.value.dark ? 'vs-dark' : 'vs');

async function setModels(): Promise<void> {
  const { monaco } = await import('../monaco/setup.js');
  if (!editor.value) return;
  const original = monaco.editor.createModel(props.before, 'yaml');
  const modified = monaco.editor.createModel(props.after, 'yaml');
  editor.value.setModel({ original, modified });
  models.forEach((m) => m.dispose());
  models = [original, modified];
}

onMounted(async () => {
  try {
    const { monaco } = await import('../monaco/setup.js');
    if (!container.value) return;
    editor.value = monaco.editor.createDiffEditor(container.value, {
      readOnly: true,
      originalEditable: false,
      domReadOnly: true,
      theme: monacoTheme(),
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      renderSideBySide: true,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
    });
    await setModels();
  } catch {
    failed.value = true;
  }
});

watch(() => [props.before, props.after], setModels);
watch(
  () => theme.global.current.value.dark,
  async () => {
    const { monaco } = await import('../monaco/setup.js');
    monaco.editor.setTheme(monacoTheme());
  },
);
onBeforeUnmount(() => {
  editor.value?.dispose();
  models.forEach((m) => m.dispose());
});
</script>

<template>
  <div v-if="failed" class="d-flex ga-2">
    <pre class="fallback" :style="{ height }">{{ before }}</pre>
    <pre class="fallback" :style="{ height }">{{ after }}</pre>
  </div>
  <div
    v-else
    ref="container"
    class="editor"
    :style="{ height }"
    :aria-label="t('changes.diffLabel')"
    data-testid="yaml-diff"
  />
</template>

<style scoped>
.editor,
.fallback {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
}
.fallback {
  flex: 1;
  overflow: auto;
  padding: 8px;
  font-size: 13px;
}
</style>
