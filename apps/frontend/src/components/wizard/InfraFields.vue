<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { InfraForm, InfraValues, LookupOption } from '@capi-navigator/shared';

/** Infrastructure step of the wizard, rendered from the provider's form description (FP25-F-05). */
const values = defineModel<InfraValues>({ required: true });
const props = defineProps<{
  form: InfraForm;
  lists: Record<string, LookupOption[]>;
  loading?: boolean;
}>();
const { t } = useI18n();

/**
 * Warning of a list entry from the cloud (e.g. a Proxmox template with the guest agent disabled,
 * FP31-F-05), shown in the dropdown and below the field once it is chosen.
 */
const warningOf = (o: LookupOption | string | number | undefined) =>
  typeof o === 'object' && typeof o.details?.warning === 'string' ? o.details.warning : undefined;
const chosenWarning = (f: InfraForm['fields'][number]) =>
  f.lookup
    ? warningOf((props.lists[f.lookup] ?? []).find((o) => o.value === values.value[f.path]))
    : undefined;
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
      >
        <template #item="{ props: itemProps, internalItem: item }">
          <v-list-item
            v-bind="itemProps"
            :subtitle="warningOf(item.raw)"
            :prepend-icon="warningOf(item.raw) ? 'mdi-alert' : undefined"
            :base-color="warningOf(item.raw) ? 'warning' : undefined"
          />
        </template>
      </v-autocomplete>
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
      <v-alert
        v-if="chosenWarning(f)"
        type="warning"
        variant="tonal"
        density="compact"
        class="mt-2"
        data-testid="lookup-warning"
        >{{ chosenWarning(f) }}</v-alert
      >
    </v-col>
    <v-col v-for="n in form.notes ?? []" :key="n" cols="12">
      <v-alert type="info" variant="tonal" density="compact">{{ t(n) }}</v-alert>
    </v-col>
  </v-row>
</template>
