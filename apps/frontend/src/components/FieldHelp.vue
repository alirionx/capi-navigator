<script setup lang="ts">
import { useI18n } from 'vue-i18n';

// Help text of a form field (with its default and, for learn mode, the CAPI field it maps to,
// POS-04) behind an info icon instead of a permanent hint under the field; hover, focus or click
// shows it, so forms stay compact and fields line up.
defineOptions({ inheritAttrs: false });
defineProps<{ text: string }>();
const { t } = useI18n();
</script>

<template>
  <v-tooltip location="top" max-width="420" open-on-click>
    <template #activator="{ props: activator }">
      <v-icon
        v-bind="{ ...activator, ...$attrs }"
        icon="mdi-information-outline"
        size="small"
        class="field-help ms-1"
        tabindex="0"
        role="button"
        :aria-label="`${t('common.help')}: ${text}`"
        data-testid="field-help"
        @mousedown.stop
        @click.stop.prevent
      />
    </template>
    <span class="field-help__text">{{ text }}</span>
  </v-tooltip>
</template>

<style scoped>
.field-help {
  opacity: 0.6;
  cursor: help;
}
.field-help:hover,
.field-help:focus-visible {
  opacity: 1;
}
.field-help__text {
  white-space: pre-line;
}
</style>
