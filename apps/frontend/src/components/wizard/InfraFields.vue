<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { InfraForm, InfraValues, LookupOption } from '@capi-navigator/shared';

/** Infrastructure step of the wizard, rendered from the provider's form description (FP25-F-05). */
const values = defineModel<InfraValues>({ required: true });
defineProps<{
  form: InfraForm;
  lists: Record<string, LookupOption[]>;
  loading?: boolean;
}>();
const { t } = useI18n();
</script>

<template>
  <v-row>
    <v-col v-for="f in form.fields" :key="f.path" cols="12" :md="f.cols ?? 6">
      <v-switch
        v-if="f.kind === 'switch'"
        v-model="values[f.path]"
        color="primary"
        :label="t(f.label)"
        :hint="t(f.hint)"
        persistent-hint
        :data-testid="f.testId"
      />
      <v-autocomplete
        v-else-if="f.kind === 'autocomplete'"
        v-model="values[f.path]"
        :items="f.lookup ? (lists[f.lookup] ?? []) : f.options"
        item-title="label"
        item-value="value"
        :loading="!!f.lookup && loading"
        :clearable="f.clearable"
        :label="t(f.label)"
        :hint="t(f.hint)"
        persistent-hint
        :data-testid="f.testId"
      />
      <v-select
        v-else-if="f.kind === 'select'"
        v-model="values[f.path]"
        :items="f.lookup ? (lists[f.lookup] ?? []) : f.options"
        item-title="label"
        item-value="value"
        :loading="!!f.lookup && loading"
        :clearable="f.clearable"
        :label="t(f.label)"
        :hint="t(f.hint)"
        persistent-hint
        :data-testid="f.testId"
      />
      <v-text-field
        v-else
        v-model="values[f.path]"
        :type="f.kind === 'number' ? 'number' : 'text'"
        :clearable="f.clearable"
        :label="t(f.label)"
        :hint="t(f.hint)"
        persistent-hint
        :data-testid="f.testId"
      />
    </v-col>
    <v-col v-for="n in form.notes ?? []" :key="n" cols="12">
      <v-alert type="info" variant="tonal" density="compact">{{ t(n) }}</v-alert>
    </v-col>
  </v-row>
</template>
