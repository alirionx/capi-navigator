<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

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
const { t } = useI18n();

const lines = (key: 'preCommands' | 'postCommands') =>
  computed({
    get: () => model.value[key].join('\n'),
    set: (v: string) => (model.value[key] = v.split('\n').filter((l) => l.trim())),
  });
const pre = lines('preCommands');
const post = lines('postCommands');

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
    <div class="text-subtitle-2 mb-1">{{ t('wizard.custom.files') }}</div>
    <div v-for="(f, i) in model.files" :key="i" class="d-flex flex-wrap ga-2 align-start mb-2">
      <v-text-field
        v-model="f.path"
        :label="t('wizard.custom.path')"
        placeholder="/etc/example.conf"
        density="compact"
        style="min-width: 220px"
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
      <v-textarea
        v-else
        v-model="f.content"
        :label="t('wizard.custom.content')"
        rows="2"
        auto-grow
        density="compact"
        style="min-width: 260px"
      />
      <v-btn icon="mdi-close" variant="text" size="small" @click="model.files.splice(i, 1)" />
    </div>
    <v-btn size="small" variant="text" prepend-icon="mdi-file-plus" @click="addFile(false)">{{
      t('wizard.custom.addFile')
    }}</v-btn>
    <v-btn size="small" variant="text" prepend-icon="mdi-key-plus" @click="addFile(true)">{{
      t('wizard.custom.addSecretFile')
    }}</v-btn>

    <v-textarea
      v-model="pre"
      :label="t('wizard.custom.pre')"
      :hint="t('wizard.custom.preHint')"
      persistent-hint
      rows="2"
      auto-grow
      class="mt-3 font-monospace"
    />
    <v-textarea
      v-model="post"
      :label="t('wizard.custom.post')"
      :hint="t('wizard.custom.postHint')"
      persistent-hint
      rows="2"
      auto-grow
      class="mt-3 font-monospace"
    />
  </div>
</template>
