<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTheme } from 'vuetify';
import type * as Monaco from 'monaco-editor/editor/editor.api';

/**
 * Editor for Helm values (FP8-F-06). The only editable YAML in the app: values are an input of
 * the HelmChartProxy, not a manifest (manifests stay read-only, hard rule 4).
 */
const props = withDefaults(defineProps<{ height?: string; label?: string }>(), {
  height: '320px',
  label: undefined,
});
const model = defineModel<string>({ required: true });
const { t } = useI18n();
const theme = useTheme();
const container = ref<HTMLElement | null>(null);
const editor = shallowRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
const failed = ref(false);

const monacoTheme = () => (theme.global.current.value.dark ? 'vs-dark' : 'vs');

onMounted(async () => {
  try {
    const { monaco } = await import('../../monaco/setup.js');
    if (!container.value) return;
    editor.value = monaco.editor.create(container.value, {
      value: model.value,
      language: 'yaml',
      theme: monacoTheme(),
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
      insertSpaces: true,
    });
    editor.value.onDidChangeModelContent(() => {
      model.value = editor.value!.getValue();
    });
  } catch {
    failed.value = true; // fall back to a textarea
  }
});

watch(model, (value) => {
  if (editor.value && editor.value.getValue() !== value) editor.value.setValue(value);
});
watch(
  () => theme.global.current.value.dark,
  async () => {
    if (!editor.value) return;
    const { monaco } = await import('../../monaco/setup.js');
    monaco.editor.setTheme(monacoTheme());
  },
);

onBeforeUnmount(() => editor.value?.dispose());
</script>

<template>
  <v-textarea
    v-if="failed"
    v-model="model"
    :label="props.label"
    rows="12"
    class="mono"
    data-testid="values-editor"
  />
  <div
    v-else
    ref="container"
    class="editor"
    :style="{ height: props.height }"
    data-testid="values-editor"
    :aria-label="props.label ?? t('addons.values')"
  />
</template>

<style scoped>
.editor {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
}
.mono :deep(textarea) {
  font-family: ui-monospace, monospace;
  font-size: 13px;
}
</style>
