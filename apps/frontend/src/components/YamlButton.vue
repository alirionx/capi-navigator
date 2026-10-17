<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ResourceRef } from '@capi-navigator/shared';
import { useYamlViewStore } from '../stores/yaml-view.js';

/** "View YAML" for one resource (FP7-F-01); visible to every role. */
const props = defineProps<{ target: ResourceRef; label?: boolean }>();
const { t } = useI18n();
const store = useYamlViewStore();
</script>

<template>
  <v-btn
    v-if="label"
    size="small"
    variant="text"
    prepend-icon="mdi-code-braces"
    :data-testid="`yaml-${props.target.kind}-${props.target.name}`"
    @click.stop="store.show(props.target)"
    >{{ t('yamlView.view') }}</v-btn
  >
  <v-btn
    v-else
    icon="mdi-code-braces"
    size="small"
    variant="text"
    :title="t('yamlView.view')"
    :aria-label="t('yamlView.view')"
    :data-testid="`yaml-${props.target.kind}-${props.target.name}`"
    @click.stop="store.show(props.target)"
  />
</template>
