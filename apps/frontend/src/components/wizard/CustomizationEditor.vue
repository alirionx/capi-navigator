<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { FLAVOR_PLUGINS, type KubernetesFlavor } from '@capi-navigator/shared';
import FieldHelp from '../FieldHelp.vue';
import ValuesEditor from '../addons/ValuesEditor.vue';
import { editorLanguage } from './editor-language.js';

/** Files and pre/post commands of one group (FP5-F-13). Runs as root on the nodes. */
interface FileEntry {
  path: string;
  content?: string;
  contentFromSecret?: { name: string; key: string };
  permissions?: string;
}
interface Customization {
  files: FileEntry[];
  preCommands: string[];
  postCommands: string[];
}
const model = defineModel<Customization>({ required: true });
const props = withDefaults(defineProps<{ flavor?: KubernetesFlavor }>(), { flavor: 'rke2' });
const fields = computed(
  () =>
    FLAVOR_PLUGINS[props.flavor]?.customizationFields ?? {
      preCommands: 'preCommands',
      postCommands: 'postCommands',
    },
);
const { t } = useI18n();

/**
 * The commands as text of the editor. The model keeps them as a list without empty lines; the text
 * is only replaced when the list changes from outside, so typing a new line keeps the cursor.
 */
function commandText(key: 'preCommands' | 'postCommands') {
  const text = ref(model.value[key].join('\n'));
  const toList = (v: string) => v.split('\n').filter((l) => l.trim());
  watch(text, (v) => (model.value[key] = toList(v)));
  watch(
    () => model.value[key],
    (list) => {
      if (JSON.stringify(toList(text.value)) !== JSON.stringify(list)) text.value = list.join('\n');
    },
    { deep: true },
  );
  return text;
}
const pre = commandText('preCommands');
const post = commandText('postCommands');

function addFile(fromSecret: boolean): void {
  model.value.files.push(
    fromSecret
      ? { path: '', contentFromSecret: { name: '', key: '' }, permissions: '0600' }
      : { path: '', content: '', permissions: '0644' },
  );
}
</script>

<template>
  <div>
    <div class="text-title-small mb-1">{{ t('wizard.custom.files') }}</div>
    <div v-for="(f, i) in model.files" :key="i" class="mb-4">
      <div class="d-flex flex-wrap ga-2 align-start">
        <v-text-field
          v-model="f.path"
          :label="t('wizard.custom.path')"
          placeholder="/etc/example.conf"
          density="compact"
          style="min-width: 220px"
          :data-testid="`custom-file-path-${i}`"
        />
        <v-text-field
          v-model="f.permissions"
          :label="t('wizard.custom.permissions')"
          density="compact"
          style="max-width: 120px"
        />
        <template v-if="f.contentFromSecret">
          <v-text-field
            v-model="f.contentFromSecret.name"
            :label="t('wizard.custom.secretName')"
            density="compact"
          />
          <v-text-field
            v-model="f.contentFromSecret.key"
            :label="t('wizard.custom.secretKey')"
            density="compact"
          />
        </template>
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          :aria-label="t('common.delete')"
          @click="model.files.splice(i, 1)"
        />
      </div>
      <template v-if="!f.contentFromSecret">
        <div class="text-body-small text-medium-emphasis mb-1">
          {{ t('wizard.custom.content') }}
        </div>
        <ValuesEditor
          :model-value="f.content ?? ''"
          :language="editorLanguage(f.path)"
          :label="t('wizard.custom.content')"
          height="160px"
          :data-testid="`custom-file-content-${i}`"
          @update:model-value="(v: string) => (f.content = v)"
        />
      </template>
    </div>
    <v-btn size="small" variant="text" prepend-icon="mdi-file-plus" @click="addFile(false)">{{
      t('wizard.custom.addFile')
    }}</v-btn>
    <v-btn size="small" variant="text" prepend-icon="mdi-key-plus" @click="addFile(true)">{{
      t('wizard.custom.addSecretFile')
    }}</v-btn>

    <div class="text-body-small text-medium-emphasis mt-4 mb-1">
      {{ t('wizard.custom.pre') }}
      <FieldHelp :text="t('wizard.custom.preHint', { field: fields.preCommands })" />
    </div>
    <ValuesEditor
      v-model="pre"
      language="shell"
      :label="t('wizard.custom.pre')"
      height="120px"
      data-testid="custom-pre"
    />
    <div class="text-body-small text-medium-emphasis mt-4 mb-1">
      {{ t('wizard.custom.post') }}
      <FieldHelp :text="t('wizard.custom.postHint', { field: fields.postCommands })" />
    </div>
    <ValuesEditor
      v-model="post"
      language="shell"
      :label="t('wizard.custom.post')"
      height="120px"
      data-testid="custom-post"
    />
  </div>
</template>
